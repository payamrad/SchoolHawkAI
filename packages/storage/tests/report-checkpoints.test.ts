import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "vitest";
import { type ReportCheckpoint } from "@schoolhawk/core/agent-reports";
import { withDiagnosticSink } from "@schoolhawk/core/diagnostics";
import { savedReport } from "../../communication/tests/fixtures";
import { SqliteReviewStore } from "../sqlite-review-store";
import { AgentReportStorageError } from "../agent-reports";

test("report checkpoints survive reopen and backup without exposing the input hash in SQLite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-report-checkpoints-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const backup = path.join(root, "backup.sqlite");
  const key = randomBytes(32);
  let store = new SqliteReviewStore(file, key);
  try {
    const { version: _version, reportId: _id, savedAt: _time, ...analysis } = savedReport();
    const report = store.saveAgentReport(analysis);
    const checkpoint: ReportCheckpoint = {
      version: 1, scopeHash: "a".repeat(64), inputHash: "b".repeat(64), reportIds: [report.reportId],
      savedAt: report.savedAt, deliveryIncomplete: false,
    };
    assert.equal(store.getReportCheckpoint(checkpoint.scopeHash), undefined);
    store.saveReportCheckpoint(checkpoint);
    await store.backup(backup);
    store.close();
    store = new SqliteReviewStore(file, key);
    assert.deepEqual(store.getReportCheckpoint(checkpoint.scopeHash), checkpoint);
    const restored = new SqliteReviewStore(backup, key);
    try { assert.deepEqual(restored.getReportCheckpoint(checkpoint.scopeHash), checkpoint); }
    finally { restored.close(); }
    assert(!readFileSync(backup).includes(Buffer.from(checkpoint.inputHash)));
    assert(!readFileSync(backup).includes(Buffer.from(analysis.text)));
    const connection = new Database(file);
    try {
      connection.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON report_checkpoints BEGIN SELECT RAISE(ABORT, 'PRIVATE_WRITE_ERROR'); END;");
      withDiagnosticSink(() => {}, () => assert.throws(() =>
        store.saveReportCheckpoint({ ...checkpoint, inputHash: "c".repeat(64) }), AgentReportStorageError));
      assert.deepEqual(store.getReportCheckpoint(checkpoint.scopeHash), checkpoint);
    } finally { connection.close(); }
    withDiagnosticSink(() => {}, () => assert.throws(() => store.saveReportCheckpoint({
      ...checkpoint, scopeHash: "d".repeat(64), reportIds: [`report_${"e".repeat(64)}`],
    }), AgentReportStorageError));
    assert.equal(store.getReportCheckpoint("d".repeat(64)), undefined);
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test("version-8 upgrades preserve AI reports and start without a guessed checkpoint", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-checkpoint-migration-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const key = randomBytes(32);
  let store = new SqliteReviewStore(file, key);
  try {
    const { version: _version, reportId: _id, savedAt: _time, ...analysis } = savedReport();
    const report = store.saveAgentReport(analysis);
    store.close();
    const connection = new Database(file);
    try {
      connection.exec("DROP TABLE email_communications; DROP TABLE report_checkpoints; PRAGMA user_version = 8;");
      withDiagnosticSink(() => {}, () => assert.throws(() => new SqliteReviewStore(file, randomBytes(32)), /Incorrect storage key/));
      assert.equal(connection.pragma("user_version", { simple: true }), 8);
    } finally { connection.close(); }
    store = new SqliteReviewStore(file, key);
    assert.deepEqual(store.getAgentReport(report.reportId), report);
    assert.equal(store.getReportCheckpoint("a".repeat(64)), undefined);
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});
