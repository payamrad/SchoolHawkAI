import type { Page, Request, Response } from "playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { gradeRecordSchema, gradeRunSchema, type GradeRun, type GradeStudent } from "@schoolhawk/core/grades";
import { bindDiagnosticContext, DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
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
  return requestStudentBinding(input).ids;
}

function requestStudentBinding(input: unknown): { ids: string[]; unverified: boolean } {
  const ids = new Set<string>();
  let unverified = false;
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object") return;
    if (depth > 8 || ++visited > 10_000) { unverified = true; return; }
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase() === "studentid") {
        if ((typeof nested === "string" || (typeof nested === "number" && Number.isSafeInteger(nested))) &&
            /^\d{1,300}$/.test(String(nested))) ids.add(String(nested));
        else unverified = true;
      } else visit(nested, depth + 1);
    }
  };
  if (input && typeof input === "object") {
    visit(input, 0);
    for (const key of ["queryParameterData", "postData", "dynamicFilterValues"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string") {
        if (value.length > 100_000) { unverified = true; continue; }
        try { visit(JSON.parse(value), 0); }
        catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          unverified = true;
        }
      }
    }
  }
  return { ids: [...ids], unverified };
}

type GradeBrowse = ReturnType<typeof parseBrowseRegistration> & {
  html: string; studentIds: string[]; requestUnverified: boolean; ordinal: number;
};
type DiagnosticContext = Pick<DiagnosticEvent, "runId" | "parserVersion" | "student">;

function observeGradeBrowses(page: Page, context: DiagnosticContext, responseTimeout: number) {
  const results: GradeBrowse[] = [];
  const requests = new WeakMap<Request, number>();
  const inFlight = new Set<Request>();
  const pending = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  let ordinals = new Map<string, number>();
  let requestCount = 0;
  let unverified = false;
  let fatal: unknown;
  const notify = () => { for (const listener of listeners) listener(); };
  const checkFatal = () => { if (fatal) throw fatal; };
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "grades", ...event });
  const binding = (request: Request, ordinal: number) => {
    try {
      if ((request.postData()?.length ?? 0) > 100_000) throw new Error();
      const result = requestStudentBinding(request.postDataJSON());
      if (result.unverified) report({ code: "BROWSE_RESPONSE_INVALID", record: ordinal, field: "student",
        counts: { requestStudents: result.ids.length }, errorType: "validation" });
      return result;
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      report({ code: "BROWSE_RESPONSE_INVALID", record: ordinal, field: "student", errorType: diagnosticErrorType(error) });
      return { ids: [], unverified: true };
    }
  };
  const onRequest = bindDiagnosticContext((request: Request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(GRADES_URL).origin && url.pathname === BROWSE_PATH) {
      requests.set(request, ++requestCount);
      inFlight.add(request);
      notify();
    }
  });
  const readResponse = async (response: Response, ordinal: number) => {
    const request = binding(response.request(), ordinal);
    const student = request.ids.length === 1 ? ordinals.get(request.ids[0]) : undefined;
    let code: "BROWSE_RESPONSE_INVALID" | "BROWSE_REGISTRATION_INVALID" = "BROWSE_RESPONSE_INVALID";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!response.ok()) {
        unverified = true;
        report({ code: "BROWSE_HTTP_ERROR", student, record: ordinal, httpStatus: response.status() });
        return;
      }
      const raw: unknown = await Promise.race([response.json(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new Error(); error.name = "TimeoutError"; reject(error); }, responseTimeout);
      })]);
      const payload = z.object({ html: z.string().max(50_000_000), script: z.string().max(20_000_000) }).parse(raw);
      code = "BROWSE_REGISTRATION_INVALID";
      const registration = parseBrowseRegistration(payload.script);
      if (!/^StudentGrades-\d+$/.test(registration.browseName)) throw new Error();
      if (results.length < 300) {
        results.push({ ...registration, html: payload.html, studentIds: request.ids, requestUnverified: request.unverified, ordinal });
      } else {
        unverified = true;
        report({ code: "COLLECTION_LIMIT", student, record: ordinal, expected: 300, actual: results.length + 1 });
      }
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      unverified = true;
      report({ code, student, record: ordinal, field: code === "BROWSE_RESPONSE_INVALID" ? "response" : "metadata",
        errorType: diagnosticErrorType(error) });
    } finally { clearTimeout(timer); }
  };
  const onResponse = bindDiagnosticContext((response: Response) => {
    const ordinal = requests.get(response.request());
    if (ordinal === undefined) return;
    const task = readResponse(response, ordinal).catch(error => { fatal = error; }).finally(() => {
      pending.delete(task);
      inFlight.delete(response.request());
      notify();
    });
    pending.add(task);
  });
  const onFailed = bindDiagnosticContext((request: Request) => {
    const ordinal = requests.get(request);
    if (ordinal === undefined) return;
    inFlight.delete(request);
    unverified = true;
    try {
      const metadata = binding(request, ordinal);
      report({ code: "REQUEST_FAILED", record: ordinal, student: metadata.ids.length === 1 ? ordinals.get(metadata.ids[0]) : undefined });
    } catch (error) { fatal = error; }
    notify();
  });
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  return {
    setOrdinals(value: Map<string, number>) { ordinals = value; },
    unverified() { checkFatal(); return unverified; },
    async wait(studentIds: string[], timeout: number) {
      await new Promise<void>(resolve => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const finish = () => { clearTimeout(timer); clearTimeout(quiet); listeners.delete(check); resolve(); };
        const check = () => {
          clearTimeout(quiet);
          if (fatal) finish();
          else if (!inFlight.size && !pending.size &&
              studentIds.every(id => results.some(result => result.studentIds.length === 1 && result.studentIds[0] === id))) {
            quiet = setTimeout(finish, Math.min(25, timeout));
          }
        };
        const timer = setTimeout(finish, timeout);
        listeners.add(check);
        check();
      });
      checkFatal();
    },
    values() { checkFatal(); return [...results]; },
    async close() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      await Promise.all(pending);
      checkFatal();
    },
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
  browse: Pick<GradeBrowse, "recordCount" | "rowsPerPageCap">, snapshot: Awaited<ReturnType<typeof gradeSnapshot>>, capturedAt: string,
  context: DiagnosticContext = {}): GradeStudent {
  const result: GradeStudent = { ...student, status: "failed", grades: [], periods: [], scannedCount: 0, pages: 1,
    verifiedEmpty: false, warning: "LIST_UNVERIFIED" };
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "grades", ...event });
  let incomplete = false;
  const issue = (warning: GradeStudent["warning"], event: DiagnosticEvent) => {
    incomplete = true;
    result.warning ??= warning;
    report(event);
  };
  delete result.warning;
  try {
    for (const [index, header] of snapshot.headers.entries()) if (header.span !== 1) {
      issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "headers", record: index + 1,
        expected: 1, actual: header.span, counts: { headers: snapshot.headers.length } });
    }
    if (snapshot.headers.length < 2 || snapshot.headers[0].label !== "Class" || snapshot.headers[1].label !== "Missing Assignments" ||
        snapshot.headers.slice(0, 2).some(header => header.span !== 1)) {
      issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "headers", counts: { headers: snapshot.headers.length },
        flags: { headerMatch: false } });
      return result;
    }
    const labels = new Map<string, number>();
    for (const header of snapshot.headers.slice(2)) labels.set(header.label, (labels.get(header.label) ?? 0) + 1);
    const periods = new Map<number, { label: string; termId: string | null }>();
    let width = 0;
    let periodLimit = false;
    for (const [index, header] of snapshot.headers.entries()) {
      const column = width;
      if (!Number.isInteger(header.span) || header.span < 1) {
        issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "headers", record: index + 1 });
        return result;
      }
      width += header.span;
      if (index < 2) continue;
      if (header.span !== 1 || !header.label.trim() || header.label.length > 1_000_000 || labels.get(header.label)! > 1) {
        issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "periods", record: index + 1,
          counts: { periods: snapshot.headers.length - 2 }, flags: { headerMatch: false } });
        continue;
      }
      if (periods.size === 100) {
        if (!periodLimit) issue("COVERAGE_UNVERIFIED", { code: "COLLECTION_LIMIT", field: "periods", expected: 100, actual: snapshot.headers.length - 2 });
        periodLimit = true;
        continue;
      }
      const termId = gradeRecordSchema.shape.termId.safeParse(header.termId);
      if (!termId.success) issue("RECORD_INVALID", { code: "FIELD_INVALID", record: index + 1, field: "periods", errorType: "validation" });
      periods.set(column, { label: header.label, termId: termId.success ? termId.data : null });
    }
    result.periods = [...periods.values()].map(period => period.label);
    const courseCounts = new Map<string, number>();
    for (const row of snapshot.rows) if (row.studentId === student.id && /^\d{1,300}$/.test(row.studentSectionId)) {
      courseCounts.set(row.studentSectionId, (courseCounts.get(row.studentSectionId) ?? 0) + 1);
    }
    const grades = new Set<string>();
    const duplicateGrades = new Set<string>();
    let gradeLimit = false;
    if (snapshot.rows.length > 100_000) issue("COVERAGE_UNVERIFIED", { code: "COLLECTION_LIMIT", expected: 100_000, actual: snapshot.rows.length });
    for (const [rowIndex, row] of snapshot.rows.slice(0, 100_000).entries()) {
      const course = rowIndex + 1;
      try {
        if (row.studentId !== student.id) {
          issue("STUDENT_UNVERIFIED", { code: "STUDENT_BINDING_CONFLICT", course, field: "student",
            flags: { hasStudent: !!row.studentId, matched: false }, counts: { skipped: 1 } });
          continue;
        }
        if (!/^\d{1,300}$/.test(row.studentSectionId) || !row.course.trim() || row.course.length > 1_000_000) {
          issue("RECORD_INVALID", { code: "RECORD_INVALID", course, field: "course",
            flags: { hasId: !!row.studentSectionId, hasCourse: !!row.course.trim() }, counts: { skipped: 1 } });
          continue;
        }
        if (courseCounts.get(row.studentSectionId)! > 1) {
          issue("RECORD_INVALID", { code: "DUPLICATE_RECORD", course, field: "course", counts: { skipped: 1 } });
          continue;
        }
        result.scannedCount++;
        let rowWidth = 0;
        let invalidSpan = false;
        for (const [index, cell] of row.cells.entries()) {
          if (cell.span !== 1) issue("RECORD_INVALID", { code: "LIST_LAYOUT_UNVERIFIED", course, record: index + 1, field: "periods",
            expected: 1, actual: cell.span, counts: { headers: snapshot.headers.length, cells: row.cells.length } });
          if (!Number.isInteger(cell.span) || cell.span < 1) invalidSpan = true;
          else rowWidth += cell.span;
        }
        if (invalidSpan || rowWidth !== width) {
          issue("RECORD_INVALID", { code: "LIST_LAYOUT_UNVERIFIED", course, field: "periods", expected: width, actual: rowWidth,
            counts: { headers: snapshot.headers.length, cells: row.cells.length, skipped: 1 } });
          continue;
        }
        const courseCode = gradeRecordSchema.shape.courseCode.safeParse(row.courseCode);
        const classDetails = gradeRecordSchema.shape.classDetails.safeParse(row.classDetails);
        if (!courseCode.success || !classDetails.success) issue("RECORD_INVALID", { code: "FIELD_INVALID", course, field: "metadata", errorType: "validation" });
        let column = 0;
        for (const [index, cell] of row.cells.entries()) {
          const position = column;
          column += cell.span;
          if (position < 2 || cell.span !== 1) continue;
          const record = index + 1;
          try {
            if (cell.bucketId === null && !cell.hasLink && !cell.text) continue;
            const period = periods.get(position);
            if (!period) {
              issue("LIST_UNVERIFIED", { code: "RECORD_SKIPPED", course, record, field: "periods", counts: { skipped: 1 } });
              continue;
            }
            if (!cell.bucketId || !/^\d{1,300}$/.test(cell.bucketId)) {
              issue("RECORD_INVALID", { code: "RECORD_INVALID", course, record, field: "id",
                flags: { hasId: !!cell.bucketId, hasLink: cell.hasLink }, counts: { skipped: 1 } });
              continue;
            }
            if (grades.has(cell.bucketId)) {
              duplicateGrades.add(cell.bucketId);
              issue("RECORD_INVALID", { code: "DUPLICATE_RECORD", course, record, field: "id", counts: { duplicates: 1 } });
              continue;
            }
            grades.add(cell.bucketId);
            const mark = gradeRecordSchema.shape.grade.safeParse(cell.mark || null);
            if (!cell.hasLink || cell.unrecognizedMark || !mark.success) issue("RECORD_INVALID", { code: "FIELD_INVALID",
              course, record, field: "mark", flags: { hasLink: cell.hasLink, hasMark: !!cell.mark } });
            const periodStatus = gradeRecordSchema.shape.periodStatus.safeParse(cell.periodStatus);
            if (!cell.hasLink || !periodStatus.success || periodStatus.data === "unknown") {
              issue("RECORD_INVALID", { code: "STATE_UNKNOWN", course, record, field: "status" });
            }
            if (result.grades.length === 100_000) {
              if (!gradeLimit) issue("COVERAGE_UNVERIFIED", { code: "COLLECTION_LIMIT", expected: 100_000, actual: result.grades.length + 1 });
              gradeLimit = true;
              continue;
            }
            result.grades.push(gradeRecordSchema.parse({
              id: cell.bucketId, studentSectionId: row.studentSectionId, courseCode: courseCode.success ? courseCode.data : null,
              course: row.course, classDetails: classDetails.success ? classDetails.data : null, section: null, teacher: null,
              termId: period.termId, term: period.label, periodStatus: cell.hasLink && periodStatus.success ? periodStatus.data : "unknown",
              schoolYear: null, grade: cell.hasLink && !cell.unrecognizedMark && mark.success ? mark.data : null, score: null,
              maxScore: null, gradingScale: null, effectiveDate: null, source: { portal: "skyward", url: GRADES_URL, capturedAt },
            }));
          } catch (error) {
            if (error instanceof DiagnosticLogError) throw error;
            issue("RECORD_INVALID", { code: "RECORD_INVALID", course, record, errorType: diagnosticErrorType(error), counts: { skipped: 1 } });
          }
        }
      } catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        issue("RECORD_INVALID", { code: "RECORD_INVALID", course, errorType: diagnosticErrorType(error), counts: { skipped: 1 } });
      }
    }
    result.grades = result.grades.filter(grade => !duplicateGrades.has(grade.id));
    const expectedRows = snapshot.emptyMarkers === 1 && browse.recordCount === 1 ? 0 : browse.recordCount;
    if (browse.rowsPerPageCap !== null || snapshot.rows.length !== expectedRows ||
        (expectedRows === 0 ? snapshot.emptyMarkers !== 1 : snapshot.emptyMarkers !== 0) ||
        (expectedRows > 0 && !periods.size)) {
      issue("COVERAGE_UNVERIFIED", { code: "PAGINATION_UNVERIFIED", expected: expectedRows, actual: snapshot.rows.length,
        counts: { periods: periods.size }, flags: { capped: browse.rowsPerPageCap !== null, verifiedEmpty: snapshot.emptyMarkers === 1 } });
    }
    result.verifiedEmpty = !incomplete && expectedRows === 0;
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    issue("LIST_UNVERIFIED", { code: "SCOPE_FAILED", errorType: diagnosticErrorType(error) });
  }
  result.status = incomplete ? result.grades.length ? "partial" : "failed" : "complete";
  return result;
}

export async function collectGrades(page: Page, now = new Date(), timeout = 15_000): Promise<GradeRun> {
  const run: GradeRun = { runId: randomUUID(), capturedAt: now.toISOString(), parserVersion: 1,
    discoveryComplete: false, status: "failed", students: [] };
  const started = Date.now();
  const context = { runId: run.runId, parserVersion: run.parserVersion };
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "grades", ...event });
  report({ level: "info", code: "RUN_STARTED" });
  const observer = observeGradeBrowses(page, context, timeout);
  let ordinals = new Map<string, number>();
  const collect = async () => {
    try { await confirmLogin(page, process.env.SKYWARD_SUCCESS_SELECTOR, timeout); }
    catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      run.status = "auth-required"; run.warning = "AUTH_REQUIRED";
      report({ code: "AUTH_REQUIRED", status: "auth-required", errorType: diagnosticErrorType(error) });
      return;
    }
    run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    const discovery = await discoverSkywardStudents(page, "studentGrades", timeout, context);
    const roster = discovery.students;
    ordinals = discovery.ordinals;
    observer.setOrdinals(ordinals);
    run.students = [...roster.values()].map(student => ({ ...student, status: "failed", grades: [], periods: [], scannedCount: 0,
      pages: 0, verifiedEmpty: false, warning: "LIST_UNVERIFIED" }));
    run.discoveryComplete = discovery.complete;
    if (!roster.size) return;
    if (run.discoveryComplete) run.warning = "NAVIGATION_FAILED";
    await page.locator('a[id="-studentGrades_Widget"][data-studentid=""]').click({ timeout });
    await page.waitForURL(url => url.origin === new URL(GRADES_URL).origin && url.pathname === new URL(GRADES_URL).pathname, { timeout });
    await observer.wait([...roster.keys()], timeout);
    const matched = new Set<string>();
    const unverifiedStudents = new Set<string>();
    const conflictingGrades = new Map<string, Set<string>>();
    const observations = observer.values();
    const seenScopes = new Map<string, GradeBrowse[]>();
    const sameObservation = (left: GradeBrowse, right: GradeBrowse) => left.html === right.html &&
      left.recordCount === right.recordCount && left.rowsPerPageCap === right.rowsPerPageCap &&
      left.requestUnverified === right.requestUnverified && left.studentIds.length === right.studentIds.length &&
      left.studentIds.every(id => right.studentIds.includes(id));
    const scopeConflicts = new Set(observations.filter(browse =>
      observations.some(other => other.browseName === browse.browseName && !sameObservation(browse, other))).map(browse => browse.browseName));
    for (const browse of observations) {
      const expectedId = browse.studentIds.length === 1 ? browse.studentIds[0] : undefined;
      const expectedStudent = expectedId ? ordinals.get(expectedId) : undefined;
      let snapshot: Awaited<ReturnType<typeof gradeSnapshot>>;
      try { snapshot = await gradeSnapshot(page, browse.html); }
      catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        if (expectedId && roster.has(expectedId)) unverifiedStudents.add(expectedId);
        else run.discoveryComplete = false;
        report({ code: "SCOPE_FAILED", student: expectedStudent, record: browse.ordinal, errorType: diagnosticErrorType(error),
          counts: { requestStudents: browse.studentIds.length } });
        continue;
      }
      const rowIds = new Set(snapshot.rows.map(row => row.studentId).filter(id => /^\d{1,300}$/.test(id)));
      const candidateIds = new Set([...browse.studentIds, ...rowIds]);
      const rosterMatches = [...candidateIds].filter(id => roster.has(id));
      const counts = { requestStudents: browse.studentIds.length, rowStudents: rowIds.size, rosterMatches: rosterMatches.length,
        headers: snapshot.headers.length, courses: snapshot.rows.length };
      const rejectBinding = (code: "STUDENT_BINDING_MISSING" | "STUDENT_BINDING_AMBIGUOUS" | "STUDENT_BINDING_CONFLICT") => {
        run.discoveryComplete = false;
        for (const id of rosterMatches) unverifiedStudents.add(id);
        const expected = expectedStudent === undefined ? rosterMatches.map(id => ordinals.get(id)) : [expectedStudent];
        for (const student of expected.length ? expected : [undefined]) {
          report({ code, student, record: browse.ordinal, field: "student", counts,
            flags: { hasStudent: candidateIds.size > 0, matched: false, conflicted: code !== "STUDENT_BINDING_MISSING" } });
        }
      };
      if (browse.studentIds.length > 1) {
        rejectBinding("STUDENT_BINDING_AMBIGUOUS");
        continue;
      }
      let id: string;
      if (expectedId) {
        if (!roster.has(expectedId)) {
          rejectBinding(rowIds.size && !rowIds.has(expectedId) ? "STUDENT_BINDING_CONFLICT" : "STUDENT_BINDING_MISSING");
          continue;
        }
        id = expectedId;
        if (snapshot.rows.some(row => row.studentId !== id)) {
          run.discoveryComplete = false;
          unverifiedStudents.add(id);
          report({ code: "STUDENT_BINDING_CONFLICT", student: expectedStudent, record: browse.ordinal, field: "student", counts,
            flags: { matched: false, conflicted: true } });
        }
      } else {
        if (rowIds.size !== 1 || !roster.has([...rowIds][0])) {
          rejectBinding(rowIds.size > 1 ? "STUDENT_BINDING_AMBIGUOUS" : "STUDENT_BINDING_MISSING");
          continue;
        }
        id = [...rowIds][0];
      }
      const studentContext = { ...context, student: ordinals.get(id) };
      if (browse.requestUnverified) unverifiedStudents.add(id);
      const previousScopes = seenScopes.get(browse.browseName) ?? [];
      if (previousScopes.some(previous => sameObservation(previous, browse))) {
        report({ level: "info", code: "DUPLICATE_SCOPE", student: studentContext.student, record: browse.ordinal,
          counts: { duplicates: 1 }, flags: { conflicted: scopeConflicts.has(browse.browseName) } });
        continue;
      }
      seenScopes.set(browse.browseName, [...previousScopes, browse]);
      if (scopeConflicts.has(browse.browseName)) {
        unverifiedStudents.add(id);
        report({ code: "DUPLICATE_SCOPE", student: studentContext.student, record: browse.ordinal,
          flags: { conflicted: true }, counts });
      }
      let student = parseGradeSnapshot(roster.get(id)!, browse, snapshot, run.capturedAt, studentContext);
      const index = run.students.findIndex(candidate => candidate.id === id);
      if (matched.has(id)) {
        unverifiedStudents.add(id);
        report({ code: "DUPLICATE_STUDENT", student: studentContext.student, record: browse.ordinal,
          flags: { conflicted: true }, counts });
        const previous = run.students[index];
        const duplicates = conflictingGrades.get(id) ?? new Set<string>();
        const records = new Map(previous.grades.filter(grade => !duplicates.has(grade.id)).map(grade => [grade.id, grade]));
        for (const grade of student.grades) {
          if (duplicates.has(grade.id)) continue;
          const existing = records.get(grade.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(grade)) {
            duplicates.add(grade.id);
            records.delete(grade.id);
            report({ code: "DUPLICATE_RECORD", student: studentContext.student, record: browse.ordinal, field: "id",
              counts: { duplicates: 1 }, flags: { conflicted: true } });
          } else if (!existing) records.set(grade.id, grade);
        }
        conflictingGrades.set(id, duplicates);
        const periods = [...new Set([...previous.periods, ...student.periods])];
        if (periods.length > 100 || records.size > 100_000) {
          report({ code: "COLLECTION_LIMIT", student: studentContext.student, counts: { periods: periods.length, accepted: records.size } });
        }
        student.periods = periods.slice(0, 100);
        student.grades = [...records.values()].filter(grade => student.periods.includes(grade.term)).slice(0, 100_000);
        student.scannedCount = Math.max(previous.scannedCount, student.scannedCount,
          new Set(student.grades.map(grade => grade.studentSectionId)).size);
        student.pages = Math.max(previous.pages, student.pages);
        student.warning = "COVERAGE_UNVERIFIED";
      }
      matched.add(id);
      run.students[index] = student;
    }
    for (const student of run.students) {
      if (!matched.has(student.id)) {
        report({ code: "STUDENT_BINDING_MISSING", student: ordinals.get(student.id), field: "student", expected: 1, actual: 0 });
      }
      if (unverifiedStudents.has(student.id)) {
        student.status = student.grades.length ? "partial" : "failed";
        student.verifiedEmpty = false;
        student.warning ??= "STUDENT_UNVERIFIED";
      }
    }
    if (run.discoveryComplete) delete run.warning;
  };
  try { await collect(); }
  catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    report({ code: "SCOPE_FAILED", errorType: diagnosticErrorType(error) });
    const passwordCount = await page.locator('input[type="password"]:visible').count().catch(error => {
      if (error instanceof DiagnosticLogError) throw error;
      report({ code: "STATE_UNKNOWN", field: "status", errorType: diagnosticErrorType(error) });
      return 0;
    });
    if (passwordCount) {
      run.status = "auth-required"; run.warning = "AUTH_REQUIRED";
      report({ code: "AUTH_REQUIRED", status: "auth-required" });
      for (const student of run.students) if (student.status !== "complete") { student.status = "auth-required"; student.warning = "AUTH_REQUIRED"; }
    }
  } finally { await observer.close(); }
  if (run.status !== "auth-required") {
    if (observer.unverified()) run.discoveryComplete = false;
    if (!run.discoveryComplete) run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    run.status = run.discoveryComplete && run.students.length > 0 && run.students.every(student => student.status === "complete") ? "complete" :
      run.students.some(student => student.status === "complete" || student.grades.length > 0) ? "partial" : "failed";
  }
  const parsed = gradeRunSchema.parse(run);
  for (const student of parsed.students) {
    report({ level: "info", code: "SECTION_SUMMARY", student: ordinals.get(student.id), status: student.status,
      counts: { scanned: student.scannedCount, accepted: student.grades.length, periods: student.periods.length, pages: student.pages },
      flags: { verifiedEmpty: student.verifiedEmpty } });
  }
  report({ level: "info", code: "RUN_SUMMARY", status: parsed.status, durationMs: Math.max(0, Date.now() - started),
    counts: { students: parsed.students.length, accepted: parsed.students.reduce((count, student) => count + student.grades.length, 0) },
    flags: { discoveryComplete: parsed.discoveryComplete } });
  return parsed;
}

export async function collectGradesToStore(page: Page, store: Pick<GradeStore, "importGradeRun">,
  accountId: string, now = new Date(), timeout = 15_000): Promise<GradeRun> {
  const run = await collectGrades(page, now, timeout);
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", portal: "skyward", section: "grades",
    stage: "DATABASE_WRITE", runId: run.runId });
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
  withLocalDiagnostics(path.resolve(__dirname, "../../.."), "skyward:grades", main).catch((error: unknown) => {
    console.error(error instanceof DiagnosticLogError ? `LOCAL_LOG: ${error.message}` :
      error instanceof GradeUsageError ? `GRADES: ${error.message} No portal access was attempted.` :
      "GRADES: Collection or storage failed. Check the existing database, original key, private permissions, and session. Renew locally with skyward:login if expired. Private error details withheld.");
    process.exitCode = 1;
  });
}