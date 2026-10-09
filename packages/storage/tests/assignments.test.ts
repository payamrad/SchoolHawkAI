import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteMessageStore } from "../sqlite-message-store";
import { assignmentRunSchema, assignmentWindowSchema, isAssignmentInWindow, type AssignmentRun } from "@schoolhawk/core/assignments";

test("assignment lookback includes its boundary and never clips future, missing, or undated work", () => {
  const window = assignmentWindowSchema.parse({
    days: 7, startDate: "2026-09-20", endDate: "2026-09-26", timeZone: "America/Los_Angeles",
  });
  for (const dueDate of ["2026-09-20", "2026-09-26", "2026-09-27", "2027-06-01", null]) {
    assert.equal(isAssignmentInWindow({ dueDate, missing: false }, window), true);
  }
  assert.equal(isAssignmentInWindow({ dueDate: "2026-09-19", missing: false }, window), false);
  assert.equal(isAssignmentInWindow({ dueDate: "2026-01-01", missing: true }, window), true);
  assert.equal(isAssignmentInWindow({ dueDate: null, missing: null }, window), true);
  assert.throws(() => assignmentWindowSchema.parse({ ...window, days: 8 }));
  assert.throws(() => assignmentWindowSchema.parse({ ...window, startDate: "2026-02-31" }));
});

function sample(): AssignmentRun {
  return {
    runId: randomUUID(), capturedAt: "2026-09-26T12:00:00.000Z", parserVersion: 1,
    window: { days: 7, startDate: "2026-09-20", endDate: "2026-09-26", timeZone: "America/Los_Angeles" },
    status: "complete", discoveryComplete: true,
    students: [{ id: "student-1", name: "Synthetic Student", sections: ["upcoming", "missing", "past"].map(kind => ({
      kind: kind as "upcoming" | "missing" | "past", status: "complete", assignments: [], scannedCount: 0, pages: 1, verifiedEmpty: true,
    })) }],
  };
}

test("assignment coverage requires verified emptiness and all sections for every discovered student", () => {
  const run = sample();
  assert.deepEqual(assignmentRunSchema.parse(run), run);
  assert.throws(() => assignmentRunSchema.parse({ ...run, discoveryComplete: false }));
  assert.throws(() => assignmentRunSchema.parse({ ...run, students: [] }));
  assert.throws(() => assignmentRunSchema.parse({ ...run, students: [run.students[0], run.students[0]] }));
  const section = run.students[0].sections[0];
  section.verifiedEmpty = false;
  assert.throws(() => assignmentRunSchema.parse(run));
  section.status = "failed";
  assert.throws(() => assignmentRunSchema.parse(run));
  run.status = "partial";
  assert.deepEqual(assignmentRunSchema.parse(run), run);
});

function withAssignment(): AssignmentRun {
  const run = sample();
  const section = run.students[0].sections[0];
  section.scannedCount = 1;
  section.verifiedEmpty = false;
  section.assignments.push({
    id: "PRIVATE-ASSIGNMENT-ID", title: "PRIVATE-ASSIGNMENT", course: "Synthetic Course",
    section: null, teacher: null, dueDate: "2026-10-01", assignedDate: null, description: null,
    category: null, grade: null, score: null, scoreStatus: null, maxScore: "10", weight: null,
    attempts: null, attachmentCount: null, missing: false,
    source: { portal: "skyward", url: "https://example.test/assignments", capturedAt: run.capturedAt },
  });
  return run;
}

test("stores assignment history idempotently with account and student isolation", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const run = withAssignment();
    run.students.push({ ...structuredClone(run.students[0]), id: "student-2", name: "Other Synthetic Student" });
    assert.equal(store.importAssignmentRun("parent", run), "imported");
    assert.equal(store.importAssignmentRun("parent", run), "already-imported");
    assert.deepEqual(store.getAssignmentRun("parent", run.runId), run);
    assert.equal(store.listAssignmentRuns("parent").length, 1);
    assert.equal(store.listAssignments("parent").length, 2);
    assert.equal(store.listAssignments("parent", { studentId: "student-2" })[0].student.name, "Other Synthetic Student");
    assert.deepEqual(store.listAssignments("other"), []);
    assert.equal(store.getAssignmentRun("other", run.runId), undefined);
    assert.throws(() => store.importAssignmentRun("parent", { ...run, status: "partial" }), /Conflicting/);
    assert.throws(() => store.listAssignments("parent", { limit: 0 }));
    store.importAssignmentRun("other", run);
    assert.equal(store.listAssignments("other").length, 2);
  } finally { store.close(); }
});

test("preserves separate student names without changing identities or rewriting legacy snapshots", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const legacy = withAssignment();
    legacy.students[0].name = "Synthetic Family,";
    store.importAssignmentRun("parent", legacy);
    assert.deepEqual(store.listAssignments("parent")[0].student, { id: "student-1", name: "Synthetic Family," });
    assert.throws(() => assignmentRunSchema.parse({ ...legacy, parserVersion: 2 }));
    assert.throws(() => assignmentRunSchema.parse({ ...legacy, parserVersion: 3 }));
    const current = structuredClone(legacy);
    current.runId = randomUUID();
    current.parserVersion = 2;
    current.capturedAt = "2026-09-26T14:00:00.000Z";
    const student = current.students[0];
    student.name = "Synthetic Family, Alex";
    student.firstName = "Alex";
    student.lastName = "Synthetic Family";
    student.sections[0].assignments[0].source.capturedAt = current.capturedAt;
    assert.equal(store.importAssignmentRun("parent", current), "imported");
    assert.equal(store.importAssignmentRun("parent", current), "already-imported");
    const records = store.listAssignments("parent", { studentId: student.id });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].student, {
      id: "student-1", name: "Synthetic Family, Alex", firstName: "Alex", lastName: "Synthetic Family",
    });
    assert.deepEqual(store.getAssignmentRun("parent", current.runId), current);
    assert.deepEqual(store.getAssignmentRun("parent", legacy.runId), legacy);
    assert.equal(store.importAssignmentRun("parent", legacy), "already-imported");
    assert.deepEqual(store.listAssignments("other"), []);
  } finally { store.close(); }
});

test("complete student sections advance independently while failures, empty runs, and older observations retain known assignments", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const first = withAssignment();
    store.importAssignmentRun("parent", first);
    const latest = structuredClone(first);
    latest.runId = randomUUID();
    latest.capturedAt = "2026-09-26T14:00:00.000Z";
    latest.status = "partial";
    const assignment = latest.students[0].sections[0].assignments[0];
    assignment.dueDate = "2026-10-05";
    assignment.source.capturedAt = latest.capturedAt;
    latest.students[0].sections[1].status = "failed";
    store.importAssignmentRun("parent", latest);
    const failed = structuredClone(latest);
    failed.runId = randomUUID();
    failed.students[0].sections[0].status = "partial";
    failed.students[0].sections[0].assignments[0].title = "Unverified title";
    failed.students[0].sections[0].assignments[0].source.capturedAt = "2026-09-26T15:00:00.000Z";
    store.importAssignmentRun("parent", failed);
    store.importAssignmentRun("parent", sample());
    store.importAssignmentRun("parent", { ...first, runId: randomUUID() });
    const records = store.listAssignments("parent");
    assert.equal(records.length, 1);
    assert.equal(records[0].assignment.dueDate, "2026-10-05");
    assert.equal(records[0].assignment.title, "PRIVATE-ASSIGNMENT");
    assert.equal(records[0].firstSeenAt, first.capturedAt);
    assert.equal(records[0].lastSeenAt, latest.capturedAt);
    assert.equal(records[0].runId, latest.runId);
  } finally { store.close(); }
});

test("assignment ingestion is encrypted, atomic, audited, and included in online backups", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-assignments-"));
  const file = path.join(directory, "schoolhawk.sqlite");
  const key = randomBytes(32);
  const store = new SqliteMessageStore(file, key);
  try {
    const run = withAssignment();
    run.parserVersion = 2;
    run.students[0].firstName = "PRIVATE-FIRST";
    run.students[0].lastName = "PRIVATE-LAST";
    run.students[0].name = "PRIVATE-LAST, PRIVATE-FIRST";
    store.importAssignmentRun("parent", run);
    const connection = new Database(file);
    try {
      connection.exec("CREATE TRIGGER fail_assignment BEFORE INSERT ON assignment_observations BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      assert.throws(() => store.importAssignmentRun("parent", withAssignment()), /test failure/);
      assert.equal(store.listAssignmentRuns("parent").length, 1);
      assert.throws(() => connection.exec("DELETE FROM assignment_import_events"), /append-only/);
      assert.throws(() => connection.exec("UPDATE assignment_import_events SET imported_at = 'changed'"), /append-only/);
      connection.exec("DROP TRIGGER fail_assignment;");
    } finally { connection.close(); }
    const backup = path.join(directory, "backup.sqlite");
    await store.backup(backup);
    const restored = new SqliteMessageStore(backup, key);
    try { assert.deepEqual(restored.getAssignmentRun("parent", run.runId), run); }
    finally { restored.close(); }
    for (const secret of ["PRIVATE-ASSIGNMENT", "student-1", "PRIVATE-FIRST", "PRIVATE-LAST"]) {
      assert.equal(readFileSync(backup).includes(Buffer.from(secret)), false);
    }
    assert.throws(() => new SqliteMessageStore(file, randomBytes(32)), /Incorrect storage key/);
  } finally { store.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});