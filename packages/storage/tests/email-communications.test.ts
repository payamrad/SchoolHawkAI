import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "vitest";
import { type EmailCommunication } from "@schoolhawk/core/agent-reports";
import { withDiagnosticSink } from "@schoolhawk/core/diagnostics";
import { savedReport } from "../../communication/tests/fixtures";
import { AgentReportStorageError } from "../agent-reports";
import { SqliteReviewStore } from "../sqlite-review-store";

function seed(store: SqliteReviewStore, studentRefs = savedReport().studentRefs, responseId = "resp_email") {
  const { version: _version, reportId: _id, savedAt: _time, ...analysis } = savedReport();
  const report = store.saveAgentReport({ ...analysis, responseId, studentRefs,
    students: analysis.students?.filter(student => studentRefs.includes(student.ref)) });
  const email: EmailCommunication = {
    reportId: report.reportId, studentRefs, kind: "report", acceptedAt: "2026-10-10T16:00:00.000Z",
    subject: "School update", text: "PRIVATE_SENT_EMAIL: an improvement and unresolved missing work.",
  };
  return email;
}

test("accepted email history survives reopen and backup encrypted, without treating drafts as sent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-email-history-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const backup = path.join(root, "backup.sqlite");
  const key = randomBytes(32);
  let store = new SqliteReviewStore(file, key);
  try {
    const report = seed(store);
    assert.equal(store.getPreviousCommunication(report.studentRefs), undefined);
    store.saveEmailCommunication(report);
    const notice: EmailCommunication = { ...report, kind: "no-change", subject: "No new data",
      text: "PRIVATE_NO_CHANGE_EMAIL", acceptedAt: "2026-10-11T16:00:00.000Z" };
    store.saveEmailCommunication(notice);
    store.saveEmailCommunication({ ...notice, acceptedAt: "2026-10-09T16:00:00.000Z", text: "Older receipt" });
    const expected = { latestEmail: notice, latestReportEmail: report };
    assert.deepEqual(store.getPreviousCommunication(report.studentRefs.slice().reverse()), expected);
    await store.backup(backup);
    store.close();
    store = new SqliteReviewStore(file, key);
    assert.deepEqual(store.getPreviousCommunication(report.studentRefs), expected);
    const restored = new SqliteReviewStore(backup, key);
    try { assert.deepEqual(restored.getPreviousCommunication(report.studentRefs), expected); }
    finally { restored.close(); }
    assert.doesNotMatch(readFileSync(backup).toString("utf8"), /PRIVATE_SENT_EMAIL|PRIVATE_NO_CHANGE_EMAIL|School update/);
    const next = { ...report, acceptedAt: "2026-10-12T16:00:00.000Z", text: "New full report" };
    store.saveEmailCommunication(next);
    assert.deepEqual(store.getPreviousCommunication(report.studentRefs), { latestEmail: next });
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});

test("student and family email histories stay isolated and mismatched or nonexistent report references fail", () => {
  const store = new SqliteReviewStore(":memory:", randomBytes(32));
  try {
    const family = seed(store);
    store.saveEmailCommunication(family);
    const [first, second] = family.studentRefs;
    assert.equal(store.getPreviousCommunication([first]), undefined);
    const child = seed(store, [first], "resp_child");
    store.saveEmailCommunication(child);
    assert.deepEqual(store.getPreviousCommunication([first]), { latestEmail: child });
    assert.equal(store.getPreviousCommunication([second]), undefined);
    assert.deepEqual(store.getPreviousCommunication(family.studentRefs), { latestEmail: family });
    const empty = seed(store, [], "resp_no_students");
    store.saveEmailCommunication(empty);
    assert.deepEqual(store.getPreviousCommunication([]), { latestEmail: empty });
    withDiagnosticSink(() => {}, () => {
      assert.throws(() => store.saveEmailCommunication({ ...family, studentRefs: [second] }), AgentReportStorageError);
      assert.throws(() => store.saveEmailCommunication({ ...family, reportId: `report_${"0".repeat(64)}` }), AgentReportStorageError);
      assert.throws(() => store.saveEmailCommunication({ ...family, studentRefs: [first, first] }), AgentReportStorageError);
    });
  } finally { store.close(); }
});

test("version-9 upgrades preserve reports without guessing delivery, and corrupt context or failed writes are explicit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-email-migration-"));
  const file = path.join(root, "schoolhawk.sqlite");
  const key = randomBytes(32);
  let store = new SqliteReviewStore(file, key);
  try {
    const email = seed(store);
    store.close();
    const legacy = new Database(file);
    try {
      legacy.exec("DROP TABLE email_communications; PRAGMA user_version = 9;");
      withDiagnosticSink(() => {}, () => assert.throws(() => new SqliteReviewStore(file, randomBytes(32)), /Incorrect storage key/));
      assert.equal(legacy.pragma("user_version", { simple: true }), 9);
    } finally { legacy.close(); }
    store = new SqliteReviewStore(file, key);
    assert(store.getAgentReport(email.reportId));
    assert.equal(store.getPreviousCommunication(email.studentRefs), undefined);
    store.saveEmailCommunication(email);
    const connection = new Database(file);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 10);
      connection.exec("CREATE TRIGGER fail_email BEFORE UPDATE ON email_communications BEGIN SELECT RAISE(ABORT, 'PRIVATE_WRITE_ERROR'); END;");
      withDiagnosticSink(() => {}, () => assert.throws(() => store.saveEmailCommunication(email), error => {
        assert(error instanceof AgentReportStorageError);
        assert.match(error.message, /accepted.*could not be saved/);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      }));
      assert.deepEqual(store.getPreviousCommunication(email.studentRefs), { latestEmail: email });
      connection.exec("DROP TRIGGER fail_email; UPDATE email_communications SET payload = zeroblob(40);");
      withDiagnosticSink(() => {}, () => assert.throws(() => store.getPreviousCommunication(email.studentRefs), error => {
        assert(error instanceof AgentReportStorageError);
        assert.match(error.message, /no AI request was sent/);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      }));
    } finally { connection.close(); }
  } finally { store.close(); key.fill(0); rmSync(root, { recursive: true, force: true }); }
});
