import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TruncateOptions, TruncateResult } from "@schoolhawk/storage/messages";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { setupDatabase } from "../../../scripts/setup-database";
import { Messages, parseCliArgs, runCli, Truncate, type TruncateInput } from "../src/index";

test("Messages accepts a bounded count and rejects missing or unrelated arguments", () => {
  for (const count of [1, 10, 1000]) {
    assert.deepEqual(parseCliArgs(["Messages", "--account", "parent", "--", String(count)]), {
      command: "Messages", options: { accountId: "parent", count },
    });
  }
  assert.deepEqual(parseCliArgs(["Messages", "10", "--account", "parent"]), {
    command: "Messages", options: { accountId: "parent", count: 10 },
  });
  assert.deepEqual(parseCliArgs(["Messages", "--help"]), { command: "help" });
  for (const count of ["0", "1001", "-1", "1.5", "1e2", "N", "Infinity"]) {
    assert.throws(() => parseCliArgs(["Messages", "--account", "parent", "--", count]), /between 1 and 1000/);
  }
  for (const args of [["Messages", "10"], ["Messages", "--account", "parent"],
    ["Messages", "10", "20", "--account", "parent"], ["Messages", "10", "--account", "parent~"],
    ["Messages", "10", "--account", "parent", "--account=other"]]) assert.throws(() => parseCliArgs(args));
  for (const flag of ["--yes", "--dry-run", "--LoginNotification"]) {
    assert.throws(() => parseCliArgs(["Messages", "10", "--account", "parent", flag]), /does not accept/);
  }
});

test("Messages prints bounded deduplicated stored content without changing records", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-cli-messages-"));
  const output: string[] = [];
  context.mock.method(console, "log", (text: string) => { output.push(text); });
  try {
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteMessageStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    const capturedAt = "2026-09-13T12:00:00.000Z";
    const run = { runId: randomUUID(), capturedAt, status: "complete", parserVersion: 1, scannedCount: 2,
      window: { days: 2, startDate: "2026-09-12", endDate: "2026-09-13", timeZone: "America/Los_Angeles" },
      messages: ["2026-09-12", "2026-09-13"].map(sentDate => ({ id: sentDate, sentDate,
        subject: "Synthetic subject", sender: "Synthetic sender", bodyText: "Synthetic body\u001b[2J",
        displayedDate: sentDate, unreadBeforeOpen: true,
        source: { portal: "skyward", url: "https://example.test/inbox", capturedAt } })),
    };
    try {
      store.importRun("parent", run);
      store.importRun("parent", { ...run, runId: randomUUID() });
      store.importRun("other", { ...run, messages: [{ ...run.messages[0], id: "other-account" }] });
      store.importRun("parent", { ...run, runId: randomUUID(), status: "partial",
        messages: [{ ...run.messages[0], id: "partial-only" }] });
      const before = store.listRuns("parent");
      const result = Messages(store, { accountId: "parent", count: 1 });
      assert.equal(result.length, 1);
      assert.equal(result[0].message.id, "2026-09-13");
      assert.equal(result[0].message.bodyText, "Synthetic body\u001b[2J");
      assert.deepEqual(JSON.parse(output.pop()!), result);
      await runCli(["Messages", "--account", "parent", "--", "10"], root);
      const text = output.pop()!;
      const messages = JSON.parse(text);
      assert.deepEqual(messages.map((item: { message: { id: string } }) => item.message.id), ["2026-09-13", "2026-09-12"]);
      assert.equal(text.includes("\u001b"), false);
      await runCli(["Messages", "--account", "empty", "--", "10"], root);
      assert.deepEqual(JSON.parse(output.pop()!), []);
      assert.deepEqual(store.listRuns("parent"), before);
      const logs = readdirSync(path.join(root, "logs"));
      assert.equal(logs.length, 2);
      for (const file of logs) {
        const log = readFileSync(path.join(root, "logs", file), "utf8");
        assert.match(log, /COMMAND_COMPLETED/);
        assert.doesNotMatch(log, /Synthetic|example\.test|bodyText|sender|subject/);
      }
    } finally { store.close(); key.fill(0); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI requires an explicit supported target and one valid account", () => {
  assert.deepEqual(parseCliArgs(["Truncate", "--LoginNotification", "--account", "parent", "--dry-run"]), {
    command: "Truncate", options: { accountId: "parent", LoginNotification: true, dryRun: true, yes: false },
  });
  for (const args of [[], ["Truncate"], ["Truncate", "--LoginNotification"],
    ["Truncate", "--LoginNotification", "--account", "parent~"],
    ["Truncate", "--LoginNotification", "--account", "parent", "--all"],
    ["Truncate", "--LoginNotification", "--account", "parent", "--account=other"],
    ["Truncate", "--LoginNotification", "--account", "parent", "--yes", "--dry-run"]]) {
    assert.throws(() => parseCliArgs(args));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/index.ts"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Truncate --LoginNotification/);
  assert.doesNotMatch(result.stderr, /original key/);
});

test("Truncate previews, confirms, cancels, and supports explicit noninteractive deletion", async () => {
  const calls: TruncateOptions[] = [];
  const store = { truncateMessages(accountId: string, options: TruncateOptions): TruncateResult {
    assert.equal(accountId, "parent");
    calls.push(options);
    return { target: "LoginNotification", dryRun: options.dryRun ?? false, messages: 2, observations: 3, runs: 2 };
  } };
  const options: TruncateInput = { accountId: "parent", LoginNotification: true, dryRun: false, yes: false };
  await Truncate(store, { ...options, dryRun: true }, async () => { assert.fail("Dry run must not prompt"); });
  assert.deepEqual(calls.splice(0), [{ target: "LoginNotification", dryRun: true }]);
  await Truncate(store, options, async () => false);
  assert.deepEqual(calls.splice(0), [{ target: "LoginNotification", dryRun: true }]);
  await Truncate(store, options, async () => true);
  assert.deepEqual(calls.splice(0), [{ target: "LoginNotification", dryRun: true }, { target: "LoginNotification" }]);
  await Truncate(store, { ...options, yes: true }, async () => { assert.fail("--yes must not prompt"); });
  assert.equal(calls.length, 2);
});

test("CLI entry point truncates an isolated database without creating missing storage", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-cli-"));
  const args = ["Truncate", "--LoginNotification", "--account", "parent"];
  try {
    await assert.rejects(() => runCli([...args, "--yes"], root));
    assert.equal(existsSync(path.join(root, "data")), false);
    const failedLog = readdirSync(path.join(root, "logs"))[0];
    const diagnostic = readFileSync(path.join(root, "logs", failedLog), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(diagnostic.at(-1).code, "COMMAND_FAILED");
    assert.equal(diagnostic.at(-1).stage, "DATABASE_OPEN");
    assert.equal(diagnostic.at(-1).errorType, "missing-file");
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const databasePath = path.join(root, "data/database/schoolhawk.sqlite");
    const capturedAt = "2026-09-13T12:00:00.000Z";
    const store = new SqliteMessageStore(databasePath, key);
    try {
      store.importRun("parent", { runId: randomUUID(), capturedAt, status: "complete", parserVersion: 1, scannedCount: 1,
        window: { days: 1, startDate: "2026-09-13", endDate: "2026-09-13", timeZone: "America/Los_Angeles" },
        messages: [{ id: "notification", subject: "Skyward Security Alert - New Login Device Detected",
          sender: "LAKE WASHINGTON SCHOOL DIST (No Reply)", bodyText: "Synthetic notification",
          sentDate: "2026-09-13", displayedDate: "Today", unreadBeforeOpen: true,
          source: { portal: "skyward", url: "https://example.test/inbox", capturedAt } }],
      });
      await runCli([...args, "--dry-run"], root);
      assert.equal(store.listMessages("parent").length, 1);
      await runCli([...args, "--yes"], root);
      assert.equal(store.listMessages("parent").length, 0);
      assert.equal(store.listRuns("parent")[0].removedMessageCount, 1);
    } finally { store.close(); key.fill(0); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});