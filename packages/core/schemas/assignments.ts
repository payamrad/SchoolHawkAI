import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const text = z.string().min(1).max(1_000_000);
const identity = z.string().min(1).max(300);

export const assignmentWindowSchema = z.object({
  days: z.number().int().min(1).max(366),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  timeZone: z.literal("America/Los_Angeles"),
}).refine(window =>
  (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000 + 1 === window.days,
{ message: "Inconsistent assignment lookback window." });

export type AssignmentWindow = z.infer<typeof assignmentWindowSchema>;

export const assignmentSchema = z.object({
  id: identity,
  title: text,
  course: text,
  section: text.nullable(),
  teacher: text.nullable(),
  dueDate: z.iso.date().nullable(),
  assignedDate: z.iso.date().nullable(),
  description: text.nullable(),
  category: text.nullable(),
  grade: text.nullable(),
  score: text.nullable(),
  scoreStatus: text.nullable(),
  maxScore: text.nullable(),
  weight: text.nullable(),
  attempts: text.nullable(),
  attachmentCount: z.number().int().nonnegative().nullable(),
  missing: z.boolean().nullable(),
  source: z.object({
    portal: z.literal("skyward"),
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }),
    capturedAt: timestamp,
  }),
});

export const assignmentSectionSchema = z.object({
  kind: z.enum(["upcoming", "missing", "past"]),
  status: z.enum(["complete", "partial", "failed", "auth-required"]),
  assignments: z.array(assignmentSchema).max(100_000),
  scannedCount: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  verifiedEmpty: z.boolean(),
  warning: z.enum(["LIST_UNVERIFIED", "PAGINATION_UNVERIFIED", "RECORD_INVALID", "AUTH_REQUIRED", "STUDENT_UNVERIFIED", "COLLECTION_LIMIT"]).optional(),
}).superRefine((section, context) => {
  if (section.scannedCount < section.assignments.length ||
      new Set(section.assignments.map(assignment => assignment.id)).size !== section.assignments.length ||
      (section.verifiedEmpty && section.scannedCount !== 0) ||
      (section.status === "complete" && (!section.pages || (!section.scannedCount && !section.verifiedEmpty))) ||
      (section.kind === "missing" && section.assignments.some(assignment => assignment.missing !== true))) {
    context.addIssue({ code: "custom", message: "Inconsistent assignment section coverage." });
  }
});

export const assignmentStudentIdentitySchema = z.object({
  id: identity,
  name: text,
  firstName: text.optional(),
  lastName: text.optional(),
});

export const assignmentStudentSchema = assignmentStudentIdentitySchema.extend({
  sections: z.array(assignmentSectionSchema).length(3),
}).refine(student => new Set(student.sections.map(section => section.kind)).size === 3,
{ message: "Every student requires all three assignment sections." });

export const assignmentRunSchema = z.object({
  runId: z.uuid(),
  capturedAt: timestamp,
  window: assignmentWindowSchema,
  parserVersion: z.union([z.literal(1), z.literal(2)]),
  discoveryComplete: z.boolean(),
  status: z.enum(["complete", "partial", "failed", "auth-required"]),
  warning: z.enum(["STUDENT_DISCOVERY_UNVERIFIED", "AUTH_REQUIRED", "NAVIGATION_FAILED"]).optional(),
  students: z.array(assignmentStudentSchema).max(100),
}).superRefine((run, context) => {
  const sections = run.students.flatMap(student => student.sections);
  if (new Set(run.students.map(student => student.id)).size !== run.students.length ||
      (run.parserVersion === 2 && run.students.some(student => !student.firstName || !student.lastName)) ||
      (run.status === "complete" && (!run.discoveryComplete || !run.students.length || sections.some(section => section.status !== "complete"))) ||
      sections.some(section => section.kind === "past" && section.assignments.some(assignment => !isAssignmentInWindow(assignment, run.window)))) {
    context.addIssue({ code: "custom", message: "Inconsistent assignment run coverage." });
  }
});

export type CollectedAssignment = z.infer<typeof assignmentSchema>;
export type AssignmentSection = z.infer<typeof assignmentSectionSchema>;
export type AssignmentStudentIdentity = z.infer<typeof assignmentStudentIdentitySchema>;
export type AssignmentStudent = z.infer<typeof assignmentStudentSchema>;
export type AssignmentRun = z.infer<typeof assignmentRunSchema>;

export function isAssignmentInWindow(
  assignment: { dueDate: string | null; missing: boolean | null },
  window: AssignmentWindow,
): boolean {
  return assignment.missing === true || assignment.dueDate === null || assignment.dueDate >= window.startDate;
}