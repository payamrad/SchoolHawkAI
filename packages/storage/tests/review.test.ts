import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { reviewResultSchema } from "@schoolhawk/core/review";
import { assignment, assignmentRun, canvasRun, config, gradeRun, instant, messageRun } from "../../core/tests/review-fixtures";
import { SqliteReviewStore } from "../sqlite-review-store";

const later = "2026-10-10T17:00:00.000Z";

test("review processing persists baselines, immutable events and repeatable evaluations", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const first = assignmentRun();
    store.importAssignmentRun("parent", first);
    const baseline = store.processReview(config(), new Date(instant));
    assert.equal(baseline.bootstrap, true);
    assert.equal(baseline.changes[0].kind, "first-observed");
    assert.deepEqual(reviewResultSchema.parse(baseline), baseline);
    assert.deepEqual(store.getReview("family"), baseline);
    assert.deepEqual(store.processReview(config(), new Date(instant)), baseline);
    assert.equal(store.listReviewChanges("family").length, 1);
    const next = assignmentRun(later, [assignment(later, { dueDate: "2026-10-11", score: "0" })]);
    store.importAssignmentRun("parent", next);
    const changed = store.processReview(config(), new Date(later));
    assert.equal(changed.bootstrap, false);
    assert.equal(changed.changes.filter(change => change.kind === "updated").length, 1);
    assert.equal(changed.actions.find(action => action.entity === "assignment")!.priority, "normal");
    assert.equal(changed.actions.find(action => action.entity === "assignment")!.facts!.score, "0");
    store.processReview(config(), new Date("2026-10-10T18:00:00Z"));
    assert.equal(store.listReviewChanges("family").length, 2);
    const source = changed.actions.find(action => action.entity === "assignment")!.evidenceIds[0];
    assert.equal(store.explainReviewSource("family", changed.id, source).runId, next.runId);
    assert.equal(store.getReview("other", changed.id), undefined);
    assert.throws(() => store.explainReviewSource("other", changed.id, source), /not part/);
    assert.equal(store.listReviewChanges("family", { limit: 1, offset: 1 }).length, 1);
    assert.throws(() => store.listReviewChanges("family", { limit: 0 }));
    assert.throws(() => store.listReviewChanges("family", { offset: -1 }));
    assert.deepEqual(store.getAssignmentRun("parent", first.runId), first);
  } finally { store.close(); }
});

test("grade, message and failed collections participate without overwriting independent baselines", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments", "grades", "messages"] }] });
  try {
    store.importAssignmentRun("parent", assignmentRun());
    store.importGradeRun("parent", gradeRun());
    store.importRun("parent", messageRun());
    store.processReview(settings, new Date(instant));
    const failed = assignmentRun(later);
    failed.status = "failed";
    failed.students[0].sections.forEach(section => { section.status = "failed"; section.verifiedEmpty = false; });
    store.importAssignmentRun("parent", failed);
    store.importGradeRun("parent", gradeRun(later, "A"));
    const result = store.processReview(settings, new Date(later));
    assert(result.health.some(health => health.section === "assignments" && health.issues.includes("collection-incomplete")));
    assert(result.changes.some(change => change.entity === "grade" && change.fields.some(field => field.after === "A")));
    assert.equal(result.actions.find(action => action.entity === "assignment")!.facts!.title, "PRIVATE_TITLE");
    assert(result.actions.find(action => action.entity === "assignment")!.uncertainty.includes("record-not-observed"));
  } finally { store.close(); }
});

test("late imports do not rewind current records and policy changes do not require a new baseline", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    store.importAssignmentRun("parent", assignmentRun(later, [assignment(later, { missing: true })]));
    store.processReview(config(), new Date(later));
    store.importAssignmentRun("parent", assignmentRun(instant, [assignment(instant, { title: "OLD" })]));
    const result = store.processReview(config(), new Date("2026-10-10T18:00:00Z"));
    assert.deepEqual(result.notices, ["late-observations-ignored"]);
    assert.equal(result.actions.find(action => action.entity === "assignment")!.facts!.title, "PRIVATE_TITLE");
    const adjusted = store.processReview(config({ rules: { staleAfterHours: 1 } }), new Date("2026-10-10T19:00:00Z"));
    assert(adjusted.actions.some(action => action.uncertainty.includes("collection-stale")));
    assert.throws(() => store.processReview(config({ children: [] }), new Date(later)), /bindings changed/);
  } finally { store.close(); }
});

test("all stored runs are inspected beyond existing 100/1000-row query defaults", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    for (let index = 0; index < 1005; index++) {
      const timestamp = new Date(Date.parse(instant) + index * 1000).toISOString();
      store.importAssignmentRun("parent", assignmentRun(timestamp, index === 1004 ? [assignment(timestamp)] : []));
    }
    const review = store.processReview(config(), new Date(later));
    assert.equal(review.changes.length, 1);
    assert.equal(review.changes[0].kind, "first-observed");
    assert.equal(review.changes[0].observedAt, new Date(Date.parse(instant) + 1004 * 1000).toISOString());
    const snapshot = store.createStudentSnapshot(config(), new Date(later));
    assert.equal(snapshot.totals.sourceRuns, 1005);
    assert.equal(snapshot.totals.assignmentSourceRecords, 1);
  } finally { store.close(); }
}, 15000);

test("existing confirmed Canvas links are used without rematching or overwriting Skyward values", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const settings = config({
    sources: [{ portal: "skyward", accountId: "parent", sections: ["assignments"] },
      { portal: "canvas", accountId: "canvas-parent", sections: ["assignments"] }],
    children: [{ id: "child-a", bindings: [{ portal: "skyward", accountId: "parent", studentId: "student-1" },
      { portal: "canvas", accountId: "canvas-parent", studentId: "10" }] }],
  });
  try {
    store.importAssignmentRun("parent", assignmentRun());
    store.importCanvasAssignmentRun("canvas-parent", canvasRun());
    const mapping = store.saveCanvasCourseMapping("canvas-parent", {
      canvasStudentId: "10", canvasCourseId: "20", skywardAccountId: "parent",
      skywardStudentId: "student-1", skywardCourse: "Synthetic Course", skywardSection: null,
    });
    const proposal = store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0];
    const link = store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, proposal.candidates[0].confirmationKey!);
    const review = store.processReview(settings, new Date(instant));
    const assignments = review.actions.filter(action => action.entity === "assignment");
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].relatedFacts.length, 1);
    assert.equal(assignments[0].facts!.dueAt, null);
    assert.equal(assignments[0].dueAt, "2026-10-13T06:59:00.000Z");
    assert.deepEqual(store.listCanvasAssignmentLinks("canvas-parent"), [link]);
  } finally { store.close(); }
});

test("migration, rollback, encrypted backup and append-only review history preserve source data", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-review-store-"));
  const file = path.join(root, "review.sqlite");
  const backup = path.join(root, "backup.sqlite");
  const key = randomBytes(32);
  try {
    let store = new SqliteReviewStore(file, key);
    const run = assignmentRun();
    store.importAssignmentRun("parent", run);
    store.close();
    let connection = new Database(file);
    const original = connection.prepare("SELECT content_hash, payload FROM assignment_runs").all();
    connection.exec("DROP TABLE report_checkpoints; DROP TABLE agent_reports; DROP TABLE review_evaluations; DROP TABLE review_events; DROP TABLE review_profiles; PRAGMA user_version = 6;");
    assert.throws(() => new SqliteReviewStore(file, randomBytes(32)), /Incorrect storage key/);
    assert.equal(connection.pragma("user_version", { simple: true }), 6);
    connection.close();
    store = new SqliteReviewStore(file, key);
    connection = new Database(file);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 9);
      assert.deepEqual(connection.prepare("SELECT content_hash, payload FROM assignment_runs").all(), original);
      connection.exec("CREATE TRIGGER fail_review BEFORE INSERT ON review_evaluations BEGIN SELECT RAISE(ABORT, 'Synthetic review failure'); END;");
      assert.throws(() => store.processReview(config(), new Date(instant)), /Synthetic review failure/);
      assert.equal(store.getReview("family"), undefined);
      assert.deepEqual(store.listReviewChanges("family"), []);
      connection.exec("DROP TRIGGER fail_review;");
      const reviewed = store.processReview(config(), new Date(instant));
      assert.equal(reviewed.bootstrap, true);
      assert.throws(() => connection.exec("DELETE FROM review_events"), /append-only/);
      assert.throws(() => connection.exec("UPDATE review_evaluations SET evaluated_at = 'changed'"), /append-only/);
      await store.backup(backup);
      const restored = new SqliteReviewStore(backup, key);
      try {
        assert.deepEqual(restored.getReview("family"), reviewed);
        assert.deepEqual(restored.listReviewChanges("family"), store.listReviewChanges("family"));
        assert.deepEqual(restored.getAssignmentRun("parent", run.runId), run);
      } finally { restored.close(); }
      connection.pragma("wal_checkpoint(TRUNCATE)");
      assert.equal(readFileSync(file).includes(Buffer.from("PRIVATE_TITLE")), false);
      assert.equal(readFileSync(file).includes(Buffer.from("PRIVATE_STUDENT_NAME")), false);
      assert.equal(readFileSync(backup).includes(Buffer.from("PRIVATE_DESCRIPTION")), false);
    } finally { connection.close(); store.close(); }
  } finally { key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test("explicit source cleanup is detected instead of silently publishing stale review facts", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  const settings = config({ sources: [{ portal: "skyward", accountId: "parent", sections: ["messages"] }] });
  try {
    const run = messageRun();
    run.messages[0].sender = "LAKE WASHINGTON SCHOOL DIST (No Reply)";
    run.messages[0].subject = "New Login Device Detected";
    store.importRun("parent", run);
    store.processReview(settings, new Date(instant));
    store.truncateMessages("parent", { target: "LoginNotification" });
    assert.throws(() => store.processReview(settings, new Date(later)), /source history changed/);
    const rebuilt = store.processReview({ ...settings, profileId: "family-after-cleanup" }, new Date(later));
    assert.equal(rebuilt.changes.length, 0);
    assert.equal(rebuilt.actions.filter(action => action.entity === "message").length, 0);
  } finally { store.close(); }
});
