import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { studentReportFixture, studentReportHistoryFixture } from "../../agent/tests/fixtures";
import { fingerprintReportInput } from "../report-input";
import { buildStudentSnapshot, studentSnapshotSchema, type SnapshotHistoryRun, type StudentSnapshot } from "../student-snapshot";
import { ids, snapshotReview } from "./review-fixtures";

function refresh(source: SnapshotHistoryRun, time: string): SnapshotHistoryRun {
  const result = structuredClone(source);
  result.run.runId = randomUUID();
  result.run.capturedAt = time;
  if (result.section === "messages") {
    for (const message of result.run.messages) message.source.capturedAt = time;
  } else if (result.section === "grades") {
    for (const student of result.run.students) for (const grade of student.grades) grade.source.capturedAt = time;
  } else if (result.portal === "canvas") {
    for (const student of result.run.students) for (const course of student.courses) {
      for (const assignment of course.assignments) assignment.source.capturedAt = time;
    }
  } else {
    for (const student of result.run.students) for (const section of student.sections) {
      for (const assignment of section.assignments) assignment.source.capturedAt = time;
    }
  }
  return result;
}

test("repeated portal observations and next-day reporting keep the same semantic input hash", () => {
  const { settings, history } = studentReportHistoryFixture();
  const first = buildStudentSnapshot(history, settings, snapshotReview(history, settings), { courses: [], assignments: [] }, ids);
  const later = "2026-10-11T16:00:00.000Z";
  const repeated = [...history, ...history.map(source => refresh(source, later))];
  const second = buildStudentSnapshot(repeated, settings, snapshotReview(repeated, settings, new Date(later)),
    { courses: [], assignments: [] }, ids);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.notEqual(first.totals.retainedObservationCount, second.totals.retainedObservationCount);
  assert.deepEqual(fingerprintReportInput(first), fingerprintReportInput(second));
});

test("student/course/record and JSON-key ordering does not change the fingerprint", () => {
  const first = studentReportFixture();
  const second = structuredClone(first);
  second.students.reverse();
  second.messages.reverse();
  second.childRules.reverse();
  second.collectionHealth.reverse();
  second.sources.reverse();
  for (const student of second.students) {
    student.accountRefs.reverse();
    student.courses.reverse();
    for (const course of student.courses) {
      course.assignments.reverse(); course.grades.reverse(); course.sources.reverse();
    }
  }
  assert.deepEqual(fingerprintReportInput(first), fingerprintReportInput(second));
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.deepEqual(fingerprintReportInput(first), fingerprintReportInput(studentSnapshotSchema.parse(reordered)));
});

test("grades, assignment marks, missing work, descriptions, teachers, Canvas fields and message contents change the hash", () => {
  const first = studentReportFixture();
  const changes: ((snapshot: StudentSnapshot) => void)[] = [
    value => { value.students[0].courses.flatMap(course => course.grades)[0].history[0].data.grade = "A"; },
    value => { value.students[0].courses.flatMap(course => course.grades)[0].history[0].data.score = "0"; },
    value => { value.messages[0].history[0].data.bodyText = "A new teacher request."; },
    value => { value.messages[0].history[0].data.sender = "Another sender"; },
    value => {
      for (const version of value.messages[0].history) version.data.unreadBeforeOpen = !version.data.unreadBeforeOpen;
      value.messages[0].latestObservedUnread = !value.messages[0].latestObservedUnread;
    },
    value => { value.students[0].label = "Updated student name"; },
    ...["score", "missing", "teacher", "description", "attempts"].map(field => (value: StudentSnapshot) => {
      const data = value.students.flatMap(student => student.courses).flatMap(course => course.assignments)
        .find(record => record.portal === "skyward")!.history[0].data;
      assert(data.portal === "skyward");
      if (field === "missing") data.missing = !data.missing;
      else if (field === "score") data.score = "1";
      else if (field === "teacher") data.teacher = "Another teacher";
      else if (field === "description") data.description = "Updated instructions";
      else data.attempts = "2";
    }),
    ...["description", "pointsPossible", "updatedAt", "lockedForUser"].map(field => (value: StudentSnapshot) => {
      const data = value.students.flatMap(student => student.courses).flatMap(course => course.assignments)
        .find(record => record.portal === "canvas")!.history[0].data;
      assert(data.portal === "canvas");
      if (field === "description") data.description = "New Canvas instructions";
      else if (field === "pointsPossible") data.pointsPossible = 123;
      else if (field === "updatedAt") data.updatedAt = "2026-10-10T15:00:00.000Z";
      else data.lockedForUser = !data.lockedForUser;
    }),
  ];
  for (const [index, change] of changes.entries()) {
    const second = structuredClone(first);
    change(second);
    for (const course of second.students.flatMap(student => student.courses)) {
      const current = course.assignments.map(record => record.history.find(version => version.id === record.currentVersionRef)?.data);
      course.counts.assignmentsMarkedMissing = current.filter(data => data?.portal === "skyward" && data.missing === true).length;
      course.counts.assignmentsWithReportedMarks = current.filter(data =>
        data?.portal === "skyward" && (data.grade !== null || data.score !== null)).length;
    }
    assert(studentSnapshotSchema.safeParse(second).success, `Mutation ${index} must remain a valid report input.`);
    assert.notEqual(fingerprintReportInput(first).inputHash, fingerprintReportInput(second).inputHash);
  }
});

test("new assignment identities and changes in observed record membership require a new report", () => {
  const { settings, history } = studentReportHistoryFixture();
  const first = buildStudentSnapshot(history, settings, snapshotReview(history, settings), { courses: [], assignments: [] }, ids);
  const source = history.find(source => source.portal === "canvas")!;
  assert(source.portal === "canvas");
  const changed = refresh(source, "2026-10-10T17:00:00.000Z");
  assert(changed.portal === "canvas");
  const course = changed.run.students[0].courses[0];
  const original = course.assignments[0];
  course.assignments.push({ ...original, id: "999", source: {
    ...original.source, url: `https://canvas.example/courses/${course.id}/assignments/999`,
  } });
  course.scannedCount++;
  let updated = [...history, changed];
  let second = buildStudentSnapshot(updated, settings, snapshotReview(updated, settings, new Date("2026-10-10T18:00:00.000Z")),
    { courses: [], assignments: [] }, ids);
  assert.notEqual(fingerprintReportInput(first).inputHash, fingerprintReportInput(second).inputHash);
  course.assignments = [];
  course.scannedCount = 0;
  course.verifiedEmpty = true;
  updated = [...history, changed];
  second = buildStudentSnapshot(updated, settings, snapshotReview(updated, settings, new Date("2026-10-10T18:00:00.000Z")),
    { courses: [], assignments: [] }, ids);
  assert.notEqual(fingerprintReportInput(first).inputHash, fingerprintReportInput(second).inputHash);
});
test("historical changes and reversals remain significant even when the final grade matches the first", () => {
  const { settings, history, grades } = studentReportHistoryFixture();
  const first = buildStudentSnapshot(history, settings, snapshotReview(history, settings), { courses: [], assignments: [] }, ids);
  const changed = refresh({ portal: "skyward", section: "grades", accountId: "parent", run: grades }, "2026-10-10T17:00:00.000Z");
  assert(changed.section === "grades");
  changed.run.students[0].grades[0].grade = "A";
  const reverted = refresh({ portal: "skyward", section: "grades", accountId: "parent", run: grades }, "2026-10-10T18:00:00.000Z");
  const updated = [...history, changed, reverted];
  const second = buildStudentSnapshot(updated, settings, snapshotReview(updated, settings, new Date("2026-10-10T19:00:00.000Z")),
    { courses: [], assignments: [] }, ids);
  assert.notEqual(fingerprintReportInput(first).inputHash, fingerprintReportInput(second).inputHash);
});

test("coverage warnings are handled without new tokens, while reporting mode and rule changes cannot reuse the wrong baseline", () => {
  const first = studentReportFixture();
  const limited = structuredClone(first);
  limited.status = "incomplete-source-coverage";
  limited.notices.push("collection-incomplete");
  limited.instructions.push("Collection was incomplete.");
  assert.deepEqual(fingerprintReportInput(first), fingerprintReportInput(limited));
  assert.notEqual(fingerprintReportInput(first).scopeHash, fingerprintReportInput(first, true).scopeHash);
  const changed = structuredClone(first);
  changed.rules.dueSoonHours++;
  assert.notEqual(fingerprintReportInput(first).inputHash, fingerprintReportInput(changed).inputHash);
});
