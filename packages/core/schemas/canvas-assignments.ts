import { z } from "zod";

const text = z.string().min(1).max(1_000_000);
export const canvasIdSchema = z.string().regex(/^\d+$/).max(100);
export const accountAliasSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const status = z.enum(["complete", "partial", "failed", "auth-required"]);
export const canvasWarningSchema = z.enum(["AUTH_REQUIRED", "PERMISSION_DENIED", "HTTP_ERROR", "RATE_LIMITED", "RESPONSE_INVALID",
  "PAGINATION_INVALID", "COLLECTION_LIMIT", "REQUEST_FAILED", "STUDENT_DISCOVERY_UNVERIFIED", "COURSE_DISCOVERY_UNVERIFIED"]);

export function pacificDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}

export const canvasAssignmentSchema = z.object({
  id: canvasIdSchema,
  courseId: canvasIdSchema,
  title: text,
  description: text.nullable(),
  dueAt: timestamp.nullable(),
  dueDate: z.iso.date().nullable(),
  unlockAt: timestamp.nullable(),
  lockAt: timestamp.nullable(),
  createdAt: timestamp.nullable(),
  updatedAt: timestamp.nullable(),
  pointsPossible: z.number().finite().nonnegative().nullable(),
  gradingType: text.nullable(),
  submissionTypes: z.array(text).max(30),
  allowedExtensions: z.array(text).max(100),
  externalTool: z.boolean(),
  lockedForUser: z.boolean().nullable(),
  hasOverrides: z.boolean().nullable(),
  source: z.object({
    portal: z.literal("canvas"),
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }),
    capturedAt: timestamp,
    dateScope: z.literal("student"),
  }),
}).superRefine((assignment, context) => {
  if (assignment.dueDate !== (assignment.dueAt ? pacificDate(assignment.dueAt) : null) ||
      new URL(assignment.source.url).pathname !== `/courses/${assignment.courseId}/assignments/${assignment.id}`) {
    context.addIssue({ code: "custom", message: "Inconsistent Canvas assignment source or date." });
  }
});

export const canvasStudentIdentitySchema = z.object({ id: canvasIdSchema, name: text, sortableName: text.nullable() });
export const canvasCourseIdentitySchema = z.object({ id: canvasIdSchema, name: text, code: text.nullable(), termId: canvasIdSchema.nullable() });
export const canvasCourseSchema = canvasCourseIdentitySchema.extend({
  status, assignments: z.array(canvasAssignmentSchema).max(100_000), pages: z.number().int().nonnegative(),
  scannedCount: z.number().int().nonnegative(), verifiedEmpty: z.boolean(), warning: canvasWarningSchema.optional(),
}).superRefine((course, context) => {
  if (new Set(course.assignments.map(assignment => assignment.id)).size !== course.assignments.length ||
      course.assignments.some(assignment => assignment.courseId !== course.id) || course.scannedCount < course.assignments.length ||
      (course.verifiedEmpty && course.scannedCount !== 0) ||
      (course.status === "complete" && (!course.pages || course.scannedCount !== course.assignments.length || (!course.assignments.length && !course.verifiedEmpty)))) {
    context.addIssue({ code: "custom", message: "Inconsistent Canvas course coverage." });
  }
});
export const canvasStudentSchema = canvasStudentIdentitySchema.extend({
  status, discoveryComplete: z.boolean(), courses: z.array(canvasCourseSchema).max(200), warning: canvasWarningSchema.optional(),
}).superRefine((student, context) => {
  if (new Set(student.courses.map(course => course.id)).size !== student.courses.length ||
      (student.status === "complete" && (!student.discoveryComplete || student.courses.some(course => course.status !== "complete")))) {
    context.addIssue({ code: "custom", message: "Inconsistent Canvas student coverage." });
  }
});
export const canvasAssignmentRunSchema = z.object({
  runId: z.uuid(), capturedAt: timestamp, parserVersion: z.literal(1), status, discoveryComplete: z.boolean(),
  students: z.array(canvasStudentSchema).max(100), warning: canvasWarningSchema.optional(),
}).superRefine((run, context) => {
  if (new Set(run.students.map(student => student.id)).size !== run.students.length ||
      (run.status === "complete" && (!run.discoveryComplete || run.students.some(student => student.status !== "complete")))) {
    context.addIssue({ code: "custom", message: "Inconsistent Canvas run coverage." });
  }
});

export const canvasCourseMappingSchema = z.object({
  canvasStudentId: canvasIdSchema, canvasCourseId: canvasIdSchema,
  skywardAccountId: accountAliasSchema, skywardStudentId: z.string().min(1).max(300),
  skywardCourse: text, skywardSection: text.nullable(),
});

export const storedCanvasCourseMappingSchema = canvasCourseMappingSchema.extend({ id: z.uuid(), confirmedAt: timestamp });
export const canvasAssignmentLinkSchema = z.object({
  id: z.uuid(), mappingId: z.uuid(), canvasStudentId: canvasIdSchema, canvasCourseId: canvasIdSchema, canvasAssignmentId: canvasIdSchema,
  skywardAccountId: accountAliasSchema, skywardStudentId: z.string().min(1).max(300), skywardAssignmentId: z.string().min(1).max(300),
  confirmedAt: timestamp, method: z.enum(["title-date", "lesson-date"]), confirmationKey: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.object({ canvasRunId: z.uuid(), skywardRunId: z.uuid(), canvasTitle: text, skywardTitle: text,
    canvasDueDate: z.iso.date(), skywardDueDate: z.iso.date() }),
});

export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>;
export type CanvasCourse = z.infer<typeof canvasCourseSchema>;
export type CanvasStudent = z.infer<typeof canvasStudentSchema>;
export type CanvasAssignmentRun = z.infer<typeof canvasAssignmentRunSchema>;
export type CanvasCourseMapping = z.infer<typeof canvasCourseMappingSchema>;
export type StoredCanvasCourseMapping = z.infer<typeof storedCanvasCourseMappingSchema>;
export type CanvasAssignmentLink = z.infer<typeof canvasAssignmentLinkSchema>;
export type CanvasWarning = z.infer<typeof canvasWarningSchema>;