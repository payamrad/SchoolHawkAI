import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { compile } from "html-to-text";
import LinkHeader from "http-link-header";
import { z } from "zod";
import { accountAliasSchema, canvasAssignmentRunSchema, canvasAssignmentSchema, pacificDate,
  type CanvasAssignment, type CanvasAssignmentRun, type CanvasCourse, type CanvasWarning } from "@schoolhawk/core/canvas-assignments";
import portalConfig from "../../../config/portals.json";
import { confirmLogin } from "./canvas-login";
import type { CanvasAssignmentStore } from "@schoolhawk/storage/canvas-assignments";
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
interface PageResult<Value> { records: Value[]; pages: number; complete: boolean; warning?: CanvasWarning }

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
  budget: ReadBudget, timeout: number, maxRecords = 100_000): Promise<PageResult<Value>> {
  const result: PageResult<Value> = { records: [], pages: 0, complete: false };
  const visited = new Set<string>();
  const identities = new Set<string>();
  let next: string | undefined = initial;
  while (next) {
    if (budget.halted) { result.warning = budget.halted; return result; }
    if (budget.requests >= 500 || Date.now() >= budget.deadline || result.pages >= 50) {
      result.warning = "COLLECTION_LIMIT"; budget.halted = result.warning; return result;
    }
    let url: string;
    try { url = validateCanvasPageUrl(next, initial); }
    catch { result.warning = "PAGINATION_INVALID"; return result; }
    if (visited.has(url)) { result.warning = "PAGINATION_INVALID"; return result; }
    visited.add(url);
    budget.requests++;
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
      if (response.status !== 200) {
        result.warning = response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "PERMISSION_DENIED" :
          response.status === 429 ? "RATE_LIMITED" : response.status === 0 ? "REQUEST_FAILED" : "HTTP_ERROR";
        if (response.status === 401 || response.status === 429) budget.halted = result.warning;
        return result;
      }
      if (!response.json) { result.warning = "RESPONSE_INVALID"; return result; }
      const records = z.array(schema).max(1000).parse(JSON.parse(response.text));
      if (result.records.length + records.length > maxRecords) { result.warning = "COLLECTION_LIMIT"; return result; }
      for (const record of records) {
        if (identities.has(record.id)) { result.warning = "PAGINATION_INVALID"; return result; }
        identities.add(record.id);
        result.records.push(record);
      }
      result.pages++;
      try {
        const links = response.link ? LinkHeader.parse(response.link).rel("next") : [];
        if (links.length > 1) throw new Error();
        next = links[0]?.uri;
        if (next) validateCanvasPageUrl(next, initial);
      } catch { result.warning = "PAGINATION_INVALID"; return result; }
    } catch { result.warning = "RESPONSE_INVALID"; return result; }
  }
  result.complete = true;
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
  const run: CanvasAssignmentRun = { runId: randomUUID(), capturedAt: now.toISOString(), parserVersion: 1,
    status: "failed", discoveryComplete: false, students: [] };
  const budget: ReadBudget = { requests: 0, deadline: Date.now() + 300_000 };
  try { await confirmLogin(page, process.env.CANVAS_SUCCESS_SELECTOR, timeout); }
  catch { return { ...run, status: "auth-required", warning: "AUTH_REQUIRED" }; }
  const roster = await readCanvasPages(page, "/api/v1/users/self/observees?per_page=100", studentSchema, budget, timeout, 100);
  run.discoveryComplete = roster.complete;
  if (roster.warning) run.warning = roster.warning;
  for (const student of roster.records) {
    const result: CanvasAssignmentRun["students"][number] = { id: student.id, name: student.name, sortableName: student.sortable_name ?? null,
      status: "failed", discoveryComplete: false, courses: [] };
    run.students.push(result);
    const courses = await readCanvasPages(page, `/api/v1/users/${student.id}/courses?enrollment_state=active&per_page=100`, courseSchema, budget, timeout, 200);
    result.discoveryComplete = courses.complete;
    if (courses.warning) result.warning = courses.warning;
    for (const course of courses.records) {
      const observation: CanvasCourse = { id: course.id, name: course.name, code: course.course_code ?? null, termId: course.enrollment_term_id ?? null,
        status: "failed", assignments: [], pages: 0, scannedCount: 0, verifiedEmpty: false };
      result.courses.push(observation);
      const assignments = await readCanvasPages(page, `/api/v1/users/${student.id}/courses/${course.id}/assignments?per_page=100`, assignmentSchema, budget, timeout);
      observation.pages = assignments.pages;
      observation.scannedCount = assignments.records.length;
      if (assignments.warning) observation.warning = assignments.warning;
      try {
        const capturedAt = new Date().toISOString();
        for (const assignment of assignments.records) observation.assignments.push(normalizeCanvasAssignment(assignment, course.id, capturedAt));
        observation.status = assignments.complete ? "complete" : assignments.warning === "AUTH_REQUIRED" ? "auth-required" : observation.assignments.length ? "partial" : "failed";
        observation.verifiedEmpty = assignments.complete && observation.assignments.length === 0;
      } catch { observation.status = observation.assignments.length ? "partial" : "failed"; observation.warning = "RESPONSE_INVALID"; }
    }
    result.status = result.discoveryComplete && result.courses.every(course => course.status === "complete") ? "complete" :
      budget.halted === "AUTH_REQUIRED" ? "auth-required" : result.courses.some(course => course.status === "complete" || course.assignments.length) ? "partial" : "failed";
  }
  run.status = run.discoveryComplete && run.students.every(student => student.status === "complete") ? "complete" :
    budget.halted === "AUTH_REQUIRED" ? "auth-required" : run.students.some(student => student.status === "complete" || student.courses.some(course => course.assignments.length)) ? "partial" : "failed";
  return canvasAssignmentRunSchema.parse(run);
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
  store.importCanvasAssignmentRun(accountId, run);
  return run;
}

async function main(): Promise<void> {
  let options;
  try { options = parseCanvasAssignmentOptions(process.argv.slice(2)); }
  catch {
    console.error("CANVAS: Use npm run canvas:assignments -- --account <alias>. No portal access was attempted.");
    process.exitCode = 1;
    return;
  }
  const { result, database } = await withPortalCollection("canvas", (page, store) => collectCanvasAssignmentsToStore(page, store, options.accountId));
  console.log(JSON.stringify({ ...canvasAssignmentSummary(result), database }, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error("CANVAS: Collection or storage failed. Check private database/key paths and renew the saved session with canvas:login. Private details withheld.");
    process.exitCode = 1;
  });
}