import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { messageRunSchema, type MessageRun } from "@schoolhawk/core/messages";
import { SqliteMessageStore } from "../sqlite-message-store";
import { encryptRun, importEncryptedRuns } from "../encrypted-runs";
import { setupDatabase } from "../../../scripts/setup-database";

test("database setup creates a fresh store and preserves its key and records on rerun", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-setup-"));
  try {
    setupDatabase(root);
    const keyPath = path.join(root, "playwright/.auth/messages.key");
    const databasePath = path.join(root, "data/database/schoolhawk.sqlite");
    const key = readFileSync(keyPath);
    assert.equal(key.length, 32);
    for (const directory of ["playwright/.auth", "data", "data/database"]) {
      assert.equal(statSync(path.join(root, directory)).mode & 0o777, 0o700);
    }
    for (const file of [keyPath, databasePath]) assert.equal(statSync(file).mode & 0o777, 0o600);
    const run = sample();
    const store = new SqliteMessageStore(databasePath, key);
    try { store.importRun("parent", run); } finally { store.close(); }
    setupDatabase(root);
    assert.deepEqual(readFileSync(keyPath), key);
    const reopened = new SqliteMessageStore(databasePath, key);
    try { assert.deepEqual(reopened.getRun("parent", run.runId), { ...run, selection: "all" }); }
    finally { reopened.close(); }
    rmSync(keyPath);
    assert.throws(() => setupDatabase(root), /Restore the original key/);
    assert.equal(existsSync(keyPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database setup reuses collector keys and refuses missing, invalid, or insecure keys", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-setup-key-"));
  const keyPath = path.join(root, "playwright/.auth/messages.key");
  try {
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { mode: 0o600 });
    setupDatabase(root);
    assert.deepEqual(readFileSync(keyPath), key);
    writeFileSync(keyPath, randomBytes(32));
    assert.throws(() => setupDatabase(root), /Incorrect storage key/);
    writeFileSync(keyPath, "invalid");
    assert.throws(() => setupDatabase(root), /exactly 32 bytes/);
    assert.equal(readFileSync(keyPath, "utf8"), "invalid");
    chmodSync(keyPath, 0o644);
    assert.throws(() => setupDatabase(root), /private/);
    rmSync(keyPath);
    rmSync(path.join(root, "data"), { recursive: true });
    mkdirSync(path.join(root, "data/messages"), { recursive: true, mode: 0o700 });
    const source = path.join(root, "data/messages/saved.json.enc");
    writeFileSync(source, "saved ciphertext", { mode: 0o600 });
    assert.throws(() => setupDatabase(root), /Existing data/);
    assert.equal(existsSync(keyPath), false);
    assert.equal(readFileSync(source, "utf8"), "saved ciphertext");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("truncates subjects containing the login notification phrase only from the district sender across account history", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const run = sample();
    run.messages[0].subject = "Skyward Security Alert - New Login Device Detected";
    run.messages[0].sender = "LAKE WASHINGTON SCHOOL DIST (No Reply)";
    run.messages.push({ ...run.messages[0], id: "other-sender", sender: "Teacher" },
      { ...run.messages[0], id: "other-subject", subject: "Re: New Login Device Detected today" },
      { ...run.messages[0], id: "body-only", subject: "School update", bodyText: "New Login Device Detected" },
      { ...run.messages[0], id: "different-case", subject: "new login device detected" });
    run.scannedCount = 5;
    store.importRun("parent", run);
    store.importRun("other", run);
    const partial = { ...run, runId: randomUUID(), status: "partial" as const,
      messages: run.messages.map(message => ({ ...message, subject: "Changed historical subject" })) };
    const failed = { ...run, runId: randomUUID(), status: "failed" as const };
    store.importRun("parent", partial);
    store.importRun("parent", failed);
    const preview = store.truncateMessages("parent", { target: "LoginNotification", dryRun: true });
    assert.deepEqual(preview, { target: "LoginNotification", dryRun: true, messages: 2, observations: 6, runs: 3 });
    assert.deepEqual(store.getRun("parent", run.runId), { ...run, selection: "all" });
    assert.deepEqual(store.truncateMessages("parent", { target: "LoginNotification" }), { ...preview, dryRun: false });
    for (const original of [run, partial, failed]) {
      const retained = store.getRun("parent", original.runId)!;
      assert.deepEqual(retained.messages.map(message => message.id), ["other-sender", "body-only", "different-case"]);
      assert.equal(retained.status, original.status);
      assert.throws(() => store.importRun("parent", original), /Conflicting/);
      assert.equal(store.importRun("parent", retained), "already-imported");
    }
    for (const summary of store.listRuns("parent")) {
      assert.equal(summary.messageCount, 3);
      assert.equal(summary.removedMessageCount, 2);
    }
    assert.equal(store.listMessages("parent").length, 3);
    assert.equal(store.getRun("other", run.runId)?.messages.length, 5);
    assert.equal(store.truncateMessages("parent", { target: "LoginNotification" }).messages, 0);
    assert.throws(() => store.truncateMessages("parent", { target: "all" as "LoginNotification" }), /Unsupported/);
    assert.throws(() => store.truncateMessages("parent~", { target: "LoginNotification" }), /alias/);
  } finally { store.close(); }
});

test("migrates existing records from version 1 and rolls back a failed cleanup audit", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-cleanup-"));
  const file = path.join(directory, "schoolhawk.sqlite");
  const key = randomBytes(32);
  const run = sample();
  run.messages[0].subject = "Skyward Security Alert - New Login Device Detected";
  run.messages[0].sender = "LAKE WASHINGTON SCHOOL DIST (No Reply)";
  try {
    const initial = new SqliteMessageStore(file, key);
    try { initial.importRun("parent", run); } finally { initial.close(); }
    const legacy = new Database(file);
    try {
      legacy.exec("DROP TABLE email_communications; DROP TABLE report_checkpoints; DROP TABLE agent_reports; DROP TABLE review_evaluations; DROP TABLE review_events; DROP TABLE review_profiles;");
      legacy.exec("DROP TRIGGER skyward_assignment_identity; DROP TABLE canvas_match_runs; DROP TABLE skyward_assignments; DROP TABLE canvas_assignments;");
      legacy.exec("DROP TABLE canvas_audit_events; DROP TABLE canvas_assignment_links; DROP TABLE canvas_course_mappings; DROP TABLE canvas_assignment_observations; DROP TABLE canvas_assignment_courses; DROP TABLE canvas_assignment_runs; DROP TABLE grade_import_events; DROP TABLE grade_observations; DROP TABLE grade_students; DROP TABLE grade_runs; DROP TABLE assignment_import_events; DROP TABLE assignment_observations; DROP TABLE assignment_sections; DROP TABLE assignment_runs; DROP TABLE cleanup_events; ALTER TABLE collection_runs DROP COLUMN removed_message_count; PRAGMA user_version = 1;");
      assert.throws(() => new SqliteMessageStore(file, randomBytes(32)), /Incorrect storage key/);
      assert.equal(legacy.pragma("user_version", { simple: true }), 1);
    } finally { legacy.close(); }
    const store = new SqliteMessageStore(file, key);
    const connection = new Database(file);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 10);
      assert.deepEqual(store.getRun("parent", run.runId), { ...run, selection: "all" });
      connection.exec("CREATE TRIGGER fail_cleanup BEFORE INSERT ON cleanup_events BEGIN SELECT RAISE(ABORT, 'test cleanup failure'); END;");
      assert.throws(() => store.truncateMessages("parent", { target: "LoginNotification" }), /test cleanup failure/);
      assert.deepEqual(store.getRun("parent", run.runId), { ...run, selection: "all" });
      assert.equal(store.importRun("parent", run), "already-imported");
      assert.equal(store.listRuns("parent")[0].removedMessageCount, 0);
      connection.exec("DROP TRIGGER fail_cleanup;");
      store.truncateMessages("parent", { target: "LoginNotification" });
      assert.equal(store.getRun("parent", run.runId)?.messages.length, 0);
      assert.equal((connection.prepare("SELECT COUNT(*) AS count FROM cleanup_events").get() as { count: number }).count, 1);
      assert.throws(() => connection.exec("DELETE FROM cleanup_events"), /append-only/);
      assert.throws(() => connection.exec("UPDATE cleanup_events SET message_count = 0"), /append-only/);
      assert.equal((connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, 1);
    } finally { connection.close(); store.close(); }
  } finally { key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

function sample(capturedAt = "2026-09-13T12:00:00.000Z"): MessageRun {
  return {
    runId: randomUUID(), capturedAt, status: "complete", parserVersion: 1, scannedCount: 1,
    window: { days: 7, startDate: "2026-09-07", endDate: "2026-09-13", timeZone: "America/Los_Angeles" },
    messages: [{ id: "message-1", sender: "PRIVATE-SENDER", subject: "PRIVATE-SUBJECT", bodyText: "PRIVATE-BODY",
      sentDate: "2026-09-12", displayedDate: "12/09/2026", unreadBeforeOpen: true,
      source: { portal: "skyward", url: "https://example.test/inbox", capturedAt } }],
  };
}

test("imports idempotently and preserves legacy selection, account isolation, and source data", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const run = sample();
    assert.equal(store.importRun("parent", run), "imported");
    assert.equal(store.importRun("parent", run), "already-imported");
    assert.deepEqual(store.getRun("parent", run.runId), { ...run, selection: "all" });
    assert.equal(store.listRuns("parent").length, 1);
    assert.equal(store.listMessages("parent").length, 1);
    assert.throws(() => store.importRun("parent", { ...run, scannedCount: 2 }), /Conflicting/);
    assert.equal(store.getRun("other", run.runId), undefined);
    store.importRun("other", run);
    assert.equal(store.listMessages("other").length, 1);
  } finally { store.close(); }
});

test("older and incomplete runs cannot replace newer complete messages or imply deletion", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const latest = sample();
    latest.selection = "unread";
    latest.messages[0].bodyText = "newest complete";
    store.importRun("parent", latest);
    const older = sample("2026-09-13T10:00:00.000Z");
    store.importRun("parent", older);
    const partial = sample("2026-09-13T14:00:00.000Z");
    partial.status = "partial";
    partial.warning = "SCROLL_COMPLETENESS_UNVERIFIED";
    store.importRun("parent", partial);
    store.importRun("parent", { ...sample(), messages: [], scannedCount: 0, selection: "unread" });
    store.importRun("parent", { ...sample(), status: "failed", messages: [], scannedCount: 0 });
    const records = store.listMessages("parent");
    assert.equal(records.length, 1);
    assert.equal(records[0].message.bodyText, "newest complete");
    assert.equal(records[0].firstSeenAt, older.capturedAt);
    assert.equal(records[0].lastSeenAt, latest.capturedAt);
    assert.equal(store.getRun("parent", partial.runId)?.warning, partial.warning);
    assert.equal(store.listMessages("parent", { since: "2026-09-13" }).length, 0);
  } finally { store.close(); }
});

test("rejects malformed data before persistence", () => {
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    const run = sample();
    for (const invalid of [null, { ...run, parserVersion: 99 }, { ...run, messages: [run.messages[0], run.messages[0]] },
      { ...run, window: { ...run.window, startDate: "2026-09-01" } },
      { ...run, messages: [{ ...run.messages[0], sentDate: "2026-09-01" }] }]) {
      assert.throws(() => store.importRun("parent", invalid));
    }
    assert.equal(store.listRuns("parent").length, 0);
    assert.throws(() => messageRunSchema.parse({ ...run, capturedAt: "yesterday" }));
    assert.throws(() => store.listMessages("parent", { since: "2026-02-31" }));
  } finally { store.close(); }
});

test("imports encrypted files repeatedly, rejects tampering, and preserves every source file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-import-"));
  const key = randomBytes(32);
  const store = new SqliteMessageStore(":memory:", key);
  try {
    const run = sample();
    const file = path.join(directory, `${run.runId}.json.enc`);
    const original = JSON.stringify(encryptRun(run, key));
    writeFileSync(file, original, { mode: 0o600 });
    writeFileSync(path.join(directory, "broken.json.enc"), "{}", { mode: 0o600 });
    const wrongKeyRun = encryptRun(sample(), randomBytes(32));
    writeFileSync(path.join(directory, "wrong-key.json.enc"), JSON.stringify(wrongKeyRun), { mode: 0o600 });
    assert.deepEqual(await importEncryptedRuns(directory, "parent", key, store), {
      files: 3, imported: 1, alreadyImported: 0, verified: 1, rejected: 2,
    });
    assert.deepEqual(await importEncryptedRuns(directory, "parent", key, store), {
      files: 3, imported: 0, alreadyImported: 1, verified: 1, rejected: 2,
    });
    assert.equal(readdirSync(directory).length, 3);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(store.getRun("parent", run.runId), { ...run, selection: "all" });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("rejects future migration versions and swapped encrypted message payloads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-integrity-"));
  const file = path.join(directory, "messages.sqlite");
  const key = randomBytes(32);
  const store = new SqliteMessageStore(file, key);
  try {
    const run = sample();
    run.messages.push({ ...run.messages[0], id: "message-2" });
    run.scannedCount = 2;
    store.importRun("parent", run);
    const connection = new Database(file);
    try {
      connection.exec("UPDATE message_observations SET payload = (SELECT payload FROM message_observations WHERE message_id = 'message-1') WHERE message_id = 'message-2'");
      assert.throws(() => store.getRun("parent", run.runId));
      connection.pragma("user_version = 99");
      assert.throws(() => new SqliteMessageStore(file, key), /Unsupported database schema/);
    } finally { connection.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persists encrypted data, rolls back failed writes, and restores an online backup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-storage-"));
  const file = path.join(directory, "messages.sqlite");
  const backup = path.join(directory, "backup.sqlite");
  const key = randomBytes(32);
  const store = new SqliteMessageStore(file, key);
  try {
    const run = sample();
    store.importRun("parent", run);
    const connection = new Database(file);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 10);
      connection.exec("CREATE TRIGGER test_failure BEFORE INSERT ON message_observations BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      assert.throws(() => store.importRun("parent", sample()), /test failure/);
      assert.equal(store.listRuns("parent").length, 1);
      assert.equal((connection.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, 1);
      assert.throws(() => connection.exec("DELETE FROM audit_events"), /append-only/);
      connection.exec("DROP TRIGGER test_failure;");
    } finally { connection.close(); }
    await store.backup(backup);
    const restored = new SqliteMessageStore(backup, key);
    try { assert.deepEqual(restored.getRun("parent", run.runId), { ...run, selection: "all" }); }
    finally { restored.close(); }
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    for (const candidate of [file, `${file}-wal`, backup]) {
      let data: Buffer;
      try { data = readFileSync(candidate); } catch { continue; }
      for (const secret of ["PRIVATE-SENDER", "PRIVATE-SUBJECT", "PRIVATE-BODY", "https://example.test/inbox"]) assert.equal(data.includes(Buffer.from(secret)), false);
    }
    assert.throws(() => new SqliteMessageStore(file, randomBytes(32)), /Incorrect storage key/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});