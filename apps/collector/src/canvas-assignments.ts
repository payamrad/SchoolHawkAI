import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { compile } from "html-to-text";
import LinkHeader from "http-link-header";
import { z } from "zod";
import { accountAliasSchema, canvasAssignmentRunSchema, canvasAssignmentSchema, pacificDate,
  type CanvasAssignment, type CanvasAssignmentRun, type CanvasCourse, type CanvasWarning } from "@schoolhawk/core/canvas-assignments";
import { DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import portalConfig from "../../../config/portals.json";
import { confirmLogin } from "./canvas-login";
import type { CanvasAssignmentStore } from "@schoolhawk/storage/canvas-assignments";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { withPortalCollection } from "./portal-collection";

export const CANVAS_ORIGIN = new URL(portalConfig.portals.canvas.urls.login).origin;
const apiId = z.union([z.number().int().positive().safe(), z.string().regex(/^\d+$/).max(100)]).transform(String);
const apiText = z.string().min(1).max(1_000_000);
const apiTimestamp = z.iso.datetime({ offset: true }).nullable().optional();
const studentSchema = z.object({ id: apiId, name: apiText, sortable_name: apiText.nullable().optional() });
const courseSchema = z.object({ id: apiId, name: apiText, course_code: apiText.nullable().optional(), enrollment_term_id: apiId.nullable().optional() });
const assignmentSchema = z.object({
  id: apiId, course_id: apiId, name: apiText, description: z.string().max(1_000_000).nullable().optional(),
  due_at: apiTimestamp, unlock_at: apiTimestamp, lock_at: apiTimestamp, created_at: apiTimestamp, updated_at: apiTimestamp,
  points_possible: z.number().finite().nonnegative().nullable().optional(), grading_type: apiText.nullable().optional(),
  submission_types: z.array(apiText).max(30), allowed_extensions: z.array(apiText).max(100).optional(),
  locked_for_user: z.boolean().optional(), has_overrides: z.boolean().nullable().optional(),
});
const descriptionText = compile({ wordwrap: false, limits: { maxInputLength: 1_000_000 }, selectors: [
  { selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" },
  { selector: "script", format: "skip" }, { selector: "style", format: "skip" },
  { selector: "iframe", format: "skip" }, { selector: "form", format: "skip" },
] });

export function parseCanvasAssignmentOptions(args: string[]): { accountId: string } {
  try {
    const { values } = parseArgs({ args, options: { account: { type: "string" } }, allowPositionals: false });
    if (args.filter(arg => arg === "--account" || arg.startsWith("--account=")).length !== 1) throw new Error();
    return { accountId: accountAliasSchema.parse(values.account) };
  } catch { throw new Error("Use npm run canvas:assignments -- --account <alias>. Collects full active-course assignment snapshots."); }
}

interface ReadBudget { requests: number; deadline: number; halted?: CanvasWarning }
interface RecordLocation { page: number; record: number }
interface PageResult<Value> {
  records: Value[]; locations: RecordLocation[]; pages: number; scannedCount: number; complete: boolean; warning?: CanvasWarning;
}
interface ReadContext {
  runId: string; section: "students" | "courses" | "assignments"; student?: number; course?: number;
}

function invalidCanvasField(error: z.ZodError): DiagnosticEvent["field"] {
  switch (error.issues[0]?.path[0]) {
    case "id": return "id";
    case "name": return "name";
    case "course_id": return "course";
    case "due_at": return "dueAt";
    case "unlock_at": case "lock_at": case "created_at": case "updated_at": return "date";
    default: return "metadata";
  }
}

export function validateCanvasPageUrl(value: string, initial: string): string {
  const expected = new URL(initial, CANVAS_ORIGIN);
  const url = new URL(value, CANVAS_ORIGIN);
  if (url.origin !== CANVAS_ORIGIN || url.username || url.password || url.hash || url.pathname !== expected.pathname ||
      !/^\/api\/v1\/users\/(?:self\/observees|\d+\/courses(?:\/\d+\/assignments)?)$/.test(url.pathname)) throw new Error();
  const filterNames = [...new Set([...expected.searchParams.keys()].filter(key => key !== "page" && key !== "per_page"))];
  for (const key of url.searchParams.keys()) if (!["page", "per_page", ...filterNames].includes(key)) throw new Error();
  for (const key of ["page", "per_page"]) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1 || (values.length && !/^\d+$/.test(values[0]))) throw new Error();
  }
  for (const key of filterNames) if (JSON.stringify(url.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key))) throw new Error();
  url.searchParams.sort();
  return url.href;
}

export async function readCanvasPages<Value extends { id: string }>(page: Page, initial: string, schema: z.ZodType<Value>,
  budget: ReadBudget, timeout: number, maxRecords = 100_000,
  context: ReadContext = { runId: randomUUID(), section: "assignments" }): Promise<PageResult<Value>> {
  const result: PageResult<Value> = { records: [], locations: [], pages: 0, scannedCount: 0, complete: false };
  const visited = new Set<string>();
  const identities = new Set<string>();
  let currentPage = 0;
  const warn = (warning: CanvasWarning, details: Partial<DiagnosticEvent> = {}) => {
    result.warning = warning;
    reportDiagnostic({ portal: "canvas", ...context, code: warning === "COURSE_DISCOVERY_UNVERIFIED" ? "SCOPE_MISSING" : warning,
      page: currentPage, ...details });
  };
  let next: string | undefined = initial;
  while (next) {
    currentPage = result.pages + 1;
    if (budget.halted) { warn(budget.halted); return result; }
    if (budget.requests >= 500 || Date.now() >= budget.deadline || result.pages >= 50) {
      budget.halted = "COLLECTION_LIMIT";
      warn("COLLECTION_LIMIT", { counts: { requests: budget.requests, pages: result.pages }, flags: { capped: true } });
      return result;
    }
    if (result.scannedCount >= maxRecords) {
      warn("COLLECTION_LIMIT", { counts: { scanned: result.scannedCount }, flags: { capped: true } });
      return result;
    }
    let url: string;
    try { url = validateCanvasPageUrl(next, initial); }
    catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      warn("PAGINATION_INVALID", { field: "pagination", errorType: diagnosticErrorType(error) });
      return result;
    }
    if (visited.has(url)) { warn("PAGINATION_INVALID", { field: "pagination" }); return result; }
    visited.add(url);
    budget.requests++;
    let failure: CanvasWarning = "REQUEST_FAILED";
    try {
      const response = await page.evaluate(async ({ url, timeout }) => {
        try {
          const response = await fetch(url, { method: "GET", credentials: "same-origin", redirect: "error",
            headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
          if (!response.ok) return { status: response.status, text: "", link: "", json: false };
          if (Number(response.headers.get("content-length")) > 20_000_000) return { status: 200, text: "", link: "", json: false };
          if (!response.body) return { status: 200, text: "", link: "", json: false };
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0;
          let text = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 20_000_000) { await reader.cancel(); return { status: 200, text: "", link: "", json: false }; }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          return { status: response.status, text, link: response.headers.get("link") ?? "",
            json: (response.headers.get("content-type") ?? "").includes("application/json") };
        } catch { return { status: 0, text: "", link: "", json: false }; }
      }, { url, timeout: Math.max(1, Math.min(timeout, budget.deadline - Date.now())) });
      failure = "RESPONSE_INVALID";
      if (response.status !== 200) {
        const warning = response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "PERMISSION_DENIED" :
          response.status === 429 ? "RATE_LIMITED" : response.status === 0 ? "REQUEST_FAILED" : "HTTP_ERROR";
        if (response.status === 401 || response.status === 429) budget.halted = warning;
        warn(warning, { httpStatus: response.status >= 100 && response.status <= 599 ? response.status : undefined });
        return result;
      }
      if (!response.json) { warn("RESPONSE_INVALID", { field: "response" }); return result; }
      const records = z.array(z.unknown()).max(1000).parse(JSON.parse(response.text));
      result.pages++;
      const scannedBefore = result.scannedCount;
      const acceptedBefore = result.records.length;
      let duplicates = 0;
      const pageSummary = (capped = false) => reportDiagnostic({
        level: "info", code: "SECTION_SUMMARY", portal: "canvas", ...context, page: currentPage,
        status: capped || result.scannedCount - scannedBefore !== result.records.length - acceptedBefore ? "partial" : "complete",
        counts: { scanned: result.scannedCount - scannedBefore, accepted: result.records.length - acceptedBefore,
          skipped: result.scannedCount - scannedBefore - (result.records.length - acceptedBefore), duplicates },
        flags: { capped },
      });
      for (const input of records) {
        if (result.scannedCount >= maxRecords) {
          pageSummary(true);
          warn("COLLECTION_LIMIT", { counts: { scanned: result.scannedCount }, flags: { capped: true } });
          return result;
        }
        result.scannedCount++;
        const location = { page: currentPage, record: result.scannedCount };
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          warn("RESPONSE_INVALID", { ...location, code: context.section === "students" ? "STUDENT_RECORD_INVALID" : "RECORD_INVALID",
            field: invalidCanvasField(parsed.error), errorType: diagnosticErrorType(parsed.error) });
          continue;
        }
        if (identities.has(parsed.data.id)) {
          duplicates++;
          warn("PAGINATION_INVALID", { ...location, code: context.section === "students" ? "DUPLICATE_STUDENT" : "DUPLICATE_RECORD", field: "id" });
          continue;
        }
        identities.add(parsed.data.id);
        result.records.push(parsed.data);
        result.locations.push(location);
      }
      pageSummary();
      try {
        const links = response.link ? LinkHeader.parse(response.link).rel("next") : [];
        if (links.length > 1) throw new Error();
        next = links[0]?.uri;
        if (next) validateCanvasPageUrl(next, initial);
      } catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        warn("PAGINATION_INVALID", { field: "pagination", errorType: diagnosticErrorType(error) });
        return result;
      }
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      warn(failure, { field: "response", errorType: diagnosticErrorType(error) });
      return result;
    }
  }
  result.complete = result.warning === undefined;
  return result;
}

export function normalizeCanvasAssignment(input: unknown, courseId: string, capturedAt: string): CanvasAssignment {
  const assignment = assignmentSchema.parse(input);
  if (assignment.course_id !== courseId) throw new Error("Canvas course identity mismatch.");
  return canvasAssignmentSchema.parse({
    id: assignment.id, courseId, title: assignment.name, description: assignment.description ? descriptionText(assignment.description).trim() || null : null,
    dueAt: assignment.due_at ?? null, dueDate: assignment.due_at ? pacificDate(assignment.due_at) : null,
    unlockAt: assignment.unlock_at ?? null, lockAt: assignment.lock_at ?? null, createdAt: assignment.created_at ?? null,
    updatedAt: assignment.updated_at ?? null, pointsPossible: assignment.points_possible ?? null, gradingType: assignment.grading_type ?? null,
    submissionTypes: assignment.submission_types, allowedExtensions: assignment.allowed_extensions ?? [],
    externalTool: assignment.submission_types.includes("external_tool"), lockedForUser: assignment.locked_for_user ?? null,
    hasOverrides: assignment.has_overrides ?? null,
    source: { portal: "canvas", url: `${CANVAS_ORIGIN}/courses/${courseId}/assignments/${assignment.id}`, capturedAt, dateScope: "student" },
  });
}

export async function collectCanvasAssignments(page: Page, now = new Date(), timeout = 15_000): Promise<CanvasAssignmentRun> {
  const startedAt = Date.now();
  const run: CanvasAssignmentRun = { runId: randomUUID(), capturedAt: now.toISOString(), parserVersion: 1,
    status: "failed", discoveryComplete: false, students: [] };
  const budget: ReadBudget = { requests: 0, deadline: Date.now() + 300_000 };
  reportDiagnostic({ level: "info", code: "RUN_STARTED", portal: "canvas", section: "assignments", runId: run.runId, parserVersion: run.parserVersion });
  const finish = () => {
    const parsed = canvasAssignmentRunSchema.parse(run);
    const courses = run.students.flatMap(student => student.courses);
    const scanned = courses.reduce((count, course) => count + course.scannedCount, 0);
    const accepted = courses.reduce((count, course) => count + course.assignments.length, 0);
    reportDiagnostic({ level: run.status === "complete" ? "info" : "warn", code: "RUN_SUMMARY", portal: "canvas",
      section: "assignments", runId: run.runId, status: run.status, durationMs: Math.max(0, Date.now() - startedAt),
      counts: { students: run.students.length, courses: courses.length, scanned, accepted, skipped: scanned - accepted,
        pages: courses.reduce((count, course) => count + course.pages, 0), requests: budget.requests },
      flags: { discoveryComplete: run.discoveryComplete } });
    return parsed;
  };
  try { await confirmLogin(page, process.env.CANVAS_SUCCESS_SELECTOR, timeout); }
  catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    run.status = "auth-required";
    run.warning = "AUTH_REQUIRED";
    reportDiagnostic({ code: "AUTH_REQUIRED", portal: "canvas", section: "session", runId: run.runId, errorType: diagnosticErrorType(error) });
    return finish();
  }
  const roster = await readCanvasPages(page, "/api/v1/users/self/observees?per_page=100", studentSchema, budget, timeout, 100,
    { runId: run.runId, section: "students" });
  run.discoveryComplete = roster.complete;
  if (roster.warning) run.warning = roster.warning;
  for (const [studentIndex, student] of roster.records.entries()) {
    const studentOrdinal = roster.locations[studentIndex].record;
    const result: CanvasAssignmentRun["students"][number] = { id: student.id, name: student.name, sortableName: student.sortable_name ?? null,
      status: "failed", discoveryComplete: false, courses: [] };
    run.students.push(result);
    const courses = await readCanvasPages(page, `/api/v1/users/${student.id}/courses?enrollment_state=active&per_page=100`, courseSchema, budget, timeout, 200,
      { runId: run.runId, section: "courses", student: studentOrdinal });
    result.discoveryComplete = courses.complete;
    if (courses.warning) result.warning = courses.warning;
    for (const [courseIndex, course] of courses.records.entries()) {
      const context: ReadContext = { runId: run.runId, section: "assignments", student: studentOrdinal, course: courses.locations[courseIndex].record };
      const observation: CanvasCourse = { id: course.id, name: course.name, code: course.course_code ?? null, termId: course.enrollment_term_id ?? null,
        status: "failed", assignments: [], pages: 0, scannedCount: 0, verifiedEmpty: false };
      result.courses.push(observation);
      const assignments = await readCanvasPages(page, `/api/v1/users/${student.id}/courses/${course.id}/assignments?per_page=100`, assignmentSchema, budget, timeout, 100_000, context);
      observation.pages = assignments.pages;
      observation.scannedCount = assignments.scannedCount;
      if (assignments.warning) observation.warning = assignments.warning;
      let normalized = true;
      const capturedAt = new Date().toISOString();
      for (const [assignmentIndex, assignment] of assignments.records.entries()) {
        try { observation.assignments.push(normalizeCanvasAssignment(assignment, course.id, capturedAt)); }
        catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          normalized = false;
          observation.warning ??= "RESPONSE_INVALID";
          reportDiagnostic({ code: "RECORD_INVALID", portal: "canvas", ...context, ...assignments.locations[assignmentIndex],
            field: assignment.course_id !== course.id ? "course" : "metadata", errorType: diagnosticErrorType(error) });
        }
      }
      observation.status = assignments.complete && normalized ? "complete" : assignments.warning === "AUTH_REQUIRED" ? "auth-required" :
        observation.assignments.length ? "partial" : "failed";
      observation.verifiedEmpty = observation.status === "complete" && observation.scannedCount === 0;
      reportDiagnostic({ level: observation.status === "complete" ? "info" : "warn", code: "SECTION_SUMMARY", portal: "canvas", ...context,
        status: observation.status, counts: { scanned: observation.scannedCount, accepted: observation.assignments.length,
          skipped: observation.scannedCount - observation.assignments.length, pages: observation.pages }, flags: { verifiedEmpty: observation.verifiedEmpty } });
    }
    result.status = result.discoveryComplete && result.courses.every(course => course.status === "complete") ? "complete" :
      budget.halted === "AUTH_REQUIRED" ? "auth-required" : result.courses.some(course => course.status === "complete" || course.assignments.length) ? "partial" : "failed";
  }
  run.status = run.discoveryComplete && run.students.every(student => student.status === "complete") ? "complete" :
    budget.halted === "AUTH_REQUIRED" ? "auth-required" : run.students.some(student => student.status === "complete" || student.status === "partial") ? "partial" : "failed";
  return finish();
}

export function canvasAssignmentSummary(run: CanvasAssignmentRun) {
  return { runId: run.runId, capturedAt: run.capturedAt, status: run.status, discoveryComplete: run.discoveryComplete, warning: run.warning,
    students: run.students.map((student, index) => ({ student: index + 1, status: student.status, discoveryComplete: student.discoveryComplete,
      warning: student.warning, courses: student.courses.map((course, courseIndex) => ({ course: courseIndex + 1, status: course.status,
        assignments: course.assignments.length, pages: course.pages, verifiedEmpty: course.verifiedEmpty, warning: course.warning })) })) };
}

export async function collectCanvasAssignmentsToStore(page: Page, store: Pick<CanvasAssignmentStore, "importCanvasAssignmentRun">,
  accountId: string, now = new Date(), timeout = 15_000): Promise<CanvasAssignmentRun> {
  const run = await collectCanvasAssignments(page, now, timeout);
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", portal: "canvas", section: "assignments",
    stage: "DATABASE_WRITE", runId: run.runId });
  store.importCanvasAssignmentRun(accountId, run);
  return run;
}

async function main(): Promise<void> {
  let options;
  try { options = parseCanvasAssignmentOptions(process.argv.slice(2)); }
  catch {
    reportDiagnostic({ level: "error", code: "COMMAND_FAILED", stage: "CONFIGURATION", errorType: "validation" });
    console.error("CANVAS: Use npm run canvas:assignments -- --account <alias>. No portal access was attempted.");
    process.exitCode = 1;
    return;
  }
  const { result, database } = await withPortalCollection("canvas", (page, store) => collectCanvasAssignmentsToStore(page, store, options.accountId));
  console.log(JSON.stringify({ ...canvasAssignmentSummary(result), database }, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}

if (require.main === module) {
  withLocalDiagnostics(path.resolve(__dirname, "../../.."), "canvas:assignments", main).catch((error: unknown) => {
    console.error(error instanceof DiagnosticLogError ? `LOCAL_LOG: ${error.message}` :
      "CANVAS: Collection or storage failed. Check private database/key paths and renew the saved session with canvas:login. Private details withheld.");
    process.exitCode = 1;
  });
}