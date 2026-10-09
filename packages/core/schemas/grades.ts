import { z } from "zod";
import { assignmentStudentIdentitySchema } from "./assignments";

const text = z.string().min(1).max(1_000_000);
const identity = z.string().min(1).max(300);

export const gradeRecordSchema = z.object({
  id: identity,
  studentSectionId: identity,
  courseCode: text.nullable(),
  course: text,
  classDetails: text.nullable(),
  section: text.nullable(),
  teacher: text.nullable(),
  termId: identity.nullable(),
  term: text,
  periodStatus: z.enum(["open", "closed", "unknown"]),
  schoolYear: text.nullable(),
  grade: text.nullable(),
  score: text.nullable(),
  maxScore: text.nullable(),
  gradingScale: text.nullable(),
  effectiveDate: z.iso.date().nullable(),
  source: z.object({
    portal: z.literal("skyward"),
    url: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }),
    capturedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  }),
});

export type CollectedGrade = z.infer<typeof gradeRecordSchema>;

export const gradeStudentSchema = assignmentStudentIdentitySchema.required({ firstName: true, lastName: true }).extend({
  status: z.enum(["complete", "partial", "failed", "auth-required"]),
  grades: z.array(gradeRecordSchema).max(100_000),
  periods: z.array(text).max(100),
  scannedCount: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  verifiedEmpty: z.boolean(),
  warning: z.enum(["LIST_UNVERIFIED", "COVERAGE_UNVERIFIED", "RECORD_INVALID", "STUDENT_UNVERIFIED", "AUTH_REQUIRED"]).optional(),
}).superRefine((student, context) => {
  if (new Set(student.grades.map(grade => grade.id)).size !== student.grades.length ||
      new Set(student.grades.map(grade => grade.studentSectionId)).size > student.scannedCount ||
      new Set(student.periods).size !== student.periods.length ||
      student.grades.some(grade => !student.periods.includes(grade.term)) ||
      (student.verifiedEmpty && (student.scannedCount !== 0 || student.grades.length !== 0)) ||
      (student.status === "complete" && (!student.pages || (!student.scannedCount && !student.verifiedEmpty) ||
        (student.scannedCount > 0 && !student.periods.length)))) {
    context.addIssue({ code: "custom", message: "Inconsistent student grade coverage." });
  }
});

export const gradeRunSchema = z.object({
  runId: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  parserVersion: z.literal(1),
  discoveryComplete: z.boolean(),
  status: z.enum(["complete", "partial", "failed", "auth-required"]),
  students: z.array(gradeStudentSchema).max(100),
  warning: z.enum(["STUDENT_DISCOVERY_UNVERIFIED", "AUTH_REQUIRED", "NAVIGATION_FAILED"]).optional(),
}).superRefine((run, context) => {
  if (new Set(run.students.map(student => student.id)).size !== run.students.length ||
      (run.status === "complete" && (!run.discoveryComplete || !run.students.length || run.students.some(student => student.status !== "complete")))) {
    context.addIssue({ code: "custom", message: "Inconsistent grade run coverage." });
  }
});

export type GradeStudent = z.infer<typeof gradeStudentSchema>;
export type GradeRun = z.infer<typeof gradeRunSchema>;