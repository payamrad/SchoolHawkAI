import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { gradeRecordSchema, gradeRunSchema, type CollectedGrade, type GradeRun } from "@schoolhawk/core/grades";
import { SqliteMessageStore } from "../sqlite-message-store";

function grade(): CollectedGrade {
  return {
    id: "grade-bucket-1", studentSectionId: "section-1", courseCode: "SYNTHETIC", course: "Synthetic Course", classDetails: null, section: "A", teacher: null,
    termId: "term-1", term: "Quarter 1", periodStatus: "open", schoolYear: "2026-2027", grade: null, score: null,
    maxScore: null, gradingScale: null, effectiveDate: null,
    source: { portal: "skyward", url: "https://example.test/grades", capturedAt: "2026-09-27T12:00:00.000Z" },
  };
}

test("grade records preserve source marks and distinguish unknown scores from zero", () => {
  for (const values of [
    { grade: "A", score: "93.5%", gradingScale: null },
    { grade: "Meeting standard", score: "3", gradingScale: "Standards-based" },
    { grade: null, score: null, gradingScale: null },
    { grade: "0", score: "0", gradingScale: null },
  ]) {
    const input = { ...grade(), ...values };
    assert.deepEqual(gradeRecordSchema.parse(input), input);
  }
  assert.throws(() => gradeRecordSchema.parse({ ...grade(), score: 0 }));
  assert.throws(() => gradeRecordSchema.parse({ ...grade(), grade: "" }));
  assert.throws(() => gradeRecordSchema.parse({ ...grade(), source: { ...grade().source, url: "https://example.test/grades?token=private" } }));
});

function sample(): GradeRun {
  return {
    runId: randomUUID(), capturedAt: "2026-09-27T12:00:00.000Z", parserVersion: 1, status: "complete", discoveryComplete: true,
    students: [{ id: "student-1", name: "PRIVATE-LAST, PRIVATE-FIRST", firstName: "PRIVATE-FIRST", lastName: "PRIVATE-LAST",
      status: "complete", grades: [{ ...grade(), grade: "PRIVATE-GRADE" }], periods: ["Quarter 1"], scannedCount: 1, pages: 1, verifiedEmpty: false }],
  };
}

test("grade coverage requires all students and positively verified empty states", () => {
  const run = sample();
  assert.deepEqual(gradeRunSchema.parse(run), run);
  assert.throws(() => gradeRunSchema.parse({ ...run, discoveryComplete: false }));
  assert.throws(() => gradeRunSchema.parse({ ...run, students: [] }));
  assert.throws(() => gradeRunSchema.parse({ ...run, students: [run.students[0], run.students[0]] }));
  const student = run.students[0];
  student.status = "failed";
  assert.throws(() => gradeRunSchema.parse(run));
  run.status = "partial";
  assert.deepEqual(gradeRunSchema.parse(run), run);
  student.status = "complete";
  student.grades = [];
  student.scannedCount = 0;
  run.status = "complete";
  assert.throws(() => gradeRunSchema.parse(run));
  student.verifiedEmpty = true;
  assert.deepEqual(gradeRunSchema.parse(run), run);
});

test("grade imports are idempotent with separate account and student identities", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const run = sample();
    run.students.push({ ...structuredClone(run.students[0]), id: "student-2", firstName: "OTHER-FIRST" });
    assert.equal(store.importGradeRun("parent", run), "imported");
    assert.equal(store.importGradeRun("parent", run), "already-imported");
    assert.deepEqual(store.getGradeRun("parent", run.runId), run);
    assert.equal(store.listGrades("parent").length, 2);
    assert.equal(store.listGrades("parent", { studentId: "student-2" })[0].student.firstName, "OTHER-FIRST");
    assert.equal(store.listGradeRuns("parent").length, 1);
    assert.deepEqual(store.listGrades("other"), []);
    assert.equal(store.getGradeRun("other", run.runId), undefined);
    store.importGradeRun("other", run);
    assert.equal(store.listGrades("other").length, 2);
    assert.throws(() => store.importGradeRun("parent", { ...run, status: "partial" }), /Conflicting/);
    assert.throws(() => store.listGrades("parent", { limit: 0 }));
  } finally { store.close(); }
});

test("grade changes retain identity and complete students advance independently of failed students", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const first = sample();
    store.importGradeRun("parent", first);
    const latest = structuredClone(first);
    latest.runId = randomUUID();
    latest.capturedAt = "2026-09-27T14:00:00.000Z";
    latest.status = "partial";
    latest.students[0].grades[0].grade = "Updated grade";
    latest.students[0].grades[0].source.capturedAt = latest.capturedAt;
    latest.students.push({ ...structuredClone(latest.students[0]), id: "student-2", status: "failed" });
    store.importGradeRun("parent", latest);
    const failed = structuredClone(latest);
    failed.runId = randomUUID();
    failed.students[0].status = "partial";
    failed.students[0].grades[0].source.capturedAt = "2026-09-27T15:00:00.000Z";
    failed.students[0].grades[0].grade = "Unverified grade";
    store.importGradeRun("parent", failed);
    store.importGradeRun("parent", { ...first, runId: randomUUID() });
    const empty = sample();
    empty.students[0].grades = [];
    empty.students[0].scannedCount = 0;
    empty.students[0].verifiedEmpty = true;
    store.importGradeRun("parent", empty);
    const records = store.listGrades("parent");
    assert.equal(records.length, 1);
    assert.equal(records[0].grade.id, first.students[0].grades[0].id);
    assert.equal(records[0].grade.grade, "Updated grade");
    assert.equal(records[0].firstSeenAt, first.capturedAt);
    assert.equal(records[0].lastSeenAt, latest.capturedAt);
  } finally { store.close(); }
});

test("version-3 databases upgrade after key verification and grade writes are encrypted, atomic, audited, and backed up", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-grades-"));
  const file = path.join(directory, "schoolhawk.sqlite");
  const key = randomBytes(32);
  try {
    new SqliteMessageStore(file, key).close();
    const legacy = new Database(file);
    try {
      legacy.exec("DROP TABLE agent_reports; DROP TABLE review_evaluations; DROP TABLE review_events; DROP TABLE review_profiles;");
      legacy.exec("DROP TRIGGER skyward_assignment_identity; DROP TABLE canvas_match_runs; DROP TABLE skyward_assignments; DROP TABLE canvas_assignments;");
      legacy.exec("DROP TABLE canvas_audit_events; DROP TABLE canvas_assignment_links; DROP TABLE canvas_course_mappings; DROP TABLE canvas_assignment_observations; DROP TABLE canvas_assignment_courses; DROP TABLE canvas_assignment_runs; DROP TABLE grade_import_events; DROP TABLE grade_observations; DROP TABLE grade_students; DROP TABLE grade_runs; PRAGMA user_version = 3;");
      assert.throws(() => new SqliteMessageStore(file, randomBytes(32)), /Incorrect storage key/);
      assert.equal(legacy.pragma("user_version", { simple: true }), 3);
    } finally { legacy.close(); }
    const store = new SqliteMessageStore(file, key);
    try {
      const run = sample();
      store.importGradeRun("parent", run);
      const connection = new Database(file);
      try {
        assert.equal(connection.pragma("user_version", { simple: true }), 8);
        connection.exec("CREATE TRIGGER fail_grade BEFORE INSERT ON grade_observations BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
        assert.throws(() => store.importGradeRun("parent", sample()), /test failure/);
        assert.equal(store.listGradeRuns("parent").length, 1);
        assert.throws(() => connection.exec("DELETE FROM grade_import_events"), /append-only/);
        assert.throws(() => connection.exec("UPDATE grade_import_events SET imported_at = 'changed'"), /append-only/);
        connection.exec("DROP TRIGGER fail_grade;");
      } finally { connection.close(); }
      const backup = path.join(directory, "backup.sqlite");
      await store.backup(backup);
      const restored = new SqliteMessageStore(backup, key);
      try { assert.deepEqual(restored.getGradeRun("parent", run.runId), run); }
      finally { restored.close(); }
      for (const secret of ["PRIVATE-FIRST", "PRIVATE-LAST", "PRIVATE-GRADE", "student-1", "grade-bucket-1"]) {
        assert.equal(readFileSync(backup).includes(Buffer.from(secret)), false);
      }
    } finally { store.close(); }
  } finally { key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});