import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { messageRunSchema, type MessageRun } from "@schoolhawk/core/messages";
import { SqliteMessageStore } from "../sqlite-message-store";
import { encryptRun, importEncryptedRuns } from "../encrypted-runs";

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
      assert.equal(connection.pragma("user_version", { simple: true }), 1);
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