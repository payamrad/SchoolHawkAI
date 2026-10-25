import { z } from "zod";
import { assignmentSchema, assignmentWindowSchema, isAssignmentInWindow } from "./assignments";
import { canvasAssignmentSchema } from "./canvas-assignments";
import { gradeRecordSchema } from "./grades";
import { collectedMessageSchema } from "./messages";
import {
  fieldChangeSchema, healthIssueSchema, priorityReasonSchema, priorityRulesSchema, reviewIdSchema,
  reviewPortalSchema, reviewSectionSchema, reviewStatusSchema, reviewTimestamp, reviewTimeZoneSchema,
} from "../review";

export const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
export const SNAPSHOT_MAX_RECORDS = 100_000;
export const SNAPSHOT_MAX_VERSIONS = 500_000;
export const studentSnapshotOptionsSchema = z.object({
  assignmentDays: z.number().int().min(1).max(366).default(60),
  messageDays: z.number().int().min(1).max(366).default(14),
}).strict();
export type StudentSnapshotOptions = z.input<typeof studentSnapshotOptionsSchema>;
export function relevantSnapshotVersions<Version extends { id: string; scopeStatus: string; lastObservedAt: string }>(
  record: { currentVersionRef: string | null; latestVersionRefs: string[]; history: Version[] },
): Version[] {
  const relevant = new Set(record.latestVersionRefs);
  if (record.currentVersionRef) relevant.add(record.currentVersionRef);
  else {
    const complete = record.history.filter(version => version.scopeStatus === "complete");
    const latestComplete = complete.reduce((latest, version) => version.lastObservedAt > latest ? version.lastObservedAt : latest, "");
    for (const version of complete) if (version.lastObservedAt === latestComplete) relevant.add(version.id);
  }
  return record.history.filter(version => relevant.has(version.id));
}
const count = z.number().int().nonnegative();
const text = z.string().max(1_000_000);
const issueSchema = z.enum([
  ...healthIssueSchema.options, "partial-only", "newer-partial-observation", "ambiguous-current",
  "course-mapping-conflict", "course-label-grouping",
]);

export const snapshotAssignmentDataSchema = z.discriminatedUnion("portal", [
  z.object(assignmentSchema.shape).omit({ id: true, source: true }).extend({
    portal: z.literal("skyward"),
  }).strict(),
  z.object(canvasAssignmentSchema.shape).omit({ id: true, courseId: true, source: true }).extend({
    portal: z.literal("canvas"), course: text, section: text.nullable(),
    courseCode: text.nullable(), courseTermRef: reviewIdSchema.nullable(),
  }).strict(),
]);
export const snapshotGradeDataSchema = z.object(gradeRecordSchema.shape).omit({
  id: true, studentSectionId: true, termId: true, source: true,
}).extend({ studentSectionRef: reviewIdSchema, termRef: reviewIdSchema.nullable() }).strict();
export const snapshotMessageDataSchema = collectedMessageSchema.omit({ id: true, source: true, displayedDate: true }).strict();

const versionBase = {
  id: reviewIdSchema, firstObservedAt: reviewTimestamp, lastObservedAt: reviewTimestamp,
  firstSourceRef: reviewIdSchema, lastSourceRef: reviewIdSchema,
  scopeStatus: reviewStatusSchema, observationCount: count.positive(),
};
const recordBase = {
  id: reviewIdSchema, accountRef: reviewIdSchema, studentRef: reviewIdSchema.nullable(),
  firstObservedAt: reviewTimestamp, lastObservedAt: reviewTimestamp,
  currentVersionRef: reviewIdSchema.nullable(),
  latestVersionRefs: z.array(reviewIdSchema).min(1),
  observedInLatestCollection: z.boolean(),
  currentSelection: z.enum(["complete-observation", "partial-only", "ambiguous"]),
  issues: z.array(issueSchema),
};
export const snapshotAssignmentSchema = z.object({
  ...recordBase, kind: z.literal("assignment"), portal: reviewPortalSchema,
  selectionReasons: z.array(z.enum(["due-within-window", "upcoming", "missing", "undated", "linked-to-included-assignment"])).default([]),
  history: z.array(z.object({ ...versionBase, data: snapshotAssignmentDataSchema }).strict()).min(1).max(SNAPSHOT_MAX_VERSIONS),
}).strict();
export const snapshotGradeSchema = z.object({
  ...recordBase, kind: z.literal("grade"), portal: z.literal("skyward"),
  history: z.array(z.object({ ...versionBase, data: snapshotGradeDataSchema }).strict()).min(1).max(SNAPSHOT_MAX_VERSIONS),
}).strict();
export const earlierAssignmentGradeDataSchema = z.object(assignmentSchema.shape).pick({
  title: true, course: true, section: true, teacher: true, dueDate: true, category: true,
  grade: true, score: true, scoreStatus: true, maxScore: true, weight: true, attempts: true, missing: true,
}).strict();
export const earlierAssignmentGradeSchema = z.object({
  ...recordBase, kind: z.literal("assignment-grade"), portal: z.literal("skyward"),
  fullAssignmentDetailsOmitted: z.literal(true),
  history: z.array(z.object({ ...versionBase, data: earlierAssignmentGradeDataSchema }).strict()).min(1).max(SNAPSHOT_MAX_VERSIONS),
}).strict();
export const snapshotMessageSchema = z.object({
  ...recordBase, kind: z.literal("message"), portal: z.literal("skyward"),
  studentRefs: z.array(reviewIdSchema),
  association: z.literal("account-wide-not-inferred-from-content"),
  newlyObservedInReviewWindow: z.boolean(),
  latestObservedUnread: z.boolean().nullable(),
  selectionReasons: z.array(z.enum(["recent-sent", "newly-observed", "recent-change"])).default([]),
  history: z.array(z.object({ ...versionBase, data: snapshotMessageDataSchema }).strict()).min(1).max(SNAPSHOT_MAX_VERSIONS),
}).strict();
export type SnapshotAssignment = z.infer<typeof snapshotAssignmentSchema>;
export type SnapshotGrade = z.infer<typeof snapshotGradeSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type EarlierAssignmentGrade = z.infer<typeof earlierAssignmentGradeSchema>;
export type SnapshotRecord = SnapshotAssignment | SnapshotGrade | SnapshotMessage | EarlierAssignmentGrade;

export const snapshotSourceSchema = z.object({
  id: reviewIdSchema, runRef: reviewIdSchema, accountRef: reviewIdSchema, portal: reviewPortalSchema,
  recordRef: reviewIdSchema, studentRef: reviewIdSchema.nullable(),
  section: reviewSectionSchema, scope: z.string().max(100), capturedAt: reviewTimestamp,
  runStatus: reviewStatusSchema, scopeStatus: reviewStatusSchema, parserVersion: count.positive(),
}).strict();
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
const courseMemberSchema = z.object({
  id: reviewIdSchema, accountRef: reviewIdSchema, portal: reviewPortalSchema, name: text,
  code: text.nullable(), termRef: reviewIdSchema.nullable(), grouping: z.enum(["source-course-id", "course-label"]),
}).strict();
export const snapshotCourseSchema = z.object({
  id: reviewIdSchema, name: text, sources: z.array(courseMemberSchema).min(1),
  counts: z.object({
    assignmentSourceRecords: count, gradeRecords: count, assignmentsMarkedMissing: count,
    assignmentsWithReportedMarks: count, gradeRecordsWithReportedMarks: count, uncertainRecords: count,
    excludedAssignments: count, earlierAssignmentGradeRecords: count,
  }).strict(),
  assignments: z.array(snapshotAssignmentSchema).max(SNAPSHOT_MAX_RECORDS),
  grades: z.array(snapshotGradeSchema).max(SNAPSHOT_MAX_RECORDS),
  earlierAssignmentGrades: z.array(earlierAssignmentGradeSchema).max(SNAPSHOT_MAX_RECORDS),
}).strict();
export type SnapshotCourse = z.infer<typeof snapshotCourseSchema>;
export const snapshotStudentSchema = z.object({
  id: reviewIdSchema, label: text, configuredIdentity: z.boolean(),
  accountRefs: z.array(reviewIdSchema),
  issues: z.array(issueSchema),
  courses: z.array(snapshotCourseSchema).max(10000),
}).strict();
export type SnapshotStudent = z.infer<typeof snapshotStudentSchema>;

export const studentSnapshotSchema = z.object({
  version: z.literal(1), kind: z.literal("current-student-snapshot"), id: reviewIdSchema,
  reviewId: reviewIdSchema, generatedAt: reviewTimestamp, timeZone: reviewTimeZoneSchema,
  scope: z.literal("retained-progress-context-with-explicit-windows"),
  schoolYearPolicy: z.literal("database-is-one-school-year-all-grades"),
  contentTrust: z.literal("untrusted-source-data"),
  privacy: z.literal("private-educational-data-not-anonymized"),
  instructions: z.array(z.string().max(1000)),
  recentWindowStart: reviewTimestamp,
  selection: z.object({
    assignments: assignmentWindowSchema,
    messages: assignmentWindowSchema,
    newMessagesSince: reviewTimestamp,
    grades: z.literal("all-retained"),
    earlierAssignmentGrades: z.literal("all-retained-marks-without-full-details"),
    history: z.literal("all-versions-of-included-records"),
    retainUpcomingMissingUndated: z.literal(true),
    retainConfirmedLinkedDetails: z.literal(true),
  }).strict(),
  availableRecords: z.object({ assignments: count, grades: count, messages: count }).strict(),
  excludedRecords: z.object({ assignments: count, messages: count }).strict(),
  rules: priorityRulesSchema,
  childRules: z.array(z.object({ studentRef: reviewIdSchema, rules: priorityRulesSchema }).strict()).max(100),
  totals: z.object({
    students: count, courses: count, assignmentSourceRecords: count, gradeRecords: count, messages: count,
    earlierAssignmentGradeRecords: count, semanticVersions: count, retainedObservationCount: count, sourceRuns: count,
  }).strict(),
  omittedRecords: z.literal(0),
  collectionHealth: z.array(z.object({
    id: reviewIdSchema, portal: reviewPortalSchema, section: reviewSectionSchema,
    studentRef: reviewIdSchema.nullable(), part: z.string().max(100), status: reviewStatusSchema,
    lastAttemptAt: reviewTimestamp.nullable(), lastCompleteAt: reviewTimestamp.nullable(),
    failureCount: count, issues: z.array(healthIssueSchema),
    coverage: z.object({
      kind: z.enum(["full", "window", "unread", "discovery"]),
      startDate: z.iso.date().nullable(), endDate: z.iso.date().nullable(),
    }).strict().nullable(),
  }).strict()).max(10000),
  status: z.enum(["complete-for-retained-scope", "incomplete-source-coverage"]),
  notices: z.array(issueSchema),
  attention: z.array(z.object({
    id: reviewIdSchema, studentRef: reviewIdSchema.nullable(), recordRefs: z.array(reviewIdSchema),
    entity: z.enum(["assignment", "grade", "message", "collection"]),
    priority: z.enum(["high", "normal", "low"]), reasons: z.array(priorityReasonSchema),
    uncertainty: z.array(healthIssueSchema),
    delivery: z.enum(["daily", "immediate-eligible"]),
  }).strict()).max(SNAPSHOT_MAX_RECORDS),
  recentChanges: z.array(z.object({
    id: reviewIdSchema, recordRef: reviewIdSchema,
    kind: z.enum(["first-observed", "newly-observed", "updated", "no-longer-observed", "reappeared"]),
    observedAt: reviewTimestamp, detectedAt: reviewTimestamp, fields: z.array(fieldChangeSchema),
  }).strict()).max(SNAPSHOT_MAX_RECORDS),
  students: z.array(snapshotStudentSchema).max(2000),
  messages: z.array(snapshotMessageSchema).max(SNAPSHOT_MAX_RECORDS),
  confirmedLinks: z.object({
    courses: z.array(z.object({
      id: reviewIdSchema, sourceCourseRefs: z.array(reviewIdSchema).length(2), skywardSection: text.nullable(),
    }).strict()).max(10000),
    assignments: z.array(z.object({ id: reviewIdSchema, recordRefs: z.array(reviewIdSchema).length(2) }).strict()).max(SNAPSHOT_MAX_RECORDS),
  }).strict(),
  sources: z.array(snapshotSourceSchema).max(SNAPSHOT_MAX_VERSIONS * 2),
}).strict().superRefine((snapshot, context) => {
  const students = new Set(snapshot.students.map(student => student.id));
  const courses = snapshot.students.flatMap(student => student.courses);
  const courseSources = new Set(courses.flatMap(course => course.sources.map(source => source.id)));
  const assignments = courses.flatMap(course => course.assignments);
  const grades = courses.flatMap(course => course.grades);
  const earlierGrades = courses.flatMap(course => course.earlierAssignmentGrades);
  const records: SnapshotRecord[] = [...assignments, ...grades, ...earlierGrades, ...snapshot.messages];
  const recordIds = new Set(records.map(record => record.id));
  const assignmentIds = new Set(assignments.map(record => record.id));
  const sources = new Set(snapshot.sources.map(source => source.id));
  const sourceById = new Map(snapshot.sources.map(source => [source.id, source]));
  const referencedSources = new Set<string>();
  let versionCount = 0;
  let observations = 0;
  let invalid = students.size !== snapshot.students.length || recordIds.size !== records.length ||
    sources.size !== snapshot.sources.length || records.length > SNAPSHOT_MAX_RECORDS;
  for (const record of records) {
    const versions = new Set(record.history.map(version => version.id));
    versionCount += record.history.length;
    for (const version of record.history) {
      observations += version.observationCount;
      invalid ||= !sources.has(version.firstSourceRef) || !sources.has(version.lastSourceRef) ||
        version.firstObservedAt > version.lastObservedAt || version.lastObservedAt > snapshot.generatedAt;
      for (const ref of [version.firstSourceRef, version.lastSourceRef]) {
        referencedSources.add(ref);
        const source = sourceById.get(ref);
        invalid ||= source?.recordRef !== record.id || source.accountRef !== record.accountRef ||
          source.studentRef !== record.studentRef || source.portal !== record.portal || source.scopeStatus !== version.scopeStatus ||
          source.section !== (record.kind === "grade" ? "grades" : record.kind === "message" ? "messages" : "assignments");
      }
      invalid ||= sourceById.get(version.firstSourceRef)?.capturedAt !== version.firstObservedAt ||
        sourceById.get(version.lastSourceRef)?.capturedAt !== version.lastObservedAt;
    }
    invalid ||= versions.size !== record.history.length || record.firstObservedAt > record.lastObservedAt ||
      record.currentVersionRef !== null && !versions.has(record.currentVersionRef) ||
      record.latestVersionRefs.some(id => !versions.has(id)) ||
      (record.currentSelection === "ambiguous") !== (record.currentVersionRef === null);
    const current = record.history.find(version => version.id === record.currentVersionRef);
    invalid ||= record.currentSelection === "complete-observation" && current?.scopeStatus !== "complete" ||
      record.currentSelection === "partial-only" && record.history.some(version => version.scopeStatus === "complete");
  }
  invalid ||= versionCount > SNAPSHOT_MAX_VERSIONS ||
    snapshot.childRules.some(rule => !students.has(rule.studentRef)) ||
    snapshot.messages.some(message => message.studentRefs.some(id => !students.has(id))) ||
    snapshot.collectionHealth.some(health => health.studentRef !== null && !students.has(health.studentRef)) ||
    snapshot.attention.some(action => action.studentRef !== null && !students.has(action.studentRef) ||
      action.recordRefs.some(id => !recordIds.has(id))) ||
    snapshot.recentChanges.some(change => !recordIds.has(change.recordRef)) ||
    snapshot.confirmedLinks.courses.some(link => link.sourceCourseRefs.some(id => !courseSources.has(id))) ||
    snapshot.confirmedLinks.assignments.some(link => link.recordRefs.some(id => !assignmentIds.has(id))) ||
    snapshot.totals.students !== snapshot.students.length || snapshot.totals.courses !== courses.length ||
    snapshot.totals.assignmentSourceRecords !== assignments.length || snapshot.totals.gradeRecords !== grades.length ||
    snapshot.totals.messages !== snapshot.messages.length || snapshot.totals.semanticVersions !== versionCount ||
    snapshot.totals.earlierAssignmentGradeRecords !== earlierGrades.length ||
    snapshot.totals.retainedObservationCount !== observations ||
    snapshot.availableRecords.assignments !== assignments.length + snapshot.excludedRecords.assignments ||
    snapshot.availableRecords.grades !== grades.length ||
    snapshot.availableRecords.messages !== snapshot.messages.length + snapshot.excludedRecords.messages ||
    earlierGrades.length > snapshot.excludedRecords.assignments ||
    assignments.some(record => !record.selectionReasons.length) ||
    snapshot.messages.some(record => !record.selectionReasons.length);
  for (const course of courses) {
    invalid ||= course.counts.assignmentSourceRecords !== course.assignments.length || course.counts.gradeRecords !== course.grades.length ||
      course.counts.earlierAssignmentGradeRecords !== course.earlierAssignmentGrades.length ||
      course.earlierAssignmentGrades.some(record => !record.history.some(version => version.data.grade !== null || version.data.score !== null));
    const assignments = course.assignments.map(record => record.history.find(version => version.id === record.currentVersionRef)?.data);
    const grades = course.grades.map(record => record.history.find(version => version.id === record.currentVersionRef)?.data);
    invalid ||= course.counts.assignmentsMarkedMissing !== assignments.filter(data => data?.portal === "skyward" && data.missing === true).length ||
      course.counts.assignmentsWithReportedMarks !== assignments.filter(data =>
        data?.portal === "skyward" && (data.grade !== null || data.score !== null)).length ||
      course.counts.gradeRecordsWithReportedMarks !== grades.filter(data => data && (data.grade !== null || data.score !== null)).length ||
      course.counts.uncertainRecords !== [...course.assignments, ...course.grades, ...course.earlierAssignmentGrades].filter(record => record.issues.length > 0).length;
  }
  for (const student of snapshot.students) for (const course of student.courses) {
    invalid ||= [...course.assignments, ...course.grades, ...course.earlierAssignmentGrades].some(record => record.studentRef !== student.id ||
      !student.accountRefs.includes(record.accountRef));
  }
  invalid ||= snapshot.messages.some(message => message.studentRef !== null);
  invalid ||= courses.reduce((sum, course) => sum + course.counts.excludedAssignments, 0) !== snapshot.excludedRecords.assignments ||
    snapshot.selection.newMessagesSince !== snapshot.recentWindowStart ||
    snapshot.attention.some(action => action.entity !== "collection" && !action.recordRefs.length);
  const eligibleAssignments = new Set(assignments.filter(record => relevantSnapshotVersions(record).some(version =>
    isAssignmentInWindow({
      dueDate: version.data.dueDate, missing: version.data.portal === "skyward" ? version.data.missing : null,
    }, snapshot.selection.assignments))).map(record => record.id));
  invalid ||= assignments.some(record => !eligibleAssignments.has(record.id) &&
    !snapshot.confirmedLinks.assignments.some(link => link.recordRefs.includes(record.id) &&
      link.recordRefs.some(id => id !== record.id && eligibleAssignments.has(id)))) ||
    earlierGrades.some(record => relevantSnapshotVersions(record).some(version =>
      isAssignmentInWindow(version.data, snapshot.selection.assignments)));
  for (const message of snapshot.messages) {
    const recent = relevantSnapshotVersions(message).some(version =>
      version.data.sentDate >= snapshot.selection.messages.startDate && version.data.sentDate <= snapshot.selection.messages.endDate);
    const newlyObserved = message.firstObservedAt >= snapshot.selection.newMessagesSince;
    const changed = snapshot.recentChanges.some(change => change.recordRef === message.id && change.kind === "updated" &&
      change.detectedAt >= snapshot.recentWindowStart && change.detectedAt <= snapshot.generatedAt &&
      change.fields.some(field => field.field !== "unread"));
    invalid ||= !recent && !newlyObserved && !changed || message.newlyObservedInReviewWindow !== newlyObserved;
  }
  invalid ||= snapshot.sources.some(source => !recordIds.has(source.recordRef) || !referencedSources.has(source.id)) ||
    records.length > 0 && snapshot.totals.sourceRuns === 0 ||
    snapshot.status === "complete-for-retained-scope" && (
      snapshot.notices.length > 0 ||
      snapshot.collectionHealth.some(health => health.issues.some(issue => !["lookback-limited", "unread-only"].includes(issue))) ||
      records.some(record => record.issues.some(issue => ["partial-only", "newer-partial-observation", "ambiguous-current"].includes(issue))));
  if (invalid) context.addIssue({ code: "custom", message: "Inconsistent student snapshot records, counts, or references." });
});
export type StudentSnapshot = z.infer<typeof studentSnapshotSchema>;
