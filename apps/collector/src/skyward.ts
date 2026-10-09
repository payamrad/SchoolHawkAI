import type { Page } from "playwright";
import { z } from "zod";
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

export async function discoverSkywardStudents(page: Page, widget: "assignmentsList" | "studentGrades", timeout: number): Promise<Map<string, SkywardStudent>> {
  await page.locator(`a[id="-${widget}_Widget"][data-studentid=""]`).waitFor({ timeout });
  const candidates = await page.locator('.familyAccessHeaderSelectTile[data-studentid]').evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute("data-studentid") ?? "",
    parts: [...element.querySelectorAll(".familyAccessStudentNameText")].map(part => part.textContent ?? ""),
  })).filter(student => student.id));
  const students = new Map<string, SkywardStudent>();
  for (const candidate of candidates) {
    const student = { id: candidate.id, ...parseStudentName(candidate.parts) };
    if (!/^\d+$/.test(student.id) || (students.has(student.id) && students.get(student.id)!.name !== student.name)) {
      throw new Error("Unverified student identity.");
    }
    students.set(student.id, student);
  }
  const widgetIds = await page.locator(`a[id$="-${widget}_Widget"][data-studentid]`).evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-studentid")!).filter(Boolean));
  if (!students.size || students.size > 100 || new Set(widgetIds).size !== students.size || widgetIds.some(id => !students.has(id))) {
    throw new Error("Unverified student coverage.");
  }
  return students;
}