import type { Page, Response } from "playwright";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { gradeRecordSchema, gradeRunSchema, type GradeRun, type GradeStudent } from "@schoolhawk/core/grades";
import type { GradeStore } from "@schoolhawk/storage/grades";
import portalConfig from "../../../config/portals.json";
import { confirmLogin } from "./skyward-login";
import { discoverSkywardStudents, parseBrowseRegistration, withSkywardCollection } from "./skyward";

export const GRADES_URL = portalConfig.portals.skyward.urls.grades;
const BROWSE_PATH = "/lkwash/Grading/StudentSection/GetBrowse";
class GradeUsageError extends Error {}

export function parseGradeOptions(args: string[]): { accountId: string } {
  try {
    const { values } = parseArgs({ args, options: { account: { type: "string" } }, allowPositionals: false });
    if (!values.account || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.account) ||
        args.filter(arg => arg === "--account" || arg.startsWith("--account=")).length !== 1) throw new Error();
    return { accountId: values.account };
  } catch {
    throw new GradeUsageError("Use npm run skyward:grades -- --account <alias>. Grades are snapshots; no day count is required.");
  }
}

export function gradeRequestStudentIds(input: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase() === "studentid" && (typeof nested === "string" || typeof nested === "number") && /^\d+$/.test(String(nested))) {
        ids.add(String(nested));
      } else visit(nested, depth + 1);
    }
  };
  if (input && typeof input === "object") {
    visit(input, 0);
    for (const key of ["queryParameterData", "postData", "dynamicFilterValues"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length <= 100_000) {
        try { visit(JSON.parse(value), 0); } catch {}
      }
    }
  }
  return [...ids];
}

type GradeBrowse = ReturnType<typeof parseBrowseRegistration> & { html: string; studentIds: string[] };

function observeGradeBrowses(page: Page) {
  const results = new Map<string, GradeBrowse>();
  const listeners = new Set<() => void>();
  const onResponse = async (response: Response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(GRADES_URL).origin || url.pathname !== BROWSE_PATH) return;
    try {
      if (!response.ok()) return;
      const payload = z.object({ html: z.string().max(50_000_000), script: z.string().max(20_000_000) }).parse(await response.json());
      const registration = parseBrowseRegistration(payload.script);
      if (!/^StudentGrades-\d+$/.test(registration.browseName)) return;
      results.set(registration.browseName, { ...registration, html: payload.html,
        studentIds: gradeRequestStudentIds(response.request().postDataJSON()) });
      for (const listener of listeners) listener();
    } catch {}
  };
  page.on("response", onResponse);
  return {
    async wait(count: number, timeout: number) {
      if (results.size >= count) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); listeners.delete(check); resolve(); };
        const check = () => { if (results.size >= count) finish(); };
        const timer = setTimeout(finish, timeout);
        listeners.add(check);
        check();
      });
    },
    values() { return [...results.values()]; },
    close() { page.off("response", onResponse); },
  };
}

export async function gradeSnapshot(page: Page, html: string) {
  return page.evaluate(html => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const headers = [...document.querySelectorAll('.unlockedHeaderTableRow > [data-column-index]')].map(element => ({
      label: (element.querySelector(".headerTextContainerDiv") ?? element).textContent?.replace(/\s+/g, " ").trim() ?? "",
      span: (element as HTMLTableCellElement).colSpan,
      termId: element.getAttribute("data-grade-bucket-id"),
    }));
    const rows = [...document.querySelectorAll('tr.browseRow[id*="_unlockedRow"]')].map(row => {
      const course = row.querySelector(".studentGradesClassCell");
      return { studentId: course?.getAttribute("data-studentid") ?? "", studentSectionId: course?.getAttribute("data-studentsectionid") ?? "",
        course: course?.getAttribute("data-coursedescription") ?? "", courseCode: course?.getAttribute("data-coursecode") || null,
        classDetails: course?.querySelector(".fivetoppadding")?.textContent?.replace(/\s+/g, " ").trim() || null,
        cells: [...row.children].map(cell => {
          const link = cell.querySelector(".progressReportBreakdownGradeMarkCode");
          const mark = link?.querySelector(".anchorText");
          const directText = link ? [...link.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim() : "";
          return { span: (cell as HTMLTableCellElement).colSpan, bucketId: cell.getAttribute("data-student-grade-bucket-id"),
            text: cell.textContent?.replace(/\s+/g, " ").trim() ?? "", hasLink: !!link,
            mark: mark?.textContent?.replace(/\s+/g, " ").trim() ?? directText,
            unrecognizedMark: !!link && !mark && !directText && !!link.textContent?.trim() && !link.querySelector("svg"),
            periodStatus: link?.classList.contains("progressReportDetailOpenGrade") ? "open" as const :
              link?.classList.contains("progressReportDetailClosedGrade") ? "closed" as const : "unknown" as const };
        }) };
    });
    return { headers, rows, emptyMarkers: document.querySelectorAll(".noRecordsInBrowse").length };
  }, html);
}

export function parseGradeSnapshot(student: Pick<GradeStudent, "id" | "name" | "firstName" | "lastName">,
  browse: Pick<GradeBrowse, "recordCount" | "rowsPerPageCap">, snapshot: Awaited<ReturnType<typeof gradeSnapshot>>, capturedAt: string): GradeStudent {
  const result: GradeStudent = { ...student, status: "failed", grades: [], periods: [], scannedCount: 0, pages: 1,
    verifiedEmpty: false, warning: "LIST_UNVERIFIED" };
  try {
    if (snapshot.headers.length < 2 || snapshot.headers[0].label !== "Class" || snapshot.headers[1].label !== "Missing Assignments" ||
        snapshot.headers.some(header => header.span !== 1)) throw new Error();
    const periods = snapshot.headers.slice(2);
    if (periods.some(period => !period.label) || new Set(periods.map(period => period.label)).size !== periods.length) throw new Error();
    result.periods = periods.map(period => period.label);
    const courses = new Set<string>();
    const grades = new Set<string>();
    for (const row of snapshot.rows) {
      result.warning = "STUDENT_UNVERIFIED";
      if (row.studentId !== student.id) throw new Error();
      result.warning = "RECORD_INVALID";
      if (!/^\d+$/.test(row.studentSectionId) || !row.course || courses.has(row.studentSectionId) ||
          row.cells.length !== snapshot.headers.length || row.cells.some(cell => cell.span !== 1)) throw new Error();
      courses.add(row.studentSectionId);
      result.scannedCount++;
      for (const [index, cell] of row.cells.slice(2).entries()) {
        if (cell.bucketId === null && !cell.hasLink && !cell.text) continue;
        if (!cell.bucketId || !/^\d+$/.test(cell.bucketId) || !cell.hasLink || cell.unrecognizedMark || grades.has(cell.bucketId)) throw new Error();
        grades.add(cell.bucketId);
        result.grades.push(gradeRecordSchema.parse({
          id: cell.bucketId, studentSectionId: row.studentSectionId, courseCode: row.courseCode, course: row.course,
          classDetails: row.classDetails, section: null, teacher: null, termId: periods[index].termId,
          term: periods[index].label, periodStatus: cell.periodStatus, schoolYear: null,
          grade: cell.mark || null, score: null, maxScore: null, gradingScale: null, effectiveDate: null,
          source: { portal: "skyward", url: GRADES_URL, capturedAt },
        }));
      }
    }
    result.warning = "COVERAGE_UNVERIFIED";
    const expectedRows = snapshot.emptyMarkers === 1 && browse.recordCount === 1 ? 0 : browse.recordCount;
    if (browse.rowsPerPageCap !== null || snapshot.rows.length !== expectedRows ||
        (expectedRows === 0 ? snapshot.emptyMarkers !== 1 : snapshot.emptyMarkers !== 0) ||
        (expectedRows > 0 && !periods.length)) throw new Error();
    result.verifiedEmpty = expectedRows === 0;
    result.status = "complete";
    delete result.warning;
  } catch { result.status = result.grades.length ? "partial" : "failed"; }
  return result;
}

export async function collectGrades(page: Page, now = new Date(), timeout = 15_000): Promise<GradeRun> {
  const run: GradeRun = { runId: randomUUID(), capturedAt: now.toISOString(), parserVersion: 1,
    discoveryComplete: false, status: "failed", students: [] };
  const observer = observeGradeBrowses(page);
  try {
    try { await confirmLogin(page, process.env.SKYWARD_SUCCESS_SELECTOR, timeout); }
    catch { run.status = "auth-required"; run.warning = "AUTH_REQUIRED"; return run; }
    run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    const roster = await discoverSkywardStudents(page, "studentGrades", timeout);
    run.students = [...roster.values()].map(student => ({ ...student, status: "failed", grades: [], periods: [], scannedCount: 0,
      pages: 0, verifiedEmpty: false, warning: "LIST_UNVERIFIED" }));
    run.discoveryComplete = true;
    run.warning = "NAVIGATION_FAILED";
    await page.locator('a[id="-studentGrades_Widget"][data-studentid=""]').click({ timeout });
    await page.waitForURL(url => url.origin === new URL(GRADES_URL).origin && url.pathname === new URL(GRADES_URL).pathname, { timeout });
    await observer.wait(roster.size, timeout);
    const matched = new Set<string>();
    delete run.warning;
    for (const browse of observer.values()) {
      const snapshot = await gradeSnapshot(page, browse.html);
      const ids = new Set([...browse.studentIds, ...snapshot.rows.map(row => row.studentId)]);
      if (ids.size !== 1 || !roster.has([...ids][0]) || matched.has([...ids][0])) {
        run.discoveryComplete = false;
        run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
        continue;
      }
      const id = [...ids][0];
      matched.add(id);
      const student = parseGradeSnapshot(roster.get(id)!, browse, snapshot, new Date().toISOString());
      run.students[run.students.findIndex(candidate => candidate.id === id)] = student;
    }
    run.status = run.discoveryComplete && run.students.every(student => student.status === "complete") ? "complete" :
      run.students.some(student => student.status === "complete" || student.grades.length > 0) ? "partial" : "failed";
  } catch {
    if (await page.locator('input[type="password"]:visible').count().catch(() => 0)) {
      run.status = "auth-required"; run.warning = "AUTH_REQUIRED";
      for (const student of run.students) if (student.status !== "complete") { student.status = "auth-required"; student.warning = "AUTH_REQUIRED"; }
    }
  } finally { observer.close(); }
  return gradeRunSchema.parse(run);
}

export async function collectGradesToStore(page: Page, store: Pick<GradeStore, "importGradeRun">,
  accountId: string, now = new Date(), timeout = 15_000): Promise<GradeRun> {
  const run = await collectGrades(page, now, timeout);
  store.importGradeRun(accountId, run);
  return run;
}

export function gradeSummary(run: GradeRun) {
  return { runId: run.runId, status: run.status, capturedAt: run.capturedAt, discoveryComplete: run.discoveryComplete,
    students: run.students.map((student, index) => ({ student: index + 1, status: student.status,
      coursesScanned: student.scannedCount, gradeRecords: student.grades.length,
      marksPresent: student.grades.filter(grade => grade.grade !== null).length, periods: student.periods.length,
      verifiedEmpty: student.verifiedEmpty, warning: student.warning })), warning: run.warning };
}

async function main(): Promise<void> {
  const { accountId } = parseGradeOptions(process.argv.slice(2));
  const { result, database } = await withSkywardCollection((page, store) => collectGradesToStore(page, store, accountId));
  console.log(JSON.stringify({ ...gradeSummary(result), database }, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof GradeUsageError ? `GRADES: ${error.message} No portal access was attempted.` :
      "GRADES: Collection or storage failed. Check the existing database, original key, private permissions, and session. Renew locally with skyward:login if expired. Private error details withheld.");
    process.exitCode = 1;
  });
}