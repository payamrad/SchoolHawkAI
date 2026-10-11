import type { Page } from "playwright";
import { z } from "zod";
import { DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import type { MessageRun } from "@schoolhawk/core/messages";
import type { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { readPortalSession, withPortalCollection, type CollectionOptions } from "./portal-collection";

export const SKYWARD_TIME_ZONE = "America/Los_Angeles";

export function readSkywardSession(root?: string, onStage?: (stage: string) => void) {
  return readPortalSession("skyward", root, onStage);
}

export async function withSkywardCollection<Result>(operation: (page: Page, store: SqliteMessageStore) => Promise<Result>,
  options: CollectionOptions = {}): Promise<{ result: Result; database: string }> {
  return withPortalCollection("skyward", operation, options);
}

export function dateWindow(days: number, now = new Date()): MessageRun["window"] {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("N must be an integer between 1 and 366.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SKYWARD_TIME_ZONE, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;
  const endDate = `${year}-${month}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("Cannot determine Pacific calendar date.");
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { days, startDate: start.toISOString().slice(0, 10), endDate, timeZone: SKYWARD_TIME_ZONE };
}

const registrationSchema = z.object({
  browseName: z.string().min(1),
  recordCount: z.number().int().min(0).max(100_000), rowsPerPageCap: z.number().int().positive().nullable(),
});

export function parseBrowseRegistration(script: string) {
  if (script.length > 20_000_000) throw new Error("Browse metadata exceeds limit.");
  const match = /^\s*skyward\.browse\.registerBrowse\(([\s\S]+)\);?\s*$/.exec(script);
  if (!match) throw new Error("Unrecognized browse metadata.");
  return registrationSchema.parse(JSON.parse(match[1]));
}

export function parseStudentName(parts: string[]): { name: string; firstName: string; lastName: string } {
  const label = parts.map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  const match = /^([^,]+),([^,]+)$/.exec(label);
  const lastName = match?.[1].trim();
  const firstName = match?.[2].trim();
  if (!firstName || !lastName) throw new Error("Unverified student name format.");
  return { name: `${lastName}, ${firstName}`, firstName, lastName };
}

export type SkywardStudent = ReturnType<typeof parseStudentName> & { id: string };

export async function discoverSkywardStudents(page: Page, widget: "assignmentsList" | "studentGrades", timeout: number,
  context: Pick<DiagnosticEvent, "runId" | "parserVersion"> = {},
): Promise<{ students: Map<string, SkywardStudent>; complete: boolean; ordinals: Map<string, number> }> {
  const students = new Map<string, SkywardStudent>();
  const ordinals = new Map<string, number>();
  const conflicted = new Set<string>();
  let complete = true;
  const report = (event: DiagnosticEvent) => reportDiagnostic({ ...context, portal: "skyward", section: "students", ...event });
  try {
    await page.locator(`a[id="-${widget}_Widget"][data-studentid=""]`).waitFor({ timeout });
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    complete = false;
    report({ code: "SCOPE_MISSING", field: "scope", errorType: diagnosticErrorType(error) });
  }
  let candidates: { id: string; parts: string[] }[] = [];
  try {
    candidates = await page.locator('.familyAccessHeaderSelectTile[data-studentid]').evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute("data-studentid") ?? "",
      parts: [...element.querySelectorAll(".familyAccessStudentNameText")].map(part => part.textContent ?? ""),
    })));
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    complete = false;
    report({ code: "SCOPE_FAILED", errorType: diagnosticErrorType(error) });
  }
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.id) continue;
    const ordinal = index + 1;
    if (!/^\d{1,300}$/.test(candidate.id)) {
      complete = false;
      report({ code: "STUDENT_RECORD_INVALID", student: ordinal, field: "id", flags: { hasId: true } });
      continue;
    }
    if (!ordinals.has(candidate.id)) ordinals.set(candidate.id, ordinal);
    try {
      const student = { id: candidate.id, ...parseStudentName(candidate.parts) };
      if ([student.name, student.firstName, student.lastName].some(value => value.length > 1_000_000)) throw new Error();
      const previous = students.get(student.id);
      if (conflicted.has(student.id) || (previous && previous.name !== student.name)) {
        complete = false;
        students.delete(student.id);
        conflicted.add(student.id);
        report({ code: "STUDENT_BINDING_CONFLICT", student: ordinals.get(student.id), record: ordinal,
          field: "name", flags: { conflicted: true } });
        continue;
      }
      if (previous) {
        report({ level: "info", code: "DUPLICATE_STUDENT", student: ordinals.get(student.id), record: ordinal,
          flags: { conflicted: false } });
      } else students.set(student.id, student);
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      complete = false;
      students.delete(candidate.id);
      conflicted.add(candidate.id);
      report({ code: "STUDENT_RECORD_INVALID", student: ordinal, field: "name", errorType: diagnosticErrorType(error) });
    }
  }
  if (students.size > 100) {
    complete = false;
    report({ code: "COLLECTION_LIMIT", expected: 100, actual: students.size });
    for (const [index, id] of [...students.keys()].entries()) if (index >= 100) {
      students.delete(id);
      report({ code: "RECORD_SKIPPED", student: ordinals.get(id), field: "student" });
    }
  }
  let widgetIds: string[] = [];
  try {
    widgetIds = await page.locator(`a[id$="-${widget}_Widget"][data-studentid]`).evaluateAll(elements =>
      elements.map(element => element.getAttribute("data-studentid")!).filter(Boolean));
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    complete = false;
    report({ code: "SCOPE_FAILED", field: "scope", errorType: diagnosticErrorType(error) });
  }
  const widgets = new Set(widgetIds);
  for (const id of students.keys()) if (!widgets.has(id)) {
    complete = false;
    report({ code: "STUDENT_BINDING_MISSING", student: ordinals.get(id), field: "student" });
  }
  for (const [index, id] of widgetIds.entries()) if (!students.has(id)) {
    complete = false;
    report({ code: "STUDENT_BINDING_MISSING", student: ordinals.get(id), record: index + 1,
      field: "student", flags: { matched: false } });
  }
  if (!students.size) complete = false;
  if (!complete) {
    report({ code: "STUDENT_DISCOVERY_UNVERIFIED", counts: { scanned: candidates.length, accepted: students.size,
      students: widgets.size }, flags: { discoveryComplete: false } });
  }
  return { students, complete, ordinals };
}