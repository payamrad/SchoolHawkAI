import type { Locator, Page, Request, Response } from "playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { assignmentRunSchema, assignmentSchema, isAssignmentInWindow, type AssignmentRun, type AssignmentSection,
  type AssignmentWindow, type CollectedAssignment } from "@schoolhawk/core/assignments";
import { bindDiagnosticContext, DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
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
type BrowseResult = Registration & { html: string; conflicted?: boolean };
type DiagnosticContext = Pick<DiagnosticEvent, "runId" | "parserVersion" | "student">;
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

function observeBrowses(page: Page, context: DiagnosticContext, responseTimeout: number) {
  let generation = 0;
  let requestCount = 0;
  let unverified = false;
  let fatal: unknown;
  const requests = new WeakMap<Request, { generation: number; ordinal: number }>();
  const inFlight = new Set<Request>();
  const pending = new Map<Promise<void>, number>();
  const registrations = new Map<string, BrowseResult>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const checkFatal = () => { if (fatal) throw fatal; };
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "assignments", ...event });
  const onRequest = bindDiagnosticContext((request: Request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(ASSIGNMENTS_URL).origin && url.pathname === BROWSE_PATH) {
      requests.set(request, { generation, ordinal: ++requestCount });
      inFlight.add(request);
      notify();
    }
  });
  const readResponse = async (response: Response, request: { generation: number; ordinal: number }) => {
    if (request.generation !== generation) return;
    let code: "BROWSE_RESPONSE_INVALID" | "BROWSE_REGISTRATION_INVALID" = "BROWSE_RESPONSE_INVALID";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!response.ok()) {
        unverified = true;
        report({ code: "BROWSE_HTTP_ERROR", record: request.ordinal, httpStatus: response.status() });
        return;
      }
      const payload: unknown = await Promise.race([response.json(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new Error(); error.name = "TimeoutError"; reject(error); }, responseTimeout);
      })]);
      if (request.generation !== generation) return;
      const { script, html } = z.object({ script: z.string().max(20_000_000), html: z.string().max(50_000_000) }).parse(payload);
      code = "BROWSE_REGISTRATION_INVALID";
      const registration = parseBrowseRegistration(script);
      if (!Object.values(PREFIXES).some(prefix => registration.browseName.startsWith(prefix))) throw new Error();
      const previous = registrations.get(registration.browseName);
      if (previous) {
        const conflicted = previous.html !== html || previous.recordCount !== registration.recordCount ||
          previous.rowsPerPageCap !== registration.rowsPerPageCap;
        previous.conflicted ||= conflicted;
        report({ level: conflicted ? "warn" : "info", code: "DUPLICATE_SCOPE", record: request.ordinal,
          flags: { conflicted }, counts: { duplicates: 1 } });
      } else if (registrations.size < 300) {
        registrations.set(registration.browseName, { ...registration, html });
      } else {
        unverified = true;
        report({ code: "COLLECTION_LIMIT", expected: 300, actual: registrations.size + 1 });
      }
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      if (request.generation !== generation) return;
      unverified = true;
      report({ code, record: request.ordinal, field: code === "BROWSE_RESPONSE_INVALID" ? "response" : "metadata",
        errorType: diagnosticErrorType(error) });
    } finally { clearTimeout(timer); }
  };
  const onResponse = bindDiagnosticContext((response: Response) => {
    const request = requests.get(response.request());
    if (!request) return;
    const task = readResponse(response, request).catch(error => { fatal = error; }).finally(() => {
      pending.delete(task);
      inFlight.delete(response.request());
      notify();
    });
    pending.set(task, request.generation);
  });
  const onFailed = bindDiagnosticContext((request: Request) => {
    const entry = requests.get(request);
    if (entry?.generation !== generation) return;
    inFlight.delete(request);
    unverified = true;
    try { report({ code: "REQUEST_FAILED", record: entry.ordinal }); } catch (error) { fatal = error; }
    notify();
  });
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  return {
    reset() { checkFatal(); generation++; registrations.clear(); inFlight.clear(); unverified = false; },
    find(id: string) { checkFatal(); return registrations.get(id); },
    ids() { checkFatal(); return [...registrations.keys()]; },
    unverified() { checkFatal(); return unverified; },
    async wait(count: number, timeout: number) {
      await new Promise<void>(resolve => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const finish = () => { clearTimeout(timer); clearTimeout(quiet); listeners.delete(check); resolve(); };
        const check = () => {
          clearTimeout(quiet);
          if (fatal) finish();
          else if (registrations.size >= count && !inFlight.size && ![...pending.values()].includes(generation)) {
            quiet = setTimeout(finish, Math.min(25, timeout));
          }
        };
        const timer = setTimeout(finish, timeout);
        listeners.add(check);
        check();
      });
      checkFatal();
    },
    async close() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      await Promise.all(pending.keys());
      checkFatal();
    },
  };
}

function emptySection(kind: AssignmentSection["kind"]): AssignmentSection {
  return { kind, status: "failed", assignments: [], scannedCount: 0, pages: 0, verifiedEmpty: false, warning: "LIST_UNVERIFIED" };
}

export async function readAssignmentSection(browse: Locator, registration: BrowseResult | undefined,
  kind: AssignmentSection["kind"], window: AssignmentWindow, capturedAt: string, timeout: number,
  context: DiagnosticContext = {}): Promise<AssignmentSection> {
  const result = emptySection(kind);
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: kind, ...event });
  if (!registration) {
    report({ code: "SCOPE_MISSING", field: "metadata" });
    return result;
  }
  delete result.warning;
  let incomplete = false;
  const issue = (warning: AssignmentSection["warning"], event: DiagnosticEvent) => {
    incomplete = true;
    result.warning ??= warning;
    report(event);
  };
  try {
    const snapshot = await browse.evaluate((_element, html) => {
      const element = new DOMParser().parseFromString(html, "text/html");
      const headers = [...element.querySelectorAll('.unlockedHeaderTableRow [data-field-name]')].map(header => ({
        field: header.getAttribute("data-field-name")!, column: header.getAttribute("data-column-index") ?? "",
        span: (header as HTMLTableCellElement).colSpan,
      }));
      const rows = [...element.querySelectorAll('tr.browseRow[id*="_unlockedRow"]')].map(row => {
        const indicators = row.querySelectorAll('.attachmentButton[data-module="Gradebook"][data-object="Assignment"][data-action="AttachmentsFamilyAccess"][data-field="StudentFamilyAccessAttachmentCount"]');
        return { ids: [...indicators].map(indicator => indicator.getAttribute("data-id") ?? ""),
          cells: [...row.children].map(cell => ({ column: cell.getAttribute("data-column") ?? "",
            text: cell.textContent?.trim() ?? "", raw: cell.getAttribute("data-field-value") ?? "",
            status: cell.getAttribute("aria-label")?.trim() || null, span: (cell as HTMLTableCellElement).colSpan })) };
      });
      return { headers, rows, emptyMarkers: element.querySelectorAll(".noRecordsInBrowse").length };
    }, registration.html, { timeout });
    result.pages = 1;
    const columns = new Map<string, string>();
    for (const [index, header] of snapshot.headers.entries()) {
      if (header.span !== 1) issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "headers",
        record: index + 1, expected: 1, actual: header.span, counts: { headers: snapshot.headers.length } });
    }
    for (const field of Object.values(FIELDS)) {
      const headers = snapshot.headers.filter(header => header.field === field);
      const header = headers[0];
      if (headers.length === 1 && header.span === 1 && /^\d+$/.test(header.column) &&
          snapshot.headers.filter(candidate => candidate.column === header.column).length === 1) columns.set(field, header.column);
    }
    if (columns.size !== Object.keys(FIELDS).length) issue("LIST_UNVERIFIED", { code: "LIST_LAYOUT_UNVERIFIED", field: "headers",
      expected: Object.keys(FIELDS).length, actual: columns.size, counts: { headers: snapshot.headers.length }, flags: { headerMatch: false } });
    if (registration.conflicted) issue("LIST_UNVERIFIED", { code: "DUPLICATE_SCOPE", flags: { conflicted: true } });
    if (snapshot.rows.length > 100_000) issue("COLLECTION_LIMIT", { code: "COLLECTION_LIMIT", expected: 100_000, actual: snapshot.rows.length });
    const rowIds = snapshot.rows.map(row => {
      const ids = [...new Set(row.ids)];
      return ids.length === 1 && /^\d{1,300}$/.test(ids[0]) ? ids[0] : null;
    });
    const occurrences = new Map<string, number>();
    for (const id of rowIds) if (id) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    for (const [index, row] of snapshot.rows.slice(0, 100_000).entries()) {
      result.scannedCount++;
      const record = index + 1;
      const id = rowIds[index];
      if (!id || occurrences.get(id)! > 1) {
        issue("RECORD_INVALID", { code: id ? "DUPLICATE_RECORD" : "RECORD_INVALID", record, field: "id",
          flags: { hasId: row.ids.some(Boolean) }, counts: { skipped: 1 } });
        continue;
      }
      try {
        const cell = (field: string, diagnosticField: DiagnosticEvent["field"]) => {
          const column = columns.get(field);
          const cells = column === undefined ? [] : row.cells.filter(value => value.column === column);
          if (cells.length !== 1 || cells[0].span !== 1) {
            issue("RECORD_INVALID", { code: "FIELD_INVALID", record, field: diagnosticField, expected: 1,
              actual: cells.length === 1 ? cells[0].span : cells.length, counts: { cells: row.cells.length } });
            return undefined;
          }
          return cells[0];
        };
        const text = (field: string, diagnosticField: DiagnosticEvent["field"] = "metadata") => {
          const value = cell(field, diagnosticField)?.text || null;
          if (value && value.length > 1_000_000) {
            issue("RECORD_INVALID", { code: "FIELD_INVALID", record, field: diagnosticField });
            return null;
          }
          return value;
        };
        const title = text(FIELDS.title, "title");
        const course = text(FIELDS.course, "course");
        if (!title || !course) {
          issue("RECORD_INVALID", { code: "RECORD_SKIPPED", record, flags: { hasTitle: !!title, hasCourse: !!course },
            counts: { skipped: 1 } });
          continue;
        }
        let dueDate: string | null = null;
        try { dueDate = assignmentDate(cell(FIELDS.dueDate, "dueDate")?.raw ?? ""); }
        catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          issue("RECORD_INVALID", { code: "FIELD_INVALID", record, field: "dueDate", errorType: diagnosticErrorType(error) });
        }
        const rawAttachments = cell(FIELDS.attachments, "attachments")?.raw ?? "";
        let attachmentCount: number | null = null;
        if (rawAttachments) {
          if (/^\d+$/.test(rawAttachments) && Number.isSafeInteger(Number(rawAttachments))) attachmentCount = Number(rawAttachments);
          else issue("RECORD_INVALID", { code: "FIELD_INVALID", record, field: "attachments" });
        }
        const scoreCell = cell(FIELDS.score, "mark");
        let scoreStatus = scoreCell?.status ?? null;
        if (scoreStatus && scoreStatus.length > 1_000_000) {
          scoreStatus = null;
          issue("RECORD_INVALID", { code: "FIELD_INVALID", record, field: "status" });
        }
        const assignment: CollectedAssignment = assignmentSchema.parse({
          id, title, course, section: text(FIELDS.section), teacher: text(FIELDS.teacher), dueDate, assignedDate: null,
          description: null, category: text(FIELDS.category), grade: text(FIELDS.grade, "mark"), score: text(FIELDS.score, "mark"),
          scoreStatus, maxScore: text(FIELDS.maxScore), weight: text(FIELDS.weight), attempts: text(FIELDS.attempts), attachmentCount,
          missing: kind === "missing" ? true : null, source: { portal: "skyward", url: ASSIGNMENTS_URL, capturedAt },
        });
        if (kind !== "past" || isAssignmentInWindow(assignment, window)) result.assignments.push(assignment);
      } catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        issue("RECORD_INVALID", { code: "RECORD_INVALID", record, errorType: diagnosticErrorType(error), counts: { skipped: 1 } });
      }
    }
    const expectedRows = snapshot.emptyMarkers === 1 && registration.recordCount === 1 ? 0 : registration.recordCount;
    if (registration.rowsPerPageCap !== null || snapshot.rows.length !== expectedRows ||
        (expectedRows === 0 ? snapshot.emptyMarkers !== 1 : snapshot.emptyMarkers !== 0)) {
      issue("PAGINATION_UNVERIFIED", { code: "PAGINATION_UNVERIFIED", expected: expectedRows, actual: snapshot.rows.length,
        flags: { capped: registration.rowsPerPageCap !== null, verifiedEmpty: snapshot.emptyMarkers === 1 } });
    }
    result.verifiedEmpty = !incomplete && expectedRows === 0;
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    issue("LIST_UNVERIFIED", { code: "SCOPE_FAILED", errorType: diagnosticErrorType(error) });
  }
  result.status = incomplete ? result.assignments.length ? "partial" : "failed" : "complete";
  return result;
}

export async function collectAssignments(page: Page, days: number, now = new Date(), timeout = 15_000): Promise<AssignmentRun> {
  const run: AssignmentRun = { runId: randomUUID(), capturedAt: now.toISOString(), window: dateWindow(days, now),
    parserVersion: 2, discoveryComplete: false, status: "failed", students: [] };
  const started = Date.now();
  const context = { runId: run.runId, parserVersion: run.parserVersion };
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "assignments", ...event });
  report({ level: "info", code: "RUN_STARTED" });
  const browses = observeBrowses(page, context, timeout);
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
    const discovery = await discoverSkywardStudents(page, "assignmentsList", timeout, context);
    const students = discovery.students;
    ordinals = discovery.ordinals;
    run.students = [...students.values()].map(student => ({ ...student, sections: KINDS.map(emptySection) }));
    run.discoveryComplete = discovery.complete;
    if (!students.size) return;
    if (run.discoveryComplete) run.warning = "NAVIGATION_FAILED";
    await page.locator('a[id="-assignmentsList_Widget"][data-studentid=""]').click({ timeout });
    await page.locator("#StudentAssignmentWrapper").waitFor({ state: "attached", timeout });
    const current = new URL(page.url());
    if (current.origin !== new URL(ASSIGNMENTS_URL).origin || current.pathname !== new URL(ASSIGNMENTS_URL).pathname) throw new Error();
    const allYear = page.getByLabel("All Year", { exact: true });
    let rangeVerified = false;
    try {
      if (!await allYear.isChecked()) {
        browses.reset();
        await allYear.check({ timeout });
      }
      rangeVerified = await allYear.isChecked();
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      report({ code: "STATE_UNKNOWN", field: "scope", errorType: diagnosticErrorType(error) });
    }
    await browses.wait(students.size * KINDS.length, timeout);
    if (rangeVerified) {
      try { rangeVerified = await allYear.isChecked(); }
      catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        rangeVerified = false;
        report({ code: "STATE_UNKNOWN", field: "scope", errorType: diagnosticErrorType(error) });
      }
    }
    if (!rangeVerified) report({ code: "PAGINATION_UNVERIFIED", field: "scope", flags: { matched: false } });
    const scopes = page.locator('#StudentAssignmentWrapper .template:has(> #StudentAssignments)');
    const scoped = await scopes.evaluateAll(elements => elements.map(element => ({
      id: element.querySelector<HTMLInputElement>('input[name="StudentID"]')?.value ?? "",
      browses: [...element.querySelectorAll(".browse[id]")].map(browse => browse.id),
    })));
    const scopeCounts = new Map<string, number>();
    const browseCounts = new Map<string, number>();
    for (const [index, scope] of scoped.entries()) {
      scopeCounts.set(scope.id, (scopeCounts.get(scope.id) ?? 0) + 1);
      for (const id of scope.browses) browseCounts.set(id, (browseCounts.get(id) ?? 0) + 1);
      if (!students.has(scope.id)) {
        run.discoveryComplete = false;
        report({ code: scope.id ? "STUDENT_BINDING_CONFLICT" : "STUDENT_BINDING_MISSING",
          student: ordinals.get(scope.id), record: index + 1, field: "student", flags: { matched: false } });
      }
    }
    for (const [index, id] of browses.ids().entries()) if (!browseCounts.has(id)) {
      run.discoveryComplete = false;
      report({ code: "SCOPE_MISSING", record: index + 1, field: "scope", flags: { matched: false } });
    }
    for (const student of run.students) {
      const studentContext = { ...context, student: ordinals.get(student.id) };
      const count = scopeCounts.get(student.id) ?? 0;
      if (count !== 1) {
        run.discoveryComplete = false;
        report({ code: count ? "DUPLICATE_SCOPE" : "STUDENT_BINDING_MISSING", student: studentContext.student,
          expected: 1, actual: count, flags: { conflicted: count > 1 } });
        student.sections.forEach(section => { section.warning = "STUDENT_UNVERIFIED"; });
        continue;
      }
      const scope = scopes.nth(scoped.findIndex(candidate => candidate.id === student.id));
      for (const [sectionIndex, kind] of KINDS.entries()) {
        try {
          const browse = scope.locator(`.browse[id^="${PREFIXES[kind]}"]`);
          const count = await browse.count();
          if (count !== 1) {
            report({ code: count ? "DUPLICATE_SCOPE" : "SCOPE_MISSING", section: kind, student: studentContext.student,
              expected: 1, actual: count });
            continue;
          }
          const id = await browse.getAttribute("id");
          if (id && browseCounts.get(id)! > 1) {
            student.sections[sectionIndex].warning = "STUDENT_UNVERIFIED";
            report({ code: "STUDENT_BINDING_CONFLICT", section: kind, student: studentContext.student,
              expected: 1, actual: browseCounts.get(id), flags: { conflicted: true } });
            continue;
          }
          const section = await readAssignmentSection(browse, id ? browses.find(id) : undefined,
            kind, run.window, new Date().toISOString(), timeout, studentContext);
          if (!rangeVerified) {
            section.status = section.assignments.length ? "partial" : "failed";
            section.verifiedEmpty = false;
            section.warning ??= "PAGINATION_UNVERIFIED";
          }
          student.sections[sectionIndex] = section;
        } catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          report({ code: "SCOPE_FAILED", section: kind, student: studentContext.student, errorType: diagnosticErrorType(error) });
        }
      }
      const missing = student.sections.find(section => section.kind === "missing")!;
      if (missing.status === "complete") {
        const missingIds = new Set(missing.assignments.map(assignment => assignment.id));
        for (const section of student.sections) for (const assignment of section.assignments) assignment.missing = missingIds.has(assignment.id);
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
      for (const student of run.students) for (const section of student.sections) {
        if (section.status !== "complete") { section.status = "auth-required"; section.warning = "AUTH_REQUIRED"; }
      }
    }
  } finally { await browses.close(); }
  if (run.status !== "auth-required") {
    if (browses.unverified()) run.discoveryComplete = false;
    if (!run.discoveryComplete) run.warning = "STUDENT_DISCOVERY_UNVERIFIED";
    const sections = run.students.flatMap(student => student.sections);
    run.status = run.discoveryComplete && run.students.length > 0 && sections.every(section => section.status === "complete") ? "complete" :
      sections.some(section => section.status === "complete" || section.assignments.length > 0) ? "partial" : "failed";
  }
  const parsed = assignmentRunSchema.parse(run);
  for (const student of parsed.students) for (const section of student.sections) {
    report({ level: "info", code: "SECTION_SUMMARY", section: section.kind, student: ordinals.get(student.id), status: section.status,
      counts: { scanned: section.scannedCount, accepted: section.assignments.length, pages: section.pages },
      flags: { verifiedEmpty: section.verifiedEmpty } });
  }
  report({ level: "info", code: "RUN_SUMMARY", status: parsed.status, durationMs: Math.max(0, Date.now() - started),
    counts: { students: parsed.students.length, accepted: parsed.students.reduce((count, student) =>
      count + student.sections.reduce((count, section) => count + section.assignments.length, 0), 0) },
    flags: { discoveryComplete: parsed.discoveryComplete } });
  return parsed;
}

export async function collectAssignmentsToStore(page: Page, store: Pick<AssignmentStore, "importAssignmentRun">,
  accountId: string, days: number, now = new Date(), timeout = 15_000): Promise<AssignmentRun> {
  const run = await collectAssignments(page, days, now, timeout);
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", portal: "skyward", section: "assignments",
    stage: "DATABASE_WRITE", runId: run.runId });
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
  withLocalDiagnostics(path.resolve(__dirname, "../../.."), "skyward:assignments", main).catch((error: unknown) => {
    console.error(error instanceof DiagnosticLogError ? `LOCAL_LOG: ${error.message}` :
      error instanceof AssignmentUsageError ? `ASSIGNMENTS: ${error.message} No portal access was attempted.` :
      "ASSIGNMENTS: Collection or storage failed. Check the existing database, original key, private permissions, and session. Renew locally with skyward:login if expired. Private error details withheld.");
    process.exitCode = 1;
  });
}