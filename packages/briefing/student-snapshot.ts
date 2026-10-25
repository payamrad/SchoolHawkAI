import { ReviewError } from "@schoolhawk/core/review";
import {
  SNAPSHOT_MAX_BYTES, studentSnapshotSchema, serializeStudentSnapshot, type StudentSnapshot,
} from "@schoolhawk/core/student-snapshot";

export { studentSnapshotSchema, serializeStudentSnapshot };

export function renderStudentSnapshot(input: StudentSnapshot): string {
  const snapshot = studentSnapshotSchema.parse(input);
  const lines = [
    "SchoolHawkAI - current-student progress snapshot",
    `Generated: ${snapshot.generatedAt}`,
    `Scope: ${snapshot.scope}; ${snapshot.schoolYearPolicy}`,
    `Coverage: ${snapshot.status}`,
    `Totals: ${JSON.stringify(snapshot.totals)}`,
    `Selection: ${JSON.stringify(snapshot.selection)}`,
    `Available records: ${JSON.stringify(snapshot.availableRecords)}`,
    `Excluded by reporting windows: ${JSON.stringify(snapshot.excludedRecords)}`,
    "All retained grades and all records qualifying for the stated windows are included. Collection completeness is separate from report completeness.",
    "",
    ...snapshot.instructions.map(instruction => `- ${instruction}`),
    "",
    `Default priority rules: ${JSON.stringify(snapshot.rules)}`,
    `Per-student priority rules: ${JSON.stringify(snapshot.childRules)}`,
    "",
    "Collection health",
    ...snapshot.collectionHealth.map(health => JSON.stringify(health)),
    `Notices: ${JSON.stringify(snapshot.notices)}`,
    "",
    "Deterministic attention items",
    ...snapshot.attention.map(action => JSON.stringify(action)),
    "",
    "Recent changes (all older record history is included below)",
    ...snapshot.recentChanges.map(change => JSON.stringify(change)),
  ];
  for (const student of snapshot.students) {
    lines.push("", `Student: ${JSON.stringify(student.label)} [${student.id}]`,
      `Configured identity: ${student.configuredIdentity}; cautions: ${JSON.stringify(student.issues)}`);
    if (!student.courses.length) lines.push("No retained course records; consult collection health rather than assuming no schoolwork.");
    for (const course of student.courses) {
      lines.push("", `Course: ${JSON.stringify(course.name)} [${course.id}]`,
        `Source course groups: ${JSON.stringify(course.sources)}`, `Counts: ${JSON.stringify(course.counts)}`,
        "Assignments (recent past work plus upcoming, missing, undated, and linked details)",
        ...course.assignments.map(record => JSON.stringify(record)),
        "Course/period grades (all retained marks and observed history)",
        ...course.grades.map(record => JSON.stringify(record)),
        "Earlier assignment grade/score histories (full assignment details intentionally omitted)",
        ...course.earlierAssignmentGrades.map(record => JSON.stringify(record)));
    }
  }
  lines.push("", "Account-wide messages (recent, newly observed, or recently changed; full selected content)",
    ...snapshot.messages.map(message => JSON.stringify(message)),
    "", `Confirmed cross-source links: ${JSON.stringify(snapshot.confirmedLinks)}`,
    "", "Source references", ...snapshot.sources.map(source => JSON.stringify(source)),
    "", "This is source data for a stateless reporting agent, not a claim that a student is doing well or poorly.");
  const output = lines.join("\n");
  if (Buffer.byteLength(output, "utf8") + 1 > SNAPSHOT_MAX_BYTES) {
    throw new ReviewError("The full text snapshot exceeds 50 MiB. No content was silently truncated; try JSON or a narrower authorized scope.");
  }
  return output;
}
