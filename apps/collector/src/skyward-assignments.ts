import type { Locator, Page, Request, Response } from "playwright";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assignmentRunSchema, assignmentSchema, isAssignmentInWindow, type AssignmentRun, type AssignmentSection,
  type AssignmentWindow, type CollectedAssignment } from "@schoolhawk/core/assignments";
import type { AssignmentStore } from "@schoolhawk/storage/assignments";
import portalConfig from "../../../config/portals.json";
import { confirmLogin } from "./skyward-login";
import { dateWindow, discoverSkywardStudents, parseBrowseRegistration, withSkywardCollection } from "./skyward";
export { parseBrowseRegistration, parseStudentName } from "./skyward";

export const ASSIGNMENTS_URL = portalConfig.portals.skyward.urls.assignments;
const BROWSE_PATH = "/lkwash/Gradebook/Assignment/GetBrowse";
const KINDS = ["upcoming", "missing", "past"] as const;
const PREFIXES = { upcoming: "StudentUpcomingAssignmentsFamilyAccess-", missing: "StudentMissingAssignmentsFamilyAccess-", past: "StudentPastAssignmentsFamilyAccess-" };
const FIELDS = {
  dueDate: "DueDate", title: "Name", course: "Section.SpecifiedStudentSection.CourseOrTransferDescription",
  section: "Section.Code", teacher: "Section.StaffCurrentStoredPrimary.FamilyStudentAccessStaffNameToUse",
  category: "Category.Description", grade: "StudentAssignment.CecsSafeGradeMarkCodeToUse",
  score: "StudentAssignment.CecsSafeStudentOnlineAssignmentDisplayPointsEarned", maxScore: "CecsSafeMaxScoreDisplay",
  weight: "CecsSafeWeightDisplay", attempts: "StudentAssignment.CecsSafeAttemptCountDisplay",
  attachments: "StudentFamilyAccessAttachmentCount",
};
type Registration = ReturnType<typeof parseBrowseRegistration>;
type BrowseResult = Registration & { html: string };
class AssignmentUsageError extends Error {}

export function parseAssignmentOptions(args: string[]): { days: number; accountId: string } {
  const remaining = [...args];
  const index = remaining.indexOf("--account");
  const accountId = remaining[index + 1];
  if (index < 0 || remaining.filter(value => value === "--account").length !== 1 || !accountId || !/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)) {
    throw new AssignmentUsageError("Provide --account once with a non-sensitive account alias. Example: npm run skyward:assignments -- 7 --account lkwash-parent");
  }
  remaining.splice(index, 2);
  const days = Number(remaining[0]);
  if (remaining.length !== 1 || !/^\d+$/.test(remaining[0]) || !Number.isInteger(days) || days < 1 || days > 366) {
    throw new AssignmentUsageError("Provide one past-assignment day count N from 1 to 366. Upcoming and missing assignments are always included.");
  }
  return { days, accountId };
}

export function assignmentDate(value: string): string | null {
  if (!value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?)?$/.test(value)) throw new Error("Unverified assignment date.");
  return z.iso.date().parse(value.slice(0, 10));
}

function observeBrowses(page: Page) {
  let generation = 0;
  const requests = new WeakMap<Request, number>();
  const registrations = new Map<string, BrowseResult>();
  const listeners = new Set<() => void>();
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(ASSIGNMENTS_URL).origin && url.pathname === BROWSE_PATH) requests.set(request, generation);
  };
  const onResponse = async (response: Response) => {
    const requestGeneration = requests.get(response.request());
    if (requestGeneration === undefined) return;
    try {
      if (!response.ok()) return;
      const payload: unknown = await response.json();
      const { script, html } = z.object({ script: z.string().max(20_000_000), html: z.string().max(50_000_000) }).parse(payload);
      const registration = parseBrowseRegistration(script);
      if (requestGeneration !== generation) return;
      registrations.set(registration.browseName, { ...registration, html });
      for (const listener of listeners) listener();
    } catch {}
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    reset() { generation++; registrations.clear(); },
    find(id: string) { return registrations.get(id); },
    async wait(count: number, timeout: number) {
      if (registrations.size >= count) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); listeners.delete(check); resolve(); };
        const check = () => { if (registrations.size >= count) finish(); };
        const timer = setTimeout(finish, timeout);
        listeners.add(check);
        check();
      });
    },
    close() { page.off("request", onRequest); page.off("response", onResponse); },
  };
}

function emptySection(kind: AssignmentSection["kind"]): AssignmentSection {
  return { kind, status: "failed", assignments: [], scannedCount: 0, pages: 0, verifiedEmpty: false, warning: "LIST_UNVERIFIED" };
}

export async function readAssignmentSection(browse: Locator, registration: BrowseResult | undefined,
  kind: AssignmentSection["kind"], window: AssignmentWindow, capturedAt: string, timeout: number): Promise<AssignmentSection> {
  const result = emptySection(kind);
  if (!registration) return result;
  try {
    const snapshot = await browse.evaluate((_element, html) => {
      const element = new DOMParser().parseFromString(html, "text/html");
      const columns = [...element.querySelectorAll('.unlockedHeaderTableRow [data-field-name]')].map(header => ({
        field: header.getAttribute("data-field-name")!, column: header.getAttribute("data-column-index")!,
      }));
      const rows = [...element.querySelectorAll('tr.browseRow[id*="_unlockedRow"]')].map(row => {
        const indicator = row.querySelector('.attachmentButton[data-module="Gradebook"][data-object="Assignment"][data-action="AttachmentsFamilyAccess"][data-field="StudentFamilyAccessAttachmentCount"]');
        return { id: indicator?.getAttribute("data-id") ?? "", values: Object.fromEntries(columns.map(({ field, column }) => {
          const cell = [...row.children].find(child => child.getAttribute("data-column") === column);
          return [field, { text: cell?.textContent?.trim() ?? "", raw: cell?.getAttribute("data-field-value") ?? "",
            status: cell?.getAttribute("aria-label")?.trim() || null }];
        })) };
      });
      return { fields: columns.map(column => column.field), rows, empty: element.querySelectorAll(".noRecordsInBrowse").length === 1 };
    }, registration.html, { timeout });
    result.pages = 1;
    if (!Object.values(FIELDS).every(field => snapshot.fields.includes(field))) throw new Error();
    const identities = new Set<string>();
    for (const row of snapshot.rows) {
      result.warning = "RECORD_INVALID";
      if (!/^\d+$/.test(row.id) || identities.has(row.id)) throw new Error();
      identities.add(row.id);
      const value = (field: string) => row.values[field]?.text || null;
      const attachmentCount = row.values[FIELDS.attachments].raw;
      if (attachmentCount && !/^\d+$/.test(attachmentCount)) throw new Error();
      const assignment: CollectedAssignment = assignmentSchema.parse({
        id: row.id, title: value(FIELDS.title), course: value(FIELDS.course), section: value(FIELDS.section),
        teacher: value(FIELDS.teacher), dueDate: assignmentDate(row.values[FIELDS.dueDate].raw), assignedDate: null,
        description: null, category: value(FIELDS.category), grade: value(FIELDS.grade), score: value(FIELDS.score),
        scoreStatus: row.values[FIELDS.score].status, maxScore: value(FIELDS.maxScore), weight: value(FIELDS.weight),
        attempts: value(FIELDS.attempts), attachmentCount: attachmentCount ? Number(attachmentCount) : null,
        missing: kind === "missing" ? true : null,
        source: { portal: "skyward", url: ASSIGNMENTS_URL, capturedAt },
      });
      result.scannedCount++;
      if (kind !== "past" || isAssignmentInWindow(assignment, window)) result.assignments.push(assignment);
    }
    result.warning = "PAGINATION_UNVERIFIED";
    const expectedRows = snapshot.empty && registration.recordCount === 1 ? 0 : registration.recordCount;
    if (registration.rowsPerPageCap !== null || snapshot.rows.length !== expectedRows ||
      (expectedRows === 0 ? !snapshot.empty : snapshot.empty)) throw new Error();
    result.verifiedEmpty = expectedRows === 0;
    result.status = "complete";
    delete result.warning;
  } catch { result.status = result.assignments.length ? "partial" : "failed"; }
  return result;
}

export async function collectAssignments(page: Page, days: number, now = new Date(), timeout = 15_000): Promise<AssignmentRun> {
  const run: AssignmentRun = { runId: randomUUID(), capturedAt: now.toISOString(), window: dateWindow(days, now),
    parserVersion: 2, discoveryComplete: false, status: "failed", students: [] };
  const browses = observeBrowses(page);
  try {
    try { await confirmLogin(page, process.env.SKYWARD_SUCCESS_SELECTOR, timeout); }
    catch { run.status = "auth-required"; run.warning = "AUTH_REQUIRED"; return run; }
    run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    const students = await discoverSkywardStudents(page, "assignmentsList", timeout);
    run.students = [...students.values()].map(student => ({ ...student, sections: KINDS.map(emptySection) }));
    run.discoveryComplete = true;
    run.warning = "NAVIGATION_FAILED";
    await page.locator('a[id="-assignmentsList_Widget"][data-studentid=""]').click({ timeout });
    await page.locator("#StudentAssignmentWrapper").waitFor({ state: "attached", timeout });
    const current = new URL(page.url());
    if (current.origin !== new URL(ASSIGNMENTS_URL).origin || current.pathname !== new URL(ASSIGNMENTS_URL).pathname) throw new Error();
    const allYear = page.getByLabel("All Year", { exact: true });
    if (!await allYear.isChecked()) {
      browses.reset();
      await allYear.check({ timeout });
    }
    await browses.wait(students.size * KINDS.length, timeout);
    if (!await allYear.isChecked()) throw new Error();
    const scopes = page.locator('#StudentAssignmentWrapper .template:has(> #StudentAssignments)');
    const scopedIds = await scopes.evaluateAll(elements => elements.map(element => element.querySelector<HTMLInputElement>('input[name="StudentID"]')?.value ?? ""));
    if (scopedIds.some(id => !students.has(id)) || new Set(scopedIds).size !== scopedIds.length) {
      run.discoveryComplete = false;
      run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    } else delete run.warning;
    for (const student of run.students) {
      const index = scopedIds.indexOf(student.id);
      if (index === -1 || !run.discoveryComplete) {
        student.sections.forEach(section => { section.warning = "STUDENT_UNVERIFIED"; });
        continue;
      }
      const scope = scopes.nth(index);
      for (const [sectionIndex, kind] of KINDS.entries()) {
        const browse = scope.locator(`.browse[id^="${PREFIXES[kind]}"]`);
        if (await browse.count() !== 1) continue;
        const id = await browse.getAttribute("id");
        student.sections[sectionIndex] = await readAssignmentSection(browse, id ? browses.find(id) : undefined,
          kind, run.window, new Date().toISOString(), timeout);
      }
      const missing = student.sections.find(section => section.kind === "missing")!;
      if (missing.status === "complete") {
        const missingIds = new Set(missing.assignments.map(assignment => assignment.id));
        for (const section of student.sections) for (const assignment of section.assignments) assignment.missing = missingIds.has(assignment.id);
      }
    }
    const sections = run.students.flatMap(student => student.sections);
    run.status = run.discoveryComplete && sections.every(section => section.status === "complete") ? "complete" :
      sections.some(section => section.status === "complete" || section.assignments.length > 0) ? "partial" : "failed";
  } catch {
    if (await page.locator('input[type="password"]:visible').count().catch(() => 0)) {
      run.status = "auth-required"; run.warning = "AUTH_REQUIRED";
      for (const student of run.students) for (const section of student.sections) {
        if (section.status !== "complete") { section.status = "auth-required"; section.warning = "AUTH_REQUIRED"; }
      }
    }
  } finally { browses.close(); }
  return assignmentRunSchema.parse(run);
}

export async function collectAssignmentsToStore(page: Page, store: Pick<AssignmentStore, "importAssignmentRun">,
  accountId: string, days: number, now = new Date(), timeout = 15_000): Promise<AssignmentRun> {
  const run = await collectAssignments(page, days, now, timeout);
  store.importAssignmentRun(accountId, run);
  return run;
}

export function assignmentSummary(run: AssignmentRun) {
  return { runId: run.runId, status: run.status, window: run.window, discoveryComplete: run.discoveryComplete,
    students: run.students.map((student, index) => ({ student: index + 1, sections: student.sections.map(section => ({
      kind: section.kind, status: section.status, assignments: section.assignments.length, scanned: section.scannedCount,
      verifiedEmpty: section.verifiedEmpty, warning: section.warning,
    })) })), warning: run.warning };
}

async function main(): Promise<void> {
  const { days, accountId } = parseAssignmentOptions(process.argv.slice(2));
  const { result, database } = await withSkywardCollection((page, store) => collectAssignmentsToStore(page, store, accountId, days));
  console.log(JSON.stringify({ ...assignmentSummary(result), database }, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof AssignmentUsageError ? `ASSIGNMENTS: ${error.message} No portal access was attempted.` :
      "ASSIGNMENTS: Collection or storage failed. Check the existing database, original key, private permissions, and session. Renew locally with skyward:login if expired. Private error details withheld.");
    process.exitCode = 1;
  });
}