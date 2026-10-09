import assert from "node:assert/strict";
import { test } from "vitest";
import { assessAssignmentLinks, assignmentMatchWindow, proposeAssignmentMatches } from "@schoolhawk/core/assignment-correlation";
import { canvasAssignmentRunSchema, canvasAssignmentSchema, pacificDate, type CanvasAssignmentRun } from "@schoolhawk/core/canvas-assignments";
import { randomBytes, randomUUID } from "node:crypto";
import { SqliteCanvasStore } from "../sqlite-canvas-store";
import type { AssignmentRun } from "@schoolhawk/core/assignments";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("assignment correlation proposes matching lesson codes and titles only on the same date", () => {
  const skyward = [
    { id: "skyward-1", title: "U1L6", dueDate: "2026-09-21" },
    { id: "skyward-2", title: "U1 Review", dueDate: "2026-09-24" },
  ];
  const matches = proposeAssignmentMatches(skyward, [
    { id: "canvas-1", title: "U1L6 More Visual Patterns", dueDate: "2026-09-21" },
    { id: "canvas-2", title: "Unit 1 Review", dueDate: "2026-09-24" },
    { id: "canvas-3", title: "U1L6", dueDate: "2026-09-22" },
    { id: "canvas-4", title: "U1L60", dueDate: "2026-09-21" },
    { id: "canvas-5", title: "U1 Review", dueDate: null },
  ]);
  assert.deepEqual(matches.map(match => match.status), ["candidate", "candidate", "unmatched", "unmatched", "unmatched"]);
  assert.deepEqual(matches[0].candidates, [{ skywardAssignmentId: "skyward-1", method: "lesson-date" }]);
  assert.deepEqual(matches[1].candidates, [{ skywardAssignmentId: "skyward-2", method: "title-date" }]);
});

test("correlation leaves duplicate and many-to-one matches ambiguous", () => {
  const assignment = { title: "Lab", dueDate: "2026-09-21" };
  const skyward = [{ ...assignment, id: "skyward-1" }];
  const canvas = [{ ...assignment, id: "canvas-1" }, { ...assignment, id: "canvas-2" }];
  assert(proposeAssignmentMatches(skyward, canvas).every(match => match.status === "ambiguous"));
  assert.equal(proposeAssignmentMatches([...skyward, { ...assignment, id: "skyward-2" }], canvas.slice(0, 1))[0].status, "ambiguous");
});

test("correlation recognizes embedded lesson and Science codes without guessing across dates or combined lessons", () => {
  const dueDate = "2026-09-29";
  const skyward = [
    { id: "1", title: "U2L1", dueDate },
    { id: "2", title: "TLAS 3 - Technology", dueDate },
    { id: "3", title: "I2C 2 - Calculating Volume", dueDate },
    { id: "4", title: "TLAS 6 - Measurement Application", dueDate },
  ];
  const matches = proposeAssignmentMatches(skyward, [
    { id: "10", title: "Sept 28: Unit 2 Lesson 1 Practice (A1.2.01)", dueDate },
    { id: "11", title: "TLAS 3 - Intro to Technology", dueDate },
    { id: "12", title: "I2C2 Volume Practice", dueDate },
    { id: "13", title: "U2L10", dueDate },
    { id: "14", title: "U2L1 and U2L2", dueDate },
    { id: "15", title: "TLAS 6 - Measurement Lab", dueDate },
    { id: "16", title: "TLAS 6 Measurement Application.docx", dueDate },
    { id: "17", title: "TLAS 3 - Intro to Technology", dueDate: "2026-09-30" },
  ]);
  assert.deepEqual(matches.map(match => match.status), ["candidate", "candidate", "candidate", "unmatched", "unmatched", "ambiguous", "ambiguous", "unmatched"]);
  assert.deepEqual(matches.slice(0, 3).map(match => match.candidates[0].skywardAssignmentId), ["1", "2", "3"]);
});

function sample(): CanvasAssignmentRun {
  const capturedAt = "2026-10-08T12:00:00.000Z";
  return { runId: randomUUID(), capturedAt, parserVersion: 1, status: "complete", discoveryComplete: true,
    students: [{ id: "10", name: "Synthetic Student", sortableName: "Student, Synthetic", status: "complete", discoveryComplete: true,
      courses: [{ id: "20", name: "Synthetic Algebra", code: "ALG1", termId: "30", status: "complete", pages: 1, scannedCount: 1, verifiedEmpty: false,
        assignments: [{ id: "40", courseId: "20", title: "U1L6 More Visual Patterns", description: "Synthetic instructions",
          dueAt: "2026-09-22T06:59:59.000Z", dueDate: "2026-09-21", unlockAt: null, lockAt: null, createdAt: null, updatedAt: null,
          pointsPossible: 5, gradingType: "points", submissionTypes: ["on_paper"], allowedExtensions: [], externalTool: false,
          lockedForUser: false, hasOverrides: false,
          source: { portal: "canvas", url: "https://canvas.example/courses/20/assignments/40", capturedAt, dateScope: "student" } }] }] }] };
}

test("batch correlation exposes date conflicts and counts competitors outside the matching window", () => {
  const source = { id: "1", title: "TLAS 6 - Application", dueDate: "2026-10-08" };
  const canvas = { id: "2", title: "TLAS 6 Application.docx", dueDate: "2026-10-08" };
  assert.equal(assessAssignmentLinks([source], [canvas])[0].status, "candidate");
  assert.equal(assessAssignmentLinks([source], [{ ...canvas, dueDate: "2026-10-09" }])[0].reason, "date-conflict");
  assert.equal(assessAssignmentLinks([source], [{ ...canvas, dueDate: null }])[0].reason, "undated");
  assert.equal(assessAssignmentLinks([source], [canvas, { ...canvas, id: "3", title: "TLAS 6 Lab", dueDate: "2026-09-01" }])[0].reason, "ambiguous");
  assert(assessAssignmentLinks([source, { ...source, id: "4", dueDate: "2026-09-01" }], [canvas]).every(match => match.reason === "ambiguous"));
  assert.equal(assessAssignmentLinks([source], [])[0].status, "unmatched");
});

test("matching lookback uses inclusive Pacific calendar dates across UTC midnight and DST", () => {
  assert.deepEqual(assignmentMatchWindow(2, new Date("2026-10-09T02:00:00Z")), {
    days: 2, startDate: "2026-10-07", endDate: "2026-10-08", timeZone: "America/Los_Angeles",
  });
  assert.equal(assignmentMatchWindow(2, new Date("2026-03-09T06:00:00Z")).startDate, "2026-03-07");
  assert.equal(assignmentMatchWindow(1, new Date("2026-11-01T12:00:00Z")).endDate, "2026-11-01");
  for (const invalid of [0, 367, -1, 1.5, NaN]) assert.throws(() => assignmentMatchWindow(invalid));
  assert.throws(() => assignmentMatchWindow(2, new Date(NaN)));
});

test("Canvas records preserve precise dates and require verified course and student coverage", () => {
  const run = sample();
  assert.deepEqual(canvasAssignmentRunSchema.parse(run), run);
  assert.equal(pacificDate("2026-03-09T06:59:59Z"), "2026-03-08");
  assert.throws(() => canvasAssignmentRunSchema.parse({ ...run, discoveryComplete: false }));
  const course = run.students[0].courses[0];
  assert.throws(() => canvasAssignmentSchema.parse({ ...course.assignments[0], dueDate: "2026-09-22" }));
  course.assignments = [];
  course.scannedCount = 0;
  assert.throws(() => canvasAssignmentRunSchema.parse(run));
  course.verifiedEmpty = true;
  assert.deepEqual(canvasAssignmentRunSchema.parse(run), run);
  course.status = "failed";
  assert.throws(() => canvasAssignmentRunSchema.parse(run));
});

function skywardSample(): AssignmentRun {
  return { runId: randomUUID(), capturedAt: "2026-10-08T12:00:00.000Z", parserVersion: 2, status: "complete", discoveryComplete: true,
    window: { days: 366, startDate: "2025-10-08", endDate: "2026-10-08", timeZone: "America/Los_Angeles" },
    students: [{ id: "skyward-student", firstName: "Synthetic", lastName: "Student", name: "Student, Synthetic", sections: [
      { kind: "upcoming", status: "complete", assignments: [], scannedCount: 0, pages: 1, verifiedEmpty: true },
      { kind: "missing", status: "complete", assignments: [], scannedCount: 0, pages: 1, verifiedEmpty: true },
      { kind: "past", status: "complete", assignments: [{ id: "skyward-assignment", title: "U1L6", course: "ALGEBRA 1", section: "23",
        teacher: "Synthetic Teacher", dueDate: "2026-09-21", assignedDate: null, description: null, category: null,
        grade: "A", score: "5.00", scoreStatus: null, maxScore: "5.00", weight: null, attempts: null, attachmentCount: null, missing: false,
        source: { portal: "skyward", url: "https://skyward.example/assignments", capturedAt: "2026-10-08T12:00:00.000Z" } }], scannedCount: 1, pages: 1, verifiedEmpty: false },
    ] }] };
}

const mappingInput = { canvasStudentId: "10", canvasCourseId: "20", skywardAccountId: "skyward-parent",
  skywardStudentId: "skyward-student", skywardCourse: "ALGEBRA 1", skywardSection: "23" };

test("Canvas snapshots deduplicate current assignments and incomplete runs cannot replace complete observations", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const first = sample();
    assert.equal(store.importCanvasAssignmentRun("canvas-parent", first), "imported");
    assert.equal(store.importCanvasAssignmentRun("canvas-parent", first), "already-imported");
    assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", first.runId), first);
    const newer = structuredClone(first);
    newer.runId = randomUUID();
    newer.capturedAt = "2026-10-08T14:00:00.000Z";
    newer.students[0].courses[0].assignments[0].source.capturedAt = newer.capturedAt;
    newer.students[0].courses[0].assignments[0].description = "Updated instructions";
    store.importCanvasAssignmentRun("canvas-parent", newer);
    const incomplete = structuredClone(newer);
    incomplete.runId = randomUUID();
    incomplete.status = "partial";
    incomplete.students[0].status = "partial";
    incomplete.students[0].courses[0].status = "partial";
    incomplete.students[0].courses[0].assignments[0].description = "Unverified instructions";
    store.importCanvasAssignmentRun("canvas-parent", incomplete);
    store.importCanvasAssignmentRun("canvas-parent", { ...first, runId: randomUUID() });
    const records = store.listCanvasAssignments("canvas-parent");
    assert.equal(records.length, 1);
    assert.equal(records[0].assignment.description, "Updated instructions");
    assert.equal(records[0].firstSeenAt, first.capturedAt);
    assert.equal(records[0].lastSeenAt, newer.capturedAt);
    assert.deepEqual(store.listCanvasAssignments("other"), []);
    assert.deepEqual(store.listCanvasAssignments("canvas-parent", { studentId: "11" }), []);
    assert.throws(() => store.importCanvasAssignmentRun("canvas-parent", { ...first, status: "partial" }), /Conflicting/);
  } finally { store.close(); }
});

test("explicit mappings and confirmed links enrich assignments without altering Skyward or rematching changed titles", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const skyward = skywardSample();
    const canvas = sample();
    store.importAssignmentRun("skyward-parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    assert.deepEqual(store.saveCanvasCourseMapping("canvas-parent", mappingInput), mapping);
    assert.throws(() => store.saveCanvasCourseMapping("canvas-parent", { ...mappingInput, skywardStudentId: "another" }), /Conflicting/);
    const proposals = store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id);
    assert.equal(proposals[0].status, "candidate");
    assert.equal(store.listEnrichedAssignments("skyward-parent")[0].canvas, null);
    const token = proposals[0].candidates[0].confirmationKey!;
    const link = store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token);
    assert.deepEqual(store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token), link);
    assert.equal(store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0].status, "linked");
    const updated = structuredClone(canvas);
    updated.runId = randomUUID();
    updated.capturedAt = "2026-10-09T12:00:00.000Z";
    const assignment = updated.students[0].courses[0].assignments[0];
    assignment.title = "Renamed lesson";
    assignment.dueAt = "2026-09-23T06:59:59.000Z";
    assignment.dueDate = "2026-09-22";
    assignment.pointsPossible = 100;
    assignment.description = "Changed instructions";
    assignment.source.capturedAt = updated.capturedAt;
    store.importCanvasAssignmentRun("canvas-parent", updated);
    const record = store.listEnrichedAssignments("skyward-parent")[0];
    assert.equal(record.assignment.score, "5.00");
    assert.equal(record.assignment.maxScore, "5.00");
    assert.equal(record.assignment.missing, false);
    assert.equal(record.assignment.description, null);
    assert.equal(record.canvas?.record.assignment.description, "Changed instructions");
    assert.equal(record.canvas?.link.id, link.id);
    assert.equal(record.canvas?.observedInLatestCollection, true);
    assert.deepEqual(record.canvas?.conflicts, ["due-date", "possible-points"]);
    assert.equal(record.skyward.observedInLatestCollection, true);
    assert.deepEqual(store.getAssignmentRun("skyward-parent", skyward.runId), skyward);
    assert.throws(() => store.confirmCanvasAssignmentLink("other", mapping.id, token), /No course mapping/);
    store.importCanvasAssignmentRun("canvas-parent", { runId: randomUUID(), capturedAt: "2026-10-10T12:00:00.000Z",
      parserVersion: 1, status: "auth-required", discoveryComplete: false, students: [], warning: "AUTH_REQUIRED" });
    const stale = store.listEnrichedAssignments("skyward-parent")[0].canvas!;
    assert.equal(stale.record.assignment.description, "Changed instructions");
    assert.equal(stale.scopeStatus, "not-observed");
    assert.equal(stale.observedInLatestCollection, false);
    assert.equal(stale.latestCollection?.status, "auth-required");
    const failedSkyward = { runId: randomUUID(), capturedAt: "2026-10-10T12:00:00.000Z", parserVersion: 2,
      status: "auth-required", discoveryComplete: false, students: [], window: skyward.window, warning: "AUTH_REQUIRED" };
    store.importAssignmentRun("skyward-parent", failedSkyward);
    const health = store.listEnrichedAssignments("skyward-parent")[0];
    assert.equal(health.skyward.observedInLatestCollection, false);
    assert.equal(health.skyward.scopeStatus, "not-observed");
    assert.equal(health.skyward.latestCollection?.status, "auth-required");
    assert.equal(health.canvasStatus, "linked");
  } finally { store.close(); }
});

test("stale proposal confirmations and ambiguous matches cannot create links", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const canvas = sample();
    store.importAssignmentRun("skyward-parent", skywardSample());
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const token = store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0].candidates[0].confirmationKey!;
    const updated = structuredClone(canvas);
    updated.runId = randomUUID();
    updated.capturedAt = "2026-10-09T12:00:00.000Z";
    store.importCanvasAssignmentRun("canvas-parent", updated);
    assert.throws(() => store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token), /stale/);
    const ambiguous = structuredClone(updated);
    ambiguous.runId = randomUUID();
    ambiguous.capturedAt = "2026-10-10T12:00:00.000Z";
    const course = ambiguous.students[0].courses[0];
    course.assignments.push({ ...course.assignments[0], id: "41", source: { ...course.assignments[0].source, url: "https://canvas.example/courses/20/assignments/41" } });
    course.scannedCount = 2;
    store.importCanvasAssignmentRun("canvas-parent", ambiguous);
    assert(store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id).every(proposal => proposal.status === "ambiguous"));
    assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
  } finally { store.close(); }
});

test("Canvas migration, audits, and encrypted backups preserve data and roll back failed imports and confirmations", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-canvas-"));
  const file = path.join(directory, "schoolhawk.sqlite");
  const key = randomBytes(32);
  try {
    new SqliteCanvasStore(file, key).close();
    const legacy = new Database(file);
    try {
      legacy.exec("DROP TRIGGER skyward_assignment_identity; DROP TABLE canvas_match_runs; DROP TABLE skyward_assignments; DROP TABLE canvas_assignments;");
      legacy.exec("DROP TABLE canvas_audit_events; DROP TABLE canvas_assignment_links; DROP TABLE canvas_course_mappings; DROP TABLE canvas_assignment_observations; DROP TABLE canvas_assignment_courses; DROP TABLE canvas_assignment_runs; PRAGMA user_version = 4;");
      assert.throws(() => new SqliteCanvasStore(file, randomBytes(32)), /Incorrect storage key/);
      assert.equal(legacy.pragma("user_version", { simple: true }), 4);
    } finally { legacy.close(); }
    const store = new SqliteCanvasStore(file, key);
    const connection = new Database(file);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 6);
      const canvas = sample();
      const skyward = skywardSample();
      store.importAssignmentRun("skyward-parent", skyward);
      store.importCanvasAssignmentRun("canvas-parent", canvas);
      connection.exec("CREATE TRIGGER fail_canvas_audit BEFORE INSERT ON canvas_audit_events BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;");
      assert.throws(() => store.importCanvasAssignmentRun("canvas-parent", sample()), /synthetic audit failure/);
      assert.equal(store.listCanvasAssignmentRuns("canvas-parent").length, 1);
      assert.throws(() => store.saveCanvasCourseMapping("canvas-parent", mappingInput), /synthetic audit failure/);
      assert.equal(store.listCanvasCourseMappings("canvas-parent").length, 0);
      connection.exec("DROP TRIGGER fail_canvas_audit;");
      const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
      const token = store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0].candidates[0].confirmationKey!;
      connection.exec("CREATE TRIGGER fail_canvas_audit BEFORE INSERT ON canvas_audit_events BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;");
      assert.throws(() => store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token), /synthetic audit failure/);
      assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
      connection.exec("DROP TRIGGER fail_canvas_audit;");
      const link = store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token);
      const identity = store.listAssignments("skyward-parent")[0];
      assert.equal(identity.canvasStatus, "linked");
      assert.equal(identity.canvasLinkId, link.id);
      assert.equal(identity.canvasAccountId, "canvas-parent");
      assert(identity.canvasRecordId);
      assert(connection.prepare("SELECT 1 FROM canvas_assignments WHERE record_id = ?").get(identity.canvasRecordId));
      connection.pragma("foreign_keys = ON");
      assert.throws(() => connection.prepare("DELETE FROM canvas_assignments WHERE record_id = ?").run(identity.canvasRecordId), /FOREIGN KEY/);
      assert.throws(() => connection.exec("UPDATE skyward_assignments SET canvas_status = 'pending', canvas_record_id = NULL, canvas_account_id = NULL, canvas_link_id = NULL"), /cannot be reassigned/);
      assert.deepEqual(connection.pragma("foreign_key_check"), []);
      assert.throws(() => connection.exec("DELETE FROM canvas_audit_events"), /append-only/);
      assert.throws(() => connection.exec("UPDATE canvas_audit_events SET action = 'import-run'"), /append-only/);
      const backup = path.join(directory, "backup.sqlite");
      await store.backup(backup);
      const restored = new SqliteCanvasStore(backup, key);
      try {
        assert.deepEqual(restored.getCanvasAssignmentRun("canvas-parent", canvas.runId), canvas);
        assert.deepEqual(restored.getAssignmentRun("skyward-parent", skyward.runId), skyward);
        assert.deepEqual(restored.listCanvasAssignmentLinks("canvas-parent"), [link]);
        assert.equal(restored.listEnrichedAssignments("skyward-parent")[0].canvas?.record.assignment.description, "Synthetic instructions");
      } finally { restored.close(); }
      for (const secret of ["Synthetic Student", "Synthetic instructions", "skyward-student", "skyward-assignment", "U1L6 More Visual Patterns"]) {
        assert.equal(readFileSync(backup).includes(Buffer.from(secret)), false);
      }
    } finally { connection.close(); store.close(); }
  } finally { key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

test("assignment query paging and Canvas identity isolation do not silently drop data", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const canvas = sample();
    canvas.students.push({ ...structuredClone(canvas.students[0]), id: "11", name: "Another Student" });
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    assert.equal(store.listCanvasAssignments("canvas-parent", { limit: 1, offset: 0 }).length, 1);
    assert.equal(store.listCanvasAssignments("canvas-parent", { limit: 1, offset: 1 }).length, 1);
    assert.equal(store.listCanvasAssignments("canvas-parent", { limit: 1, offset: 2 }).length, 0);
    store.importAssignmentRun("skyward-parent", skywardSample());
    const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const token = store.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0].candidates[0].confirmationKey!;
    store.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token);
    assert.throws(() => store.saveCanvasCourseMapping("canvas-parent", { ...mappingInput, canvasStudentId: "11" }), /Conflicting student/);
    assert.equal(store.listAssignments("skyward-parent", { offset: 1 }).length, 0);
    assert.throws(() => store.listAssignments("skyward-parent", { offset: -1 }));
    assert.throws(() => store.listCanvasAssignments("canvas-parent", { courseId: "20" }));
  } finally { store.close(); }
});

test("lookback matching retries unlinked assignments and skips established one-to-one links", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  const now = new Date("2026-10-08T18:00:00.000Z");
  try {
    const canvas = sample();
    const skyward = skywardSample();
    store.importAssignmentRun("skyward-parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    assert.throws(() => store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now }), /No confirmed course mapping/);
    const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const original = store.listAssignments("skyward-parent")[0];
    assert.equal(original.canvasStatus, "pending");
    const preview = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now, dryRun: true });
    assert.equal(preview.wouldLink, 1);
    assert.equal(preview.linked, 0);
    assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
    assert.deepEqual(store.listAssignments("skyward-parent")[0], original);
    assert.equal(store.getCanvasMatchRun("canvas-parent", preview.runId), undefined);
    const outside = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 2, now, mappingId: mapping.id });
    assert.equal(outside.outsideWindow, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].matchAttempts, 0);
    const matched = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now });
    assert.equal(matched.linked, 1);
    assert.deepEqual(store.getCanvasMatchRun("canvas-parent", matched.runId), matched);
    const record = store.listAssignments("skyward-parent")[0];
    assert.equal(record.canvasStatus, "linked");
    assert.equal(record.matchAttempts, 1);
    assert.equal(record.lastMatchAttemptAt, now.toISOString());
    assert.equal(store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now }).alreadyLinked, 1);
    assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].matchAttempts, 1);
    const updated = structuredClone(canvas);
    updated.runId = randomUUID(); updated.capturedAt = "2026-10-08T19:00:00.000Z";
    updated.students[0].courses[0].assignments[0].title = "Renamed assignment";
    updated.students[0].courses[0].assignments[0].source.capturedAt = updated.capturedAt;
    store.importCanvasAssignmentRun("canvas-parent", updated);
    const repeat = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now: new Date("2026-10-08T20:00:00Z") });
    assert.equal(repeat.alreadyLinked, 1);
    assert.equal(store.listEnrichedAssignments("skyward-parent")[0].canvas?.record.assignment.title, "Renamed assignment");
    assert.deepEqual(store.getAssignmentRun("skyward-parent", skyward.runId), skyward);
    assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", canvas.runId), canvas);
  } finally { store.close(); }
});

test("unmatched and date-conflicting assignments are reconsidered only while inside the lookback", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const skyward = skywardSample();
    const canvas = sample();
    const original = structuredClone(canvas.students[0].courses[0].assignments[0]);
    canvas.students[0].courses[0].assignments[0].title = "Unrelated work";
    store.importAssignmentRun("skyward-parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const options = { lookbackDays: 30, now: new Date("2026-10-08T18:00:00Z") };
    assert.equal(store.matchCanvasAssignments("canvas-parent", options).unmatched, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].canvasStatus, "unmatched");
    assert.equal(store.matchCanvasAssignments("canvas-parent", options).unmatched, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].matchAttempts, 2);
    const conflicting = sample();
    conflicting.capturedAt = "2026-10-08T19:00:00.000Z";
    conflicting.students[0].courses[0].assignments[0] = { ...original, dueDate: "2026-09-22", dueAt: "2026-09-23T06:59:59.000Z" };
    store.importCanvasAssignmentRun("canvas-parent", conflicting);
    const review = store.matchCanvasAssignments("canvas-parent", { ...options, now: new Date("2026-10-08T20:00:00Z") });
    assert.equal(review.reviewRequired, 1);
    assert.equal(review.items[0].reason, "date-conflict");
    const resolved = sample();
    resolved.capturedAt = "2026-10-08T21:00:00.000Z";
    resolved.students[0].courses[0].assignments[0].source.capturedAt = resolved.capturedAt;
    store.importCanvasAssignmentRun("canvas-parent", resolved);
    const retry = store.matchCanvasAssignments("canvas-parent", { ...options, now: new Date("2026-10-08T22:00:00Z") });
    assert.equal(retry.linked, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].matchAttempts, 4);
    assert.equal(store.listAssignments("skyward-parent")[0].canvasMatchReason, null);
  } finally { store.close(); }
});

test("automatic matching defers stale, incomplete, and no-longer-observed sources", () => {
  for (const mode of ["source-stale", "source-incomplete", "not-observed"] as const) {
    const store = new SqliteCanvasStore(":memory:", randomBytes(32));
    try {
      store.importAssignmentRun("skyward-parent", skywardSample());
      store.importCanvasAssignmentRun("canvas-parent", sample());
      store.saveCanvasCourseMapping("canvas-parent", mappingInput);
      if (mode === "source-incomplete") {
        store.importCanvasAssignmentRun("canvas-parent", { runId: randomUUID(), capturedAt: "2026-10-08T14:00:00Z",
          parserVersion: 1, status: "auth-required", discoveryComplete: false, students: [], warning: "AUTH_REQUIRED" });
      }
      if (mode === "not-observed") {
        const empty = skywardSample();
        empty.capturedAt = "2026-10-08T14:00:00.000Z";
        for (const section of empty.students[0].sections) { section.assignments = []; section.scannedCount = 0; section.verifiedEmpty = true; }
        store.importAssignmentRun("skyward-parent", empty);
      }
      const result = store.matchCanvasAssignments("canvas-parent", {
        lookbackDays: 30, now: new Date(mode === "source-stale" ? "2026-10-11T18:00:00Z" : "2026-10-08T18:00:00Z"),
      });
      assert.equal(result.items[0].reason, mode);
      assert.equal(result.reviewRequired, 1);
      assert.equal(store.listAssignments("skyward-parent")[0].canvasStatus, "review-required");
      assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
    } finally { store.close(); }
  }
});

test("matching includes the cutoff and today, excludes future and undated work, and stops retrying aged-out records", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const skyward = skywardSample();
    const original = skyward.students[0].sections[2].assignments[0];
    skyward.students[0].sections[2].assignments = [
      { ...original, id: "before-cutoff", dueDate: "2026-10-06" },
      { ...original, id: "on-cutoff", dueDate: "2026-10-07" },
      { ...original, id: "today", dueDate: "2026-10-08" },
    ];
    skyward.students[0].sections[2].scannedCount = 3;
    skyward.students[0].sections[0].assignments = [
      { ...original, id: "tomorrow", dueDate: "2026-10-09" },
      { ...original, id: "unknown-date", dueDate: null },
    ];
    skyward.students[0].sections[0].scannedCount = 2;
    skyward.students[0].sections[0].verifiedEmpty = false;
    const canvas = sample();
    canvas.students[0].courses[0].assignments = [];
    canvas.students[0].courses[0].scannedCount = 0;
    canvas.students[0].courses[0].verifiedEmpty = true;
    store.importAssignmentRun("skyward-parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", canvas);
    store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const first = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 2, now: new Date("2026-10-08T18:00:00Z") });
    assert.equal(first.unmatched, 2);
    assert.equal(first.outsideWindow, 2);
    assert.equal(first.undated, 1);
    assert.deepEqual(first.items.map(item => item.skywardAssignmentId).sort(), ["on-cutoff", "today"]);
    const second = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 2, now: new Date("2026-10-09T18:00:00Z") });
    assert.deepEqual(second.items.map(item => item.skywardAssignmentId).sort(), ["today", "tomorrow"]);
    const records = store.listAssignments("skyward-parent");
    assert.equal(records.find(record => record.assignment.id === "on-cutoff")!.matchAttempts, 1);
    assert.equal(records.find(record => record.assignment.id === "today")!.matchAttempts, 2);
    assert.equal(records.find(record => record.assignment.id === "before-cutoff")!.canvasStatus, "pending");
    assert.equal(records.find(record => record.assignment.id === "unknown-date")!.matchAttempts, 0);
  } finally { store.close(); }
});

test("automatic matching leaves many-to-one and cross-course scope conflicts for review", () => {
  for (const mode of ["ambiguous", "scope-conflict"] as const) {
    const store = new SqliteCanvasStore(":memory:", randomBytes(32));
    try {
      const canvas = sample();
      if (mode === "ambiguous") {
        const course = canvas.students[0].courses[0];
        course.assignments.push({ ...course.assignments[0], id: "41", title: "U1L6 Other materials",
          source: { ...course.assignments[0].source, url: "https://canvas.example/courses/20/assignments/41" } });
        course.scannedCount++;
      } else {
        const extra = structuredClone(canvas.students[0].courses[0]);
        extra.id = "21";
        extra.assignments[0].courseId = "21";
        extra.assignments[0].source.url = "https://canvas.example/courses/21/assignments/40";
        canvas.students[0].courses.push(extra);
      }
      store.importAssignmentRun("skyward-parent", skywardSample());
      store.importCanvasAssignmentRun("canvas-parent", canvas);
      const mapping = store.saveCanvasCourseMapping("canvas-parent", mappingInput);
      if (mode === "scope-conflict") store.saveCanvasCourseMapping("canvas-parent", { ...mappingInput, canvasCourseId: "21" });
      const result = store.matchCanvasAssignments("canvas-parent", { mappingId: mapping.id, lookbackDays: 30, now: new Date("2026-10-08T18:00:00Z") });
      assert.equal(result.reviewRequired, 1);
      assert.equal(result.items[0].reason, mode);
      assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
      assert.equal(store.listAssignments("skyward-parent")[0].canvasStatus, "review-required");
    } finally { store.close(); }
  }
});

test("matching processes assignment query pages without silently omitting eligible records", () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    const skyward = skywardSample();
    const section = skyward.students[0].sections[2];
    const assignment = section.assignments[0];
    section.assignments.push(...Array.from({ length: 1000 }, (_, index) => ({ ...assignment, id: `other-${index}`, title: `Unrelated work ${index}` })));
    section.scannedCount = 1001;
    store.importAssignmentRun("skyward-parent", skyward);
    store.importCanvasAssignmentRun("canvas-parent", sample());
    store.saveCanvasCourseMapping("canvas-parent", mappingInput);
    const result = store.matchCanvasAssignments("canvas-parent", { lookbackDays: 30, now: new Date("2026-10-08T18:00:00Z") });
    assert.equal(result.linked, 1);
    assert.equal(result.unmatched, 1000);
    assert.equal(result.items.length, 1001);
    assert.equal(store.listAssignments("skyward-parent", { limit: 1000, offset: 1000 })[0].matchAttempts, 1);
  } finally { store.close(); }
});

test("version-5 identities and confirmed links backfill without altering snapshots, and batch audit failures roll back atomically", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-link-status-"));
  const file = path.join(directory, "schoolhawk.sqlite");
  const key = randomBytes(32);
  try {
    const initial = new SqliteCanvasStore(file, key);
    const skyward = skywardSample();
    const canvas = sample();
    const secondSkyward = { ...skyward.students[0].sections[2].assignments[0], id: "second-assignment", title: "Unit 1 Review" };
    skyward.students[0].sections[2].assignments.push(secondSkyward);
    skyward.students[0].sections[2].scannedCount++;
    const firstCanvas = canvas.students[0].courses[0].assignments[0];
    canvas.students[0].courses[0].assignments.push({ ...firstCanvas, id: "41", title: "U1 Review",
      source: { ...firstCanvas.source, url: "https://canvas.example/courses/20/assignments/41" } });
    canvas.students[0].courses[0].scannedCount++;
    let existingLink;
    let mapping;
    try {
      initial.importAssignmentRun("skyward-parent", skyward);
      initial.importCanvasAssignmentRun("canvas-parent", canvas);
      mapping = initial.saveCanvasCourseMapping("canvas-parent", mappingInput);
      const token = initial.proposeCanvasAssignmentLinks("canvas-parent", mapping.id)[0].candidates[0].confirmationKey!;
      existingLink = initial.confirmCanvasAssignmentLink("canvas-parent", mapping.id, token);
    } finally { initial.close(); }
    const legacy = new Database(file);
    const oldSkyward = legacy.prepare("SELECT content_hash, payload FROM assignment_runs").all();
    const oldCanvas = legacy.prepare("SELECT content_hash, payload FROM canvas_assignment_runs").all();
    try {
      legacy.exec(`DROP TRIGGER skyward_assignment_identity; DROP TRIGGER canvas_assignment_identity;
        DROP TRIGGER canvas_link_requires_identity; DROP TRIGGER canvas_link_status;
        DROP TABLE canvas_match_runs; DROP TABLE skyward_assignments; DROP TABLE canvas_assignments;
        DROP INDEX canvas_link_identity; PRAGMA user_version = 5;`);
      assert.throws(() => new SqliteCanvasStore(file, randomBytes(32)), /Incorrect storage key/);
      assert.equal(legacy.pragma("user_version", { simple: true }), 5);
      assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'skyward_assignments'").get(), undefined);
    } finally { legacy.close(); }
    const store = new SqliteCanvasStore(file, key);
    const connection = new Database(file);
    try {
      connection.pragma("foreign_keys = ON");
      assert.equal(connection.pragma("user_version", { simple: true }), 6);
      assert.deepEqual(connection.prepare("SELECT content_hash, payload FROM assignment_runs").all(), oldSkyward);
      assert.deepEqual(connection.prepare("SELECT content_hash, payload FROM canvas_assignment_runs").all(), oldCanvas);
      assert.deepEqual(store.listCanvasAssignmentLinks("canvas-parent"), [existingLink]);
      const before = store.listAssignments("skyward-parent");
      assert.equal(before.find(record => record.assignment.id === "skyward-assignment")!.canvasStatus, "linked");
      assert.equal(before.find(record => record.assignment.id === "second-assignment")!.canvasStatus, "pending");
      const linked = before.find(record => record.canvasStatus === "linked")!;
      assert.throws(() => connection.prepare(`UPDATE skyward_assignments SET canvas_status = 'linked', canvas_account_id = ?, canvas_record_id = ?, canvas_link_id = ?
        WHERE canvas_status = 'pending'`).run(linked.canvasAccountId, linked.canvasRecordId, linked.canvasLinkId), /UNIQUE|FOREIGN KEY/);
      const auditCount = connection.prepare("SELECT COUNT(*) AS count FROM canvas_audit_events").get();
      connection.exec("CREATE TRIGGER fail_matching_audit BEFORE INSERT ON canvas_match_runs BEGIN SELECT RAISE(ABORT, 'synthetic matching audit failure'); END;");
      const options = { lookbackDays: 30, mappingId: mapping!.id, now: new Date("2026-10-08T18:00:00Z") };
      assert.throws(() => store.matchCanvasAssignments("canvas-parent", options), /synthetic matching audit failure/);
      assert.deepEqual(store.listAssignments("skyward-parent"), before);
      assert.deepEqual(store.listCanvasAssignmentLinks("canvas-parent"), [existingLink]);
      assert.deepEqual(connection.prepare("SELECT COUNT(*) AS count FROM canvas_audit_events").get(), auditCount);
      connection.exec("DROP TRIGGER fail_matching_audit;");
      const matched = store.matchCanvasAssignments("canvas-parent", options);
      assert.equal(matched.linked, 1);
      assert.equal(matched.alreadyLinked, 1);
      assert.equal(matched.items.find(item => item.status === "linked")!.latestCanvasRunId, canvas.runId);
      assert.throws(() => connection.exec("DELETE FROM canvas_match_runs"), /append-only/);
      assert.throws(() => connection.exec("UPDATE canvas_match_runs SET lookback_days = 1"), /append-only/);
      assert.deepEqual(connection.pragma("foreign_key_check"), []);
      const backup = path.join(directory, "backup.sqlite");
      await store.backup(backup);
      const restored = new SqliteCanvasStore(backup, key);
      try {
        assert.deepEqual(restored.getCanvasMatchRun("canvas-parent", matched.runId), matched);
        assert.equal(restored.getCanvasMatchRun("other", matched.runId), undefined);
        assert(restored.listEnrichedAssignments("skyward-parent").every(record => record.canvasStatus === "linked" && record.canvas));
        assert.deepEqual(restored.getAssignmentRun("skyward-parent", skyward.runId), skyward);
        assert.deepEqual(restored.getCanvasAssignmentRun("canvas-parent", canvas.runId), canvas);
      } finally { restored.close(); }
      for (const secret of ["Synthetic Student", "skyward-student", "skyward-assignment", "Synthetic instructions", "second-assignment"]) {
        assert.equal(readFileSync(backup).includes(Buffer.from(secret)), false);
      }
    } finally { connection.close(); store.close(); }
  } finally { key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});