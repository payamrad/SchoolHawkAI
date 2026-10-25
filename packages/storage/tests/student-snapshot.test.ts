import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "vitest";
import { currentSnapshotVersion, serializeStudentSnapshot, studentSnapshotSchema } from "@schoolhawk/core/student-snapshot";
import { buildBriefingInput, serializeBriefingInput } from "../../briefing/index";
import { withDiagnosticSink } from "@schoolhawk/core/diagnostics";
import { assignment, assignmentRun, config, gradeRun, instant, messageRun, namedFamilyFixture } from "../../core/tests/review-fixtures";
import { SqliteReviewStore } from "../sqlite-review-store";

test("snapshot storage API includes unchanged old records and full message history without modifying sources", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "grades", "messages"] }],
    briefing: { maxItems: 1, maxBytes: 4096 } });
  try {
    const first = assignmentRun(instant, Array.from({ length: 50 }, (_, index) =>
      assignment(instant, { id: `assignment-${index}`, grade: "A", score: "10", title: `Finished work ${index}` })));
    const grades = gradeRun();
    const read = messageRun(instant, false);
    read.messages[0].bodyText = "Complete retained teacher context. ".repeat(2000);
    store.importAssignmentRun("parent", first);
    store.importGradeRun("parent", grades);
    store.importRun("parent", read);
    store.importAssignmentRun("unconfigured", assignmentRun());
    const snapshot = store.createStudentSnapshot(settings, new Date("2026-10-20T16:00:00Z"));
    assert.equal(snapshot.totals.assignmentSourceRecords, 50);
    assert.equal(snapshot.totals.gradeRecords, 1);
    assert.equal(snapshot.totals.messages, 1);
    assert.equal(snapshot.messages[0].latestObservedUnread, false);
    assert.equal(currentSnapshotVersion(snapshot.messages[0])!.data.bodyText, read.messages[0].bodyText);
    assert.equal(snapshot.omittedRecords, 0);
    assert(Buffer.byteLength(serializeStudentSnapshot(snapshot)) > 32768);
    assert.deepEqual(store.getAssignmentRun("parent", first.runId), first);
    assert.deepEqual(store.getGradeRun("parent", grades.runId), grades);
    assert.deepEqual(store.getRun("parent", read.runId), read);
    assert.deepEqual(studentSnapshotSchema.parse(snapshot), snapshot);
    assert.deepEqual(store.createStudentSnapshot(settings, new Date("2026-10-20T16:00:00Z")), snapshot);
  } finally { store.close(); }
});

test("snapshot reads all grade records beyond bounded current-view query limits", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const run = gradeRun();
    const student = run.students[0];
    student.grades = Array.from({ length: 1005 }, (_, index) => ({
      ...structuredClone(student.grades[0]), id: `bucket-${index}`, studentSectionId: `section-${index}`, course: `Course ${index}`,
    }));
    student.scannedCount = student.grades.length;
    store.importGradeRun("parent", run);
    assert.equal(store.listGrades("parent", { limit: 1000 }).length, 1000);
    const snapshot = store.createStudentSnapshot(config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["grades"] }] }), new Date(instant));
    assert.equal(snapshot.totals.gradeRecords, 1005);
    assert.equal(snapshot.totals.courses, 1005);
    assert.equal(snapshot.omittedRecords, 0);
    assert(snapshot.students[0].courses.some(course => course.name === "Course 1004"));
  } finally { store.close(); }
}, 20000);

test("partial-only records are present with warnings while complete current observations remain preferred", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    store.importGradeRun("parent", gradeRun());
    const partial = gradeRun("2026-10-10T17:00:00.000Z", "F");
    partial.status = "partial"; partial.students[0].status = "partial";
    partial.students[0].grades.push({ ...structuredClone(partial.students[0].grades[0]), id: "new-bucket", grade: "A" });
    store.importGradeRun("parent", partial);
    const snapshot = store.createStudentSnapshot(config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["grades"] }] }),
      new Date("2026-10-10T18:00:00Z"));
    assert.equal(snapshot.totals.gradeRecords, 2);
    const records = snapshot.students[0].courses[0].grades;
    assert(records.some(record => record.currentSelection === "partial-only"));
    const current = records.find(record => record.currentSelection === "complete-observation")!;
    assert.equal(currentSnapshotVersion(current)!.data.grade, "B");
    assert.equal(current.history.at(-1)!.data.grade, "F");
    assert.equal(snapshot.status, "incomplete-source-coverage");
  } finally { store.close(); }
});

test("invalid snapshot grouping rolls back derived review writes instead of returning a partial success", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const run = assignmentRun(instant, [assignment(instant, { course: "   " })]);
    store.importAssignmentRun("parent", run);
    assert.throws(() => store.createStudentSnapshot(config(), new Date(instant)), /course label is empty/);
    assert.equal(store.getReview("family"), undefined);
    assert.deepEqual(store.listReviewChanges("family"), []);
    assert.deepEqual(store.getAssignmentRun("parent", run.runId), run);
  } finally { store.close(); }
});

test("all course grades and earlier assessment marks survive small assignment/message windows", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const capturedAt = "2026-07-01T16:00:00.000Z";
    const run = assignmentRun(capturedAt, [assignment(capturedAt, {
      dueDate: "2026-07-01", grade: "A", score: "0", description: "EXCLUDED_EARLIER_DETAILS",
    })]);
    store.importAssignmentRun("parent", run);
    store.importGradeRun("parent", gradeRun(capturedAt, "B"));
    const snapshot = store.createStudentSnapshot(config({
      sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "grades"] }],
    }), new Date(instant), { assignmentDays: 1, messageDays: 1 });
    assert.equal(snapshot.totals.assignmentSourceRecords, 0);
    assert.equal(snapshot.totals.earlierAssignmentGradeRecords, 1);
    assert.equal(snapshot.totals.gradeRecords, 1);
    const course = snapshot.students[0].courses[0];
    assert.equal(currentSnapshotVersion(course.earlierAssignmentGrades[0])!.data.score, "0");
    assert.equal(currentSnapshotVersion(course.grades[0])!.data.grade, "B");
    assert.doesNotMatch(serializeStudentSnapshot(snapshot), /EXCLUDED_EARLIER_DETAILS/);
    assert.deepEqual(store.getAssignmentRun("parent", run.runId), run);
  } finally { store.close(); }
});

test("a recently detected content change can include an older message without treating read-state changes as new content", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["messages"] }] });
  const capturedAt = "2026-07-01T16:00:00.000Z";
  try {
    const first = messageRun(capturedAt, false);
    first.messages[0].sentDate = first.window.endDate;
    first.messages.push({ ...structuredClone(first.messages[0]), id: "read-state-only" });
    store.importRun("parent", first);
    store.processReview(settings, new Date(capturedAt));
    const next = messageRun(instant, false);
    next.window.days = 366;
    next.window.startDate = "2025-10-10";
    next.messages[0].sentDate = first.window.endDate;
    next.messages[0].bodyText = "UPDATED_TEACHER_REQUEST";
    next.messages.push({ ...structuredClone(first.messages[1]), unreadBeforeOpen: true,
      source: { ...first.messages[1].source, capturedAt: instant } });
    next.scannedCount = 2;
    store.importRun("parent", next);
    const snapshot = store.createStudentSnapshot(settings, new Date(instant));
    assert.equal(snapshot.totals.messages, 1);
    assert.deepEqual(snapshot.messages[0].selectionReasons, ["recent-change"]);
    assert.equal(snapshot.messages[0].newlyObservedInReviewWindow, false);
    assert.equal(currentSnapshotVersion(snapshot.messages[0])!.data.bodyText, "UPDATED_TEACHER_REQUEST");
    assert.equal(snapshot.excludedRecords.messages, 1);
  } finally { store.close(); }
});

test("name-matched reviews, briefings and snapshots have two children while preserving legacy review and source history", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const { settings, skyward, canvas } = namedFamilyFixture();
  const oldConfig = config({ ...settings, studentMatching: "bindings" });
  try {
    store.importAssignmentRun("parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    const oldSnapshot = store.createStudentSnapshot(oldConfig, new Date(instant));
    const oldReview = store.getReview("family")!;
    const oldChanges = store.listReviewChanges("family");
    assert.equal(oldSnapshot.totals.students, 3);
    assert.throws(() => store.processReview(settings, new Date(instant)), /Use a new profileId/);
    settings.profileId = "family-names";
    const review = store.processReview(settings, new Date(instant));
    assert.deepEqual(review.childRules.map(child => child.childId), ["avery", "casey"]);
    assert.equal(review.resolvedChildren![0].bindings.length, 2);
    assert.deepEqual(store.getReview("family-names"), review);
    const briefing = buildBriefingInput(review);
    assert.equal(briefing.children.length, 2);
    assert.doesNotMatch(serializeBriefingInput(briefing), /Quinn|Rowan|student-1|canvas-avery|resolvedChildren/);
    const snapshot = store.createStudentSnapshot(settings, new Date(instant));
    assert.equal(snapshot.totals.students, 2);
    assert.deepEqual(snapshot.students.map(student => student.label), ["avery", "casey"]);
    assert.equal(snapshot.totals.assignmentSourceRecords, oldSnapshot.totals.assignmentSourceRecords);
    assert.equal(snapshot.totals.semanticVersions, oldSnapshot.totals.semanticVersions);
    assert.equal(snapshot.totals.retainedObservationCount, oldSnapshot.totals.retainedObservationCount);
    assert.equal(snapshot.sources.length, oldSnapshot.sources.length);
    assert.equal(snapshot.omittedRecords, 0);
    assert.equal(snapshot.students[0].courses.flatMap(course => course.assignments).length, 2);
    assert.deepEqual(store.getAssignmentRun("parent", skyward.runId), skyward);
    assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", canvas.runId), canvas);
    assert.deepEqual(store.getReview("family"), oldReview);
    assert.deepEqual(store.listReviewChanges("family"), oldChanges);
    assert.deepEqual(store.createStudentSnapshot(settings, new Date(instant)), snapshot);
  } finally { store.close(); }
});

test("a later Canvas identity resolves by name without a baseline reset or duplicate Skyward changes", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const { settings, skyward, canvas } = namedFamilyFixture();
  settings.children = settings.children.filter(child => child.id !== "canvas-avery");
  settings.children[0].rules = { upcomingDays: 14 };
  try {
    store.importAssignmentRun("parent", skyward);
    const before = store.processReview(settings, new Date(instant));
    assert.equal(before.resolvedChildren![0].bindings.length, 1);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    const after = store.processReview(settings, new Date("2026-10-10T17:00:00Z"));
    assert.equal(after.bootstrap, false);
    assert.equal(after.resolvedChildren![0].bindings.length, 2);
    assert.equal(after.actions.find(action => action.facts?.gradingScale === "points")!.childId, "avery");
    assert.equal(after.childRules.find(child => child.childId === "avery")!.rules.upcomingDays, 14);
    assert.deepEqual(after.changes.filter(change => change.after.portal === "skyward"), before.changes);
    const snapshot = store.createStudentSnapshot(settings, new Date("2026-10-10T17:00:00Z"));
    assert.equal(snapshot.totals.students, 2);
    assert.equal(snapshot.totals.assignmentSourceRecords, 3);
  } finally { store.close(); }
});

test("ambiguous full names remain separate and prevent unqualified complete reports", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const { settings, skyward, canvas } = namedFamilyFixture();
  Object.assign(skyward.students[1], { name: "QUINN, AVERY", firstName: "Avery", lastName: "Quinn" });
  try {
    store.importAssignmentRun("parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    withDiagnosticSink(() => {}, () => {
      const review = store.processReview(settings, new Date(instant));
      assert(review.notices.includes("student-name-ambiguous"));
      assert.equal(buildBriefingInput(review).conclusion, "incomplete");
      const snapshot = store.createStudentSnapshot(settings, new Date(instant));
      assert.equal(snapshot.totals.students, 3);
      assert.equal(snapshot.status, "incomplete-source-coverage");
      assert(snapshot.notices.includes("student-name-ambiguous"));
      assert.equal(snapshot.totals.assignmentSourceRecords, 3);
    });
  } finally { store.close(); }
});
