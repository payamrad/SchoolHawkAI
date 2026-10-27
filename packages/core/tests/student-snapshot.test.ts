import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildStudentSnapshot, currentSnapshotVersion, serializeStudentSnapshot, studentSnapshotSchema,
  type SnapshotHistoryRun, type SnapshotLinks, type StudentSnapshotOptions } from "../student-snapshot";
import { assignmentMatchWindow } from "../assignment-correlation";
import { assignment, assignmentRun, canvasRun, config, gradeRun, ids, instant, messageRun, snapshotReview } from "./review-fixtures";
import { studentReportHistoryFixture } from "../../agent/tests/fixtures";

const later = "2026-10-10T17:00:00.000Z";
const latest = "2026-10-10T18:00:00.000Z";
const emptyLinks: SnapshotLinks = { courses: [], assignments: [] };
const settings = () => config({ sources: [
  { portal: "skyward", accountId: "parent", sections: ["assignments", "grades", "messages"] },
  { portal: "canvas", accountId: "canvas-parent", sections: ["assignments"] },
], children: [{ id: "student-a", bindings: [
  { portal: "skyward", accountId: "parent", studentId: "student-1" },
  { portal: "canvas", accountId: "canvas-parent", studentId: "10" },
] }] });

test("individual snapshots preserve one named student's records, grades, source IDs and shared message context", () => {
  const { settings, history, grades } = studentReportHistoryFixture();
  const changed = structuredClone(grades);
  changed.runId = randomUUID();
  changed.capturedAt = later;
  for (const student of changed.students) for (const grade of student.grades) {
    grade.source.capturedAt = later;
    grade.grade = "A";
  }
  history.push({ portal: "skyward", section: "grades", accountId: "parent", run: changed });
  const review = snapshotReview(history, settings, new Date(latest));
  const full = buildStudentSnapshot(history, settings, review, emptyLinks, ids, { assignmentDays: 7, messageDays: 7 });
  const scoped = full.students.map(student => buildStudentSnapshot(history, settings, review, emptyLinks, ids,
    { assignmentDays: 7, messageDays: 7, studentRef: student.id }));
  for (const [index, snapshot] of scoped.entries()) {
    assert.equal(snapshot.totals.students, 1);
    assert.deepEqual(snapshot.students[0], full.students[index]);
    assert.equal(snapshot.selection.studentRef, full.students[index].id);
    assert.notEqual(snapshot.id, full.id);
    assert.equal(snapshot.reviewId, full.reviewId);
    assert.equal(snapshot.childRules.length, 1);
    assert.equal(snapshot.totals.gradeRecords, 1);
    assert.equal(snapshot.students[0].courses.flatMap(course => course.grades)[0].history.length, 2);
    assert.equal(snapshot.messages.length, 1);
    assert.deepEqual(snapshot.messages[0].history, full.messages[0].history);
    assert.deepEqual(snapshot.messages[0].studentRefs, [snapshot.students[0].id]);
    assert.equal(snapshot.messages[0].association, "account-wide-not-inferred-from-content");
    assert(snapshot.sources.every(source => source.studentRef === null || source.studentRef === snapshot.students[0].id));
    assert(snapshot.collectionHealth.every(health => health.studentRef === null || health.studentRef === snapshot.students[0].id));
    assert(snapshot.attention.every(action => action.studentRef === null || action.studentRef === snapshot.students[0].id));
    assert.equal(snapshot.omittedRecords, 0);
    assert.deepEqual(studentSnapshotSchema.parse(snapshot), snapshot);
  }
  assert.equal(scoped.reduce((count, snapshot) => count + snapshot.totals.assignmentSourceRecords, 0), full.totals.assignmentSourceRecords);
  assert.equal(scoped.reduce((count, snapshot) => count + snapshot.totals.gradeRecords, 0), full.totals.gradeRecords);
  assert.equal(scoped.find(snapshot => snapshot.students[0].label === "casey")!.totals.sourceRuns, 4);
  assert.throws(() => buildStudentSnapshot(history, settings, review, emptyLinks, ids,
    { studentRef: `student_${"0".repeat(64)}` }), /not a configured child/);
});

test("individual reporting computes exclusion counts within the selected student's accounts", () => {
  const { settings, history } = studentReportHistoryFixture();
  settings.sources.push({ portal: "skyward", accountId: "other-parent", sections: ["messages"] });
  settings.children.push({ id: "other-child", bindings: [{ portal: "skyward", accountId: "other-parent", studentId: "other-student" }] });
  const unrelated = messageRun("2026-09-01T16:00:00.000Z");
  unrelated.messages[0].sentDate = "2026-09-01";
  unrelated.messages[0].bodyText = "OTHER_ACCOUNT_MESSAGE";
  history.push({ portal: "skyward", section: "messages", accountId: "other-parent", run: unrelated });
  const review = snapshotReview(history, settings);
  const full = buildStudentSnapshot(history, settings, review, emptyLinks, ids, { messageDays: 7 });
  const student = full.students.find(student => student.label === "avery")!;
  const scoped = buildStudentSnapshot(history, settings, review, emptyLinks, ids, { messageDays: 7, studentRef: student.id });
  assert.equal(full.availableRecords.messages, 2);
  assert.equal(full.excludedRecords.messages, 1);
  assert.equal(scoped.availableRecords.messages, 1);
  assert.equal(scoped.excludedRecords.messages, 0);
  assert.doesNotMatch(serializeStudentSnapshot(scoped), /OTHER_ACCOUNT_MESSAGE/);
  assert.equal(scoped.totals.sourceRuns, 4);
});

function sample(history: SnapshotHistoryRun[], configuration = settings(), now = new Date(latest), links = emptyLinks,
  options: StudentSnapshotOptions = {}) {
  return buildStudentSnapshot(history, configuration, snapshotReview(history, configuration, now), links, ids, options);
}

test("snapshot includes recent graded work and unchanged grades grouped by course without item truncation", () => {
  const oldTime = "2026-08-15T12:00:00.000Z";
  const old = assignmentRun(oldTime, [assignment(oldTime, { id: "old-graded", dueDate: "2026-08-15", grade: "A", score: "10",
    title: "Old graded work", course: "Math" })]);
  const current = assignmentRun(instant, Array.from({ length: 45 }, (_, index) =>
    assignment(instant, { id: `work-${index}`, course: index % 2 ? "Math" : "Science", title: `Current ${index}`, grade: "B" })));
  const grades = gradeRun(instant, "A");
  grades.students[0].grades[0].course = "Math";
  const configuration = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "grades"] }],
    briefing: { maxItems: 1, maxBytes: 4096 } });
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "assignments", accountId: "parent", run: old },
    { portal: "skyward", section: "assignments", accountId: "parent", run: current },
    { portal: "skyward", section: "grades", accountId: "parent", run: grades },
  ];
  const before = JSON.stringify(history);
  const result = sample(history, configuration);
  assert.equal(result.omittedRecords, 0);
  assert.equal(result.totals.assignmentSourceRecords, 46);
  assert.equal(result.totals.gradeRecords, 1);
  assert.equal(result.students[0].courses.length, 2);
  const math = result.students[0].courses.find(course => course.name === "Math")!;
  assert(math.assignments.some(record => currentSnapshotVersion(record)?.data.title === "Old graded work"));
  assert.equal(math.grades[0].history[0].data.grade, "A");
  assert(math.counts.assignmentsWithReportedMarks > 1);
  assert(Buffer.byteLength(serializeStudentSnapshot(result)) > 32768);
  assert.equal(JSON.stringify(history), before);
});

test("grade and assignment value histories preserve improvements, zeros, nulls and first/last evidence", () => {
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun(instant, null) },
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun(later, "A") },
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun(latest, "A") },
    { portal: "skyward", section: "assignments", accountId: "parent", run: assignmentRun(instant, [assignment(instant, { score: "0" })]) },
    { portal: "skyward", section: "assignments", accountId: "parent", run: assignmentRun(later, [assignment(later, { score: "9", dueDate: "2026-10-13" })]) },
  ];
  const result = sample(history);
  const course = result.students[0].courses[0];
  const grade = course.grades[0];
  assert.equal(grade.history.length, 2);
  assert.equal(grade.history[0].data.grade, null);
  assert.equal(grade.history[1].data.grade, "A");
  assert.equal(grade.history[1].observationCount, 2);
  assert.equal(grade.history[1].firstObservedAt, later);
  assert.equal(grade.history[1].lastObservedAt, latest);
  assert.equal(grade.currentVersionRef, grade.history[1].id);
  assert.deepEqual(course.assignments[0].history.map(version => version.data.portal === "skyward" ? version.data.score : null), ["0", "9"]);
  assert.equal(result.totals.retainedObservationCount, 5);
  assert.equal(result.totals.semanticVersions, 4);
  assert(result.sources.every(source => source.recordRef === grade.id || source.recordRef === course.assignments[0].id));
});

test("latest complete observations are qualified separately from newer partial and partial-only data", () => {
  const complete = gradeRun(instant, "A");
  const partial = gradeRun(later, "F");
  partial.status = "partial"; partial.students[0].status = "partial";
  partial.students[0].grades.push({ ...structuredClone(partial.students[0].grades[0]), id: "new-partial-grade", grade: "B" });
  const result = sample([
    { portal: "skyward", section: "grades", accountId: "parent", run: complete },
    { portal: "skyward", section: "grades", accountId: "parent", run: partial },
  ]);
  const grades = result.students[0].courses[0].grades;
  const known = grades.find(record => record.history.length === 2)!;
  assert.equal(currentSnapshotVersion(known)?.data.grade, "A");
  assert.equal(known.history.at(-1)!.data.grade, "F");
  assert(known.issues.includes("newer-partial-observation"));
  const newGrade = grades.find(record => record.history.length === 1)!;
  assert.equal(newGrade.currentSelection, "partial-only");
  assert.equal(currentSnapshotVersion(newGrade)?.data.grade, "B");
  assert.equal(result.status, "incomplete-source-coverage");
});

test("same-time conflicting grade observations remain visible without inventing a current mark", () => {
  const result = sample([
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun(instant, "A") },
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun(instant, "F") },
  ]);
  const grade = result.students[0].courses[0].grades[0];
  assert.equal(grade.currentSelection, "ambiguous");
  assert.equal(grade.currentVersionRef, null);
  assert.equal(grade.latestVersionRefs.length, 2);
  assert(grade.issues.includes("ambiguous-current"));
  assert.equal(result.status, "incomplete-source-coverage");
});

test("recent read and new unread message bodies survive with full selected context and partial observations", () => {
  const old = messageRun("2026-10-03T12:00:00.000Z", false);
  old.messages[0].id = "old-read";
  old.messages[0].sentDate = "2026-10-03";
  old.messages[0].bodyText = "Earlier teacher instructions. ".repeat(2000);
  const recent = messageRun(later, true);
  recent.status = "partial";
  recent.messages[0].bodyText = "Current teacher request.";
  const result = sample([
    { portal: "skyward", section: "messages", accountId: "parent", run: old },
    { portal: "skyward", section: "messages", accountId: "parent", run: recent },
  ]);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].newlyObservedInReviewWindow, true);
  assert.equal(result.messages[0].latestObservedUnread, true);
  assert.equal(result.messages[0].currentSelection, "partial-only");
  const read = result.messages.find(message => message.latestObservedUnread === false)!;
  assert.equal(read.newlyObservedInReviewWindow, false);
  assert.equal(currentSnapshotVersion(read)?.data.bodyText, old.messages[0].bodyText);
  assert.equal(read.association, "account-wide-not-inferred-from-content");
  assert.deepEqual(read.studentRefs, [result.students[0].id]);
  const encoded = serializeStudentSnapshot(result);
  assert(encoded.includes("Earlier teacher instructions."));
  assert(encoded.includes("Current teacher request."));
  assert.doesNotMatch(encoded, /PRIVATE_STUDENT_NAME|PRIVATE_CANVAS_STUDENT|student-1|old-read|message-1|https?:\/\//);
});

test("assignment windows exclude old details but preserve every earlier grade and active/unknown work", () => {
  const timestamp = "2026-07-01T16:00:00.000Z";
  const old = assignmentRun(timestamp, [
    assignment(timestamp, { id: "old-graded", dueDate: "2026-07-01", grade: "A", score: "10", description: "EXCLUDED_OLD_INSTRUCTIONS" }),
    assignment(timestamp, { id: "old-ungraded", dueDate: "2026-07-01", grade: null, score: null }),
    assignment(timestamp, { id: "still-missing", dueDate: "2026-07-01", missing: true }),
    assignment(timestamp, { id: "undated", dueDate: null }),
    assignment(timestamp, { id: "future", dueDate: "2026-11-01" }),
  ]);
  const historicalGrade = gradeRun(timestamp, "B");
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "assignments", accountId: "parent", run: old },
    { portal: "skyward", section: "grades", accountId: "parent", run: historicalGrade },
  ];
  const result = sample(history);
  assert.equal(result.selection.assignments.days, 60);
  assert.equal(result.totals.assignmentSourceRecords, 3);
  assert.equal(result.excludedRecords.assignments, 2);
  assert.equal(result.totals.gradeRecords, 1);
  assert.equal(result.totals.earlierAssignmentGradeRecords, 1);
  const course = result.students[0].courses[0];
  assert(course.assignments.some(record => record.selectionReasons.includes("missing")));
  assert(course.assignments.some(record => record.selectionReasons.includes("undated")));
  assert(course.assignments.some(record => record.selectionReasons.includes("upcoming")));
  assert.equal(course.earlierAssignmentGrades[0].history[0].data.grade, "A");
  assert.equal(course.earlierAssignmentGrades[0].history[0].data.score, "10");
  assert.equal(course.earlierAssignmentGrades[0].fullAssignmentDetailsOmitted, true);
  assert.equal(course.grades[0].firstObservedAt, timestamp);
  assert.doesNotMatch(serializeStudentSnapshot(result), /EXCLUDED_OLD_INSTRUCTIONS/);
  const wider = sample(history, settings(), new Date(latest), emptyLinks, { assignmentDays: 366 });
  assert.equal(wider.totals.assignmentSourceRecords, 5);
  assert.equal(wider.totals.earlierAssignmentGradeRecords, 0);
  assert.notEqual(wider.id, result.id);
});

test("assignment window boundaries are inclusive and use source-calendar dates across DST", () => {
  const now = new Date("2026-11-01T08:30:00.000Z");
  const window = assignmentMatchWindow(60, now);
  const beforeBoundary = new Date(Date.parse(window.startDate) - 86400000).toISOString().slice(0, 10);
  const run = assignmentRun(now.toISOString(), [
    assignment(now.toISOString(), { id: "boundary", dueDate: window.startDate }),
    assignment(now.toISOString(), { id: "outside", dueDate: beforeBoundary }),
  ]);
  run.window = assignmentMatchWindow(366, now);
  const history: SnapshotHistoryRun[] = [{ portal: "skyward", section: "assignments", accountId: "parent", run }];
  const result = sample(history, config(), now);
  assert.equal(result.selection.assignments.endDate, "2026-11-01");
  assert.equal(result.totals.assignmentSourceRecords, 1);
  assert.equal(result.excludedRecords.assignments, 1);
  const selected = result.students[0].courses[0].assignments[0];
  assert.equal(currentSnapshotVersion(selected)!.data.dueDate, window.startDate);
});

test("ambiguous complete deadlines cannot be hidden by a newer partial out-of-window observation", () => {
  const future = assignmentRun(instant, [assignment(instant, { dueDate: "2026-11-01" })]);
  const old = assignmentRun(instant, [assignment(instant, { dueDate: "2026-07-01" })]);
  const partial = assignmentRun(later, [assignment(later, { dueDate: "2026-07-01" })]);
  partial.status = "partial";
  partial.students[0].sections.find(section => section.kind === "past")!.status = "partial";
  for (const run of [future, old, partial]) run.window = assignmentMatchWindow(366, new Date(run.capturedAt));
  const result = sample([future, old, partial].map(run => ({
    portal: "skyward", section: "assignments", accountId: "parent", run,
  })));
  assert.equal(result.totals.assignmentSourceRecords, 1);
  const record = result.students[0].courses[0].assignments[0];
  assert.equal(record.currentSelection, "ambiguous");
  assert.equal(record.currentVersionRef, null);
  assert(record.selectionReasons.includes("upcoming"));
});

test("message selection excludes old unread messages but includes old messages newly observed now", () => {
  const old = messageRun("2026-08-15T16:00:00.000Z", true);
  old.messages[0].id = "old-unread";
  old.messages[0].sentDate = old.window.endDate;
  old.messages[0].bodyText = "EXCLUDED_OLD_UNREAD";
  const discovered = messageRun(later, false);
  discovered.window = assignmentMatchWindow(366, new Date(later));
  discovered.messages[0].sentDate = "2026-08-01";
  discovered.messages[0].bodyText = "NEWLY_DISCOVERED_OLDER_MESSAGE";
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "messages", accountId: "parent", run: old },
    { portal: "skyward", section: "messages", accountId: "parent", run: discovered },
  ];
  const result = sample(history);
  assert.equal(result.selection.messages.days, 14);
  assert.equal(result.totals.messages, 1);
  assert.equal(result.excludedRecords.messages, 1);
  assert.equal(result.messages[0].latestObservedUnread, false);
  assert.deepEqual(result.messages[0].selectionReasons, ["newly-observed"]);
  assert.doesNotMatch(serializeStudentSnapshot(result), /EXCLUDED_OLD_UNREAD/);
  const wider = sample(history, settings(), new Date(latest), emptyLinks, { messageDays: 90 });
  assert.equal(wider.totals.messages, 2);
  assert.equal(wider.excludedRecords.messages, 0);
});

test("courses merge only with confirmed mappings and linked assignments retain both source records", () => {
  const canvas = canvasRun();
  canvas.students[0].courses[0].name = "Full Canvas course name";
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "assignments", accountId: "parent", run: assignmentRun() },
    { portal: "skyward", section: "grades", accountId: "parent", run: gradeRun() },
    { portal: "canvas", section: "assignments", accountId: "canvas-parent", run: canvas },
  ];
  const unlinked = sample(history);
  assert.equal(unlinked.students[0].courses.length, 2);
  const mapping = {
    id: randomUUID(), confirmedAt: instant, canvasStudentId: "10", canvasCourseId: "20",
    skywardAccountId: "parent", skywardStudentId: "student-1", skywardCourse: "Synthetic Course", skywardSection: null,
  };
  const links: SnapshotLinks = {
    courses: [{ accountId: "canvas-parent", mapping }],
    assignments: [{ accountId: "canvas-parent", link: {
      ...mapping, id: randomUUID(), mappingId: mapping.id, canvasAssignmentId: "40", skywardAssignmentId: "assignment-1",
      method: "title-date", confirmationKey: "0".repeat(64),
      evidence: { canvasRunId: canvas.runId, skywardRunId: history[0].run.runId,
        canvasTitle: "PRIVATE_TITLE", skywardTitle: "PRIVATE_TITLE", canvasDueDate: "2026-10-12", skywardDueDate: "2026-10-12" },
    } }],
  };
  const linked = sample(history, settings(), new Date(latest), links);
  assert.equal(linked.students[0].courses.length, 1);
  const course = linked.students[0].courses[0];
  assert.equal(course.assignments.length, 2);
  assert.equal(course.grades.length, 1);
  assert.equal(course.sources.length, 2);
  assert.equal(course.sources.find(source => source.portal === "canvas")!.code, "SYNTH");
  assert.equal(linked.confirmedLinks.assignments.length, 1);
  const canvasData = course.assignments.find(record => record.portal === "canvas")!.history[0].data;
  assert.equal(canvasData.description, "PRIVATE_CANVAS_INSTRUCTIONS");
  assert.equal(course.assignments.find(record => record.portal === "skyward")!.history[0].data.description, "PRIVATE_DESCRIPTION");
  const olderCanvas = structuredClone(history);
  const canvasSource = olderCanvas.find(source => source.portal === "canvas");
  assert(canvasSource?.portal === "canvas");
  canvasSource.run.students[0].courses[0].assignments[0].dueAt = "2026-07-01T16:00:00.000Z";
  canvasSource.run.students[0].courses[0].assignments[0].dueDate = "2026-07-01";
  const retainedLink = sample(olderCanvas, settings(), new Date(latest), links);
  assert.equal(retainedLink.totals.assignmentSourceRecords, 2);
  assert(retainedLink.students[0].courses[0].assignments.find(record => record.portal === "canvas")!.selectionReasons.includes("linked-to-included-assignment"));
});

test("student/account identity is isolated and unmapped students are reported instead of guessed or dropped", () => {
  const configuration = config({ sources: [
    { portal: "skyward", accountId: "parent", sections: ["assignments"] },
    { portal: "skyward", accountId: "another", sections: ["assignments"] },
  ] });
  const run = assignmentRun();
  run.students.push({ ...structuredClone(run.students[0]), id: "student-2" });
  const history: SnapshotHistoryRun[] = [
    { portal: "skyward", section: "assignments", accountId: "parent", run },
    { portal: "skyward", section: "assignments", accountId: "another", run: assignmentRun() },
  ];
  const result = sample(history, configuration);
  assert.equal(result.students.length, 3);
  assert.equal(result.totals.assignmentSourceRecords, 3);
  assert.equal(result.students.filter(student => student.configuredIdentity).length, 1);
  assert.equal(result.students.filter(student => student.issues.includes("unmapped-student")).length, 2);
  assert.throws(() => buildStudentSnapshot(history, config(), snapshotReview([history[0]], config()), emptyLinks, ids), /outside the configured/);
});

test("previously seen courses and work remain in full snapshots when absent from the latest collection", () => {
  const initial = canvasRun();
  const laterRun = canvasRun(later, true);
  laterRun.students[0].courses = [];
  const result = sample([
    { portal: "canvas", section: "assignments", accountId: "canvas-parent", run: initial },
    { portal: "canvas", section: "assignments", accountId: "canvas-parent", run: laterRun },
  ]);
  assert.equal(result.students[0].courses.length, 1);
  const record = result.students[0].courses[0].assignments[0];
  assert.equal(record.observedInLatestCollection, false);
  assert(record.issues.includes("record-not-observed"));
  assert.equal(record.history[0].data.title, "PRIVATE_TITLE");
});

test("snapshot schemas reject missing provenance, cross-student ownership, and truncated inventory", () => {
  const result = sample([{ portal: "skyward", section: "assignments", accountId: "parent", run: assignmentRun() }]);
  assert.deepEqual(studentSnapshotSchema.parse(JSON.parse(serializeStudentSnapshot(result))), result);
  assert.throws(() => studentSnapshotSchema.parse({ ...result, sources: [] }));
  assert.throws(() => studentSnapshotSchema.parse({ ...result, totals: { ...result.totals, assignmentSourceRecords: 0 } }));
  assert.throws(() => studentSnapshotSchema.parse({ ...result, sources: result.sources.map(source =>
    ({ ...source, recordRef: ids("record", ["wrong"]) })) }));
  const wrongStudent = structuredClone(result);
  wrongStudent.students[0].courses[0].assignments[0].studentRef = ids("student", ["wrong"]);
  assert.throws(() => studentSnapshotSchema.parse(wrongStudent));
  assert.throws(() => studentSnapshotSchema.parse({ ...result, credentials: "PRIVATE_SECRET" }));
});
