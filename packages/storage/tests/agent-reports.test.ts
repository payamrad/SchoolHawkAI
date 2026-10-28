import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "vitest";
import {
  MAX_AGENT_RESPONSE_BYTES, storedAgentReportSchema, studentReportAnalysisSchema, type StudentReportAnalysis,
} from "@schoolhawk/core/agent-reports";
import { withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { studentReportFixture } from "../../agent/tests/fixtures";
import { assignmentRun, config, instant } from "../../core/tests/review-fixtures";
import { AgentReportStorageError } from "../agent-reports";
import { SqliteReviewStore } from "../sqlite-review-store";

function analysis(overrides: Partial<StudentReportAnalysis> = {}): StudentReportAnalysis {
  const report = studentReportFixture();
  return studentReportAnalysisSchema.parse({
    provider: "azure-foundry", responseId: "resp_fixture", receivedAt: instant, durationMs: 1234,
    text: "PRIVATE_AI_REPORT_TEXT\nKeep the complete response, including strengths and parent-attention recommendations.",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    kind: "student-report-analysis", snapshotId: report.id, reviewId: report.reviewId,
    studentRefs: report.students.map(student => student.id), sourceStatus: "incomplete-source-coverage",
    students: report.students.map(student => ({ ref: student.id, name: student.label })),
    sourceNotices: ["collection-incomplete"], validation: "unverified-ai-analysis", ...overrides,
  });
}

test("AI reports survive close/reopen and backup, with their full response and provenance encrypted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-ai-reports-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const backup = path.join(root, "backup.sqlite");
  const key = randomBytes(32);
  const value = analysis({ usage: undefined });
  let store = new SqliteReviewStore(file, key);
  try {
    const saved = store.saveAgentReport(value, new Date("2026-10-10T16:01:00Z"));
    assert.deepEqual(storedAgentReportSchema.parse(saved), saved);
    assert.equal(saved.text, value.text);
    assert.equal(saved.snapshotId, value.snapshotId);
    assert.deepEqual(saved.sourceNotices, value.sourceNotices);
    assert.deepEqual(saved.usage, value.usage);
    assert.deepEqual(saved.students, value.students);
    assert.equal(saved.validation, "unverified-ai-analysis");
    await store.backup(backup);
    store.close();
    store = new SqliteReviewStore(file, key);
    assert.deepEqual(store.getAgentReport(saved.reportId), saved);
    const restored = new SqliteReviewStore(backup, key);
    try { assert.deepEqual(restored.getAgentReport(saved.reportId), saved); }
    finally { restored.close(); }
    const connection = new Database(file, { readonly: true });
    try {
      const row = connection.prepare("SELECT payload FROM agent_reports WHERE report_id = ?").get(saved.reportId);
      assert(row && typeof row === "object" && "payload" in row && Buffer.isBuffer(row.payload));
      assert(!row.payload.includes(Buffer.from(value.text)));
      assert(!row.payload.includes(Buffer.from(value.snapshotId)));
    } finally { connection.close(); }
    assert.doesNotMatch(readFileSync(backup).toString("utf8"), /PRIVATE_AI_REPORT_TEXT|parent-attention recommendations/);
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test("identical response saves are idempotent and conflicting reuse cannot overwrite an existing report", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const value = analysis();
    const first = store.saveAgentReport(value, new Date(instant));
    assert.deepEqual(store.saveAgentReport(structuredClone(value), new Date("2026-10-11T16:00:00Z")), first);
    withDiagnosticSink(() => {}, () => assert.throws(() =>
      store.saveAgentReport({ ...value, text: "Changed response" }), /already saved with different contents/));
    assert.deepEqual(store.getAgentReport(first.reportId), first);
    assert.equal(store.listAgentReports().length, 1);
    const otherProvider = store.saveAgentReport({ ...value, provider: "another-agent" });
    assert.notEqual(otherProvider.reportId, first.reportId);
    assert.equal(store.listAgentReports().length, 2);
  } finally { store.close(); }
});

test("legacy reports without name metadata remain readable while new name/reference mismatches are rejected", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const old = store.saveAgentReport(analysis({ students: undefined }));
    assert.equal(store.getAgentReport(old.reportId)!.students, undefined);
    const value = analysis({ responseId: "resp_named" });
    withDiagnosticSink(() => {}, () => {
      assert.throws(() => store.saveAgentReport({ ...value, students: [{ ref: value.studentRefs[0], name: "Nicole" }] }), AgentReportStorageError);
      assert.throws(() => store.saveAgentReport({ ...value,
        students: value.studentRefs.map(ref => ({ ref, name: "student 1" })) }), AgentReportStorageError);
    });
    assert.equal(store.listAgentReports().length, 1);
  } finally { store.close(); }
});
test("report listings are bounded metadata, ordered by receipt time, and full lookup requires a valid ID", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const first = store.saveAgentReport(analysis({ responseId: "resp_old", receivedAt: instant }));
    const second = store.saveAgentReport(analysis({ responseId: "resp_new", receivedAt: "2026-10-11T16:00:00Z" }));
    const newest = store.listAgentReports({ limit: 1 });
    assert.equal(newest[0].reportId, second.reportId);
    assert.equal(newest[0].studentCount, 2);
    assert.equal(Object.hasOwn(newest[0], "text"), false);
    assert.equal(Object.hasOwn(newest[0], "studentRefs"), false);
    assert.equal(store.listAgentReports({ limit: 1, offset: 1 })[0].reportId, first.reportId);
    assert.deepEqual(store.listAgentReports({ offset: 2 }), []);
    assert.throws(() => store.listAgentReports({ limit: 0 }));
    assert.throws(() => store.listAgentReports({ limit: 1001 }));
    assert.throws(() => store.listAgentReports({ offset: -1 }));
    assert.throws(() => store.getAgentReport("resp_old"), AgentReportStorageError);
    assert.equal(store.getAgentReport(`report_${"0".repeat(64)}`), undefined);
  } finally { store.close(); }
});

test("invalid responses, unknown credential fields, and oversized UTF-8 text are rejected rather than partially saved", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const value = analysis();
    for (const invalid of [
      { ...value, text: "   " }, { ...value, snapshotId: "unknown" },
      { ...value, studentRefs: [value.studentRefs[0], value.studentRefs[0]] },
      { ...value, apiKey: "PRIVATE_CREDENTIAL" },
      { ...value, kind: "connection-test", connected: true },
      { ...value, text: "\u00e9".repeat(MAX_AGENT_RESPONSE_BYTES / 2 + 1) },
    ]) {
      withDiagnosticSink(() => {}, () => assert.throws(() => store.saveAgentReport(invalid), AgentReportStorageError));
    }
    assert.deepEqual(store.listAgentReports(), []);
  } finally { store.close(); }
});

test("storage failures roll back the report insert and neither error messages nor diagnostics expose AI text", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-ai-report-failure-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const key = randomBytes(32);
  const store = new SqliteReviewStore(file, key);
  const connection = new Database(file);
  try {
    connection.exec("CREATE TRIGGER fail_agent_report BEFORE INSERT ON agent_reports BEGIN SELECT RAISE(ABORT, 'PRIVATE_DATABASE_FAILURE'); END;");
    const events: DiagnosticEvent[] = [];
    withDiagnosticSink(event => events.push(event), () => assert.throws(() => store.saveAgentReport(analysis()), error => {
      assert(error instanceof AgentReportStorageError);
      assert.doesNotMatch(error.message, /PRIVATE|parent-attention/);
      return true;
    }));
    assert.deepEqual(store.listAgentReports(), []);
    assert(events.some(event => event.code === "STORAGE_WRITE_FAILED"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|parent-attention/);
    connection.exec("DROP TRIGGER fail_agent_report;");
    const saved = store.saveAgentReport(analysis());
    assert.throws(() => connection.exec("UPDATE agent_reports SET student_count = 0"), /append-only/);
    assert.throws(() => connection.exec("DELETE FROM agent_reports"), /append-only/);
    connection.exec("DROP TRIGGER agent_reports_no_update; UPDATE agent_reports SET student_count = 0;");
    assert.throws(() => store.getAgentReport(saved.reportId), /metadata does not match/);
  } finally { connection.close(); store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test("version-7 databases migrate without rewriting source or review history, and wrong keys cannot migrate them", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-ai-report-migration-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const key = randomBytes(32);
  let store = new SqliteReviewStore(file, key);
  try {
    const source = assignmentRun();
    store.importAssignmentRun("parent", source);
    const reviewed = store.processReview(config(), new Date(instant));
    store.close();
    const legacy = new Database(file);
    const original = legacy.prepare("SELECT content_hash, payload FROM assignment_runs").all();
    try {
      legacy.exec("DROP TABLE email_communications; DROP TABLE report_checkpoints; DROP TABLE agent_reports; PRAGMA user_version = 7;");
      withDiagnosticSink(() => {}, () => assert.throws(() => new SqliteReviewStore(file, randomBytes(32)), /Incorrect storage key/));
      assert.equal(legacy.pragma("user_version", { simple: true }), 7);
      assert.equal(legacy.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_reports'").get(), undefined);
    } finally { legacy.close(); }
    store = new SqliteReviewStore(file, key);
    assert.deepEqual(store.getReview("family"), reviewed);
    assert.deepEqual(store.getAssignmentRun("parent", source.runId), source);
    assert.deepEqual(store.listAgentReports(), []);
    const current = new Database(file, { readonly: true });
    try {
      assert.equal(current.pragma("user_version", { simple: true }), 10);
      assert.deepEqual(current.prepare("SELECT content_hash, payload FROM assignment_runs").all(), original);
    } finally { current.close(); }
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});
