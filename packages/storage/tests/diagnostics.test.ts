import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindDiagnosticContext, DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { createDiagnosticLog, withLocalDiagnostics } from "../diagnostics";
import { setupDatabase } from "../../../scripts/setup-database";

vi.mock("node:fs", { spy: true });

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "schoolhawk-diagnostics-"));
}

test("diagnostics are private, synchronously persisted, and restricted to allowlisted metadata", () => {
  const root = temporaryRoot();
  const log = createDiagnosticLog(root, "skyward:grades");
  try {
    const event = Object.assign({
      code: "RECORD_INVALID" as const, student: 1, record: 3, counts: { scanned: 4, accepted: 3, childName: "PRIVATE CHILD" },
    }, { body: "PRIVATE BODY", password: "PRIVATE PASSWORD", url: "https://example.test/?token=PRIVATE", error: new Error("PRIVATE ERROR") });
    log.sink({ ...event, level: "warn" });
    const output = readFileSync(log.file, "utf8");
    assert(output.endsWith("\n"));
    assert.doesNotMatch(output, /PRIVATE|password|childName|token|stack/);
    const parsed = JSON.parse(output);
    assert.equal(parsed.code, "RECORD_INVALID");
    assert.deepEqual(parsed.counts, { scanned: 4, accepted: 3 });
    assert.equal(parsed.student, 1);
    assert.equal(statSync(path.join(root, "logs")).mode & 0o777, 0o700);
    assert.equal(statSync(log.file).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(root, "data")), false);
    setupDatabase(root);
    assert.equal(existsSync(path.join(root, "playwright/.auth/messages.key")), true);
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test("command logs record failure and the original exception is propagated without sensitive details", async () => {
  const root = temporaryRoot();
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const failure = Object.assign(new Error("PRIVATE password and portal response"), { code: "ENOSPC" });
    await assert.rejects(withLocalDiagnostics(root, "cli", async () => {
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "DATABASE_WRITE" });
      throw failure;
    }), error => error === failure);
    const files = readdirSync(path.join(root, "logs"));
    assert.equal(files.length, 1);
    const text = readFileSync(path.join(root, "logs", files[0]), "utf8");
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.code), ["COMMAND_STARTED", "STAGE_STARTED", "COMMAND_FAILED"]);
    assert.equal(events[2].errorType, "disk-full");
    assert.doesNotMatch(text, /PRIVATE|password|portal response|stack/);
    assert.match(String(output.mock.calls[0][0]), /Local diagnostic log:/);
  } finally { output.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("async command contexts stay isolated and nested calls share the existing log", async () => {
  const root = temporaryRoot();
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await Promise.all(["cli", "data"].map(command => withLocalDiagnostics(root, command as "cli" | "data", async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      await withLocalDiagnostics(root, "setup", () => {
        reportDiagnostic({ code: "RECORD_SKIPPED", record: command === "cli" ? 1 : 2 });
      });
    })));
    const files = readdirSync(path.join(root, "logs"));
    assert.equal(files.length, 2);
    for (const file of files) {
      const events = readFileSync(path.join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(new Set(events.map(event => event.operationId)).size, 1);
      assert.equal(new Set(events.map(event => event.command)).size, 1);
      const skipped = events.find(event => event.code === "RECORD_SKIPPED");
      assert.equal(skipped.record, skipped.command === "cli" ? 1 : 2);
      assert.equal(events.at(-1).code, "COMMAND_COMPLETED");
    }
  } finally { output.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("best-effort completion preserves partial status in the final command event", async () => {
  const root = temporaryRoot();
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const code of ["RUN_SUMMARY", "IMPORT_SUMMARY"] as const) {
      const runId = randomUUID();
      await withLocalDiagnostics(root, "skyward:grades", () => {
        reportDiagnostic({ code: "RECORD_INVALID", runId, student: 1, record: 2 });
        reportDiagnostic({ code, runId, status: "partial", counts: { accepted: 2, skipped: 1 } });
      });
    }
    const files = readdirSync(path.join(root, "logs"));
    assert.equal(files.length, 2);
    for (const file of files) {
      const events = readFileSync(path.join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.at(-1).code, "COMMAND_COMPLETED");
      assert.equal(events.at(-1).status, "partial");
      assert.equal(events[1].runId, events[2].runId);
      assert(events.at(-1).durationMs >= 0);
    }
  } finally { output.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("browser-style callbacks retain their command log across transport async contexts", async () => {
  const root = temporaryRoot();
  const transport = new AsyncResource("synthetic-browser-transport");
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await withLocalDiagnostics(root, "skyward:grades", () => {
      const onResponse = bindDiagnosticContext(() => {
        reportDiagnostic({ code: "BROWSE_RESPONSE_INVALID", student: 1, record: 2 });
      });
      transport.runInAsyncScope(onResponse);
    });
    const file = readdirSync(path.join(root, "logs"))[0];
    const events = readFileSync(path.join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert(events.some(event => event.code === "BROWSE_RESPONSE_INVALID" && event.record === 2));
    assert.equal(output.mock.calls.length, 1);
  } finally {
    transport.emitDestroy();
    output.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("logging rejects insecure paths and symlinks before executing commands", async () => {
  const root = temporaryRoot();
  const directory = path.join(root, "logs");
  try {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o755);
    let ran = false;
    await assert.rejects(withLocalDiagnostics(root, "data", () => { ran = true; }), /private/);
    assert.equal(ran, false);
    chmodSync(directory, 0o700);
    const target = path.join(root, "keep.txt");
    writeFileSync(target, "preserve", { mode: 0o600 });
    const link = path.join(directory, `2026-10-01-${randomUUID()}.jsonl`);
    symlinkSync(target, link);
    assert.throws(() => createDiagnosticLog(root, "cli"), /private/);
    assert.equal(readFileSync(target, "utf8"), "preserve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("write and flush failures are explicit logging errors, never successful diagnostics", () => {
  const root = temporaryRoot();
  const log = createDiagnosticLog(root, "cli");
  try {
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw Object.assign(new Error("PRIVATE disk details"), { code: "ENOSPC" });
    });
    try {
      assert.throws(() => log.sink({ level: "warn", code: "RECORD_INVALID" }), error =>
        error instanceof DiagnosticLogError && !error.message.includes("PRIVATE"));
    } finally { write.mockRestore(); }
    const flush = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("PRIVATE disk details"), { code: "EIO" });
    });
    try {
      assert.throws(() => log.sink({ level: "warn", code: "RECORD_INVALID" }), DiagnosticLogError);
      assert.throws(() => log.close(), DiagnosticLogError);
    } finally { flush.mockRestore(); }
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retention removes only expired owned log files and preserves other local files", () => {
  const root = temporaryRoot();
  const directory = path.join(root, "logs");
  const now = new Date("2026-10-10T12:00:00Z");
  try {
    mkdirSync(directory, { mode: 0o700 });
    const expired = path.join(directory, `2026-10-01-${randomUUID()}.jsonl`);
    const recent = path.join(directory, `2026-10-09-${randomUUID()}.jsonl`);
    const unrelated = path.join(directory, "keep.jsonl");
    for (const file of [expired, recent, unrelated]) writeFileSync(file, "{}\n", { mode: 0o600 });
    utimesSync(expired, new Date("2026-10-01"), new Date("2026-10-01"));
    utimesSync(recent, new Date("2026-10-09"), new Date("2026-10-09"));
    const log = createDiagnosticLog(root, "cli", now);
    log.close();
    assert.equal(existsSync(expired), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(unrelated), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("count-based retention preserves recent logs belonging to concurrent commands", () => {
  const root = temporaryRoot();
  const directory = path.join(root, "logs");
  const now = new Date();
  try {
    mkdirSync(directory, { mode: 0o700 });
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    for (let index = 0; index < 102; index++) {
      const file = path.join(directory, `${now.toISOString().slice(0, 10)}-${randomUUID()}.jsonl`);
      writeFileSync(file, "{}\n", { mode: 0o600 });
      utimesSync(file, old, old);
    }
    const active = createDiagnosticLog(root, "cli", now);
    const next = createDiagnosticLog(root, "data", now);
    try {
      assert.equal(existsSync(active.file), true);
      assert.equal(readdirSync(directory).length, 100);
    } finally { active.close(); next.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic floods retain run and agent outcomes with an explicit suppression count", () => {
  const root = temporaryRoot();
  const log = createDiagnosticLog(root, "canvas:assignments");
  try {
    for (let record = 1; record <= 2100; record++) log.sink({ level: "warn", code: "RECORD_INVALID", record });
    log.sink({ level: "warn", code: "RUN_SUMMARY", status: "partial", counts: { accepted: 1, skipped: 2100 } });
    log.sink({ level: "info", code: "AGENT_TEST_SUMMARY", stage: "AGENT_RESPONSE", status: "success" });
    log.sink({ level: "info", code: "AGENT_ANALYSIS_SUMMARY", stage: "AGENT_RESPONSE", status: "success", counts: { students: 2 } });
    log.sink({ level: "info", code: "AGENT_REPORT_SAVED", stage: "DATABASE_WRITE", status: "success", counts: { students: 2 } });
    log.close();
    const events = readFileSync(log.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 2005);
    assert.equal(events[2000].status, "partial");
    assert.deepEqual(events.slice(2001, 2004).map(event => event.code), ["AGENT_TEST_SUMMARY", "AGENT_ANALYSIS_SUMMARY", "AGENT_REPORT_SAVED"]);
    assert.equal(events.at(-2).counts.students, 2);
    assert.equal(log.outcome().status, "success");
    assert.equal(events.at(-1).code, "LOG_LIMIT_REACHED");
    assert.equal(events.at(-1).counts.suppressed, 100);
    assert.throws(() => log.sink({ level: "warn", code: "RECORD_INVALID", record: 2101 }), DiagnosticLogError);
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test("error classification never copies arbitrary error text or properties", () => {
  const cases: [unknown, DiagnosticEvent["errorType"]][] = [
    [Object.assign(new Error("PRIVATE"), { code: "ENOENT" }), "missing-file"],
    [Object.assign(new Error("PRIVATE"), { code: "EACCES" }), "permission"],
    [Object.assign(new Error("PRIVATE"), { code: "SQLITE_BUSY" }), "database"],
    [Object.assign(new Error("PRIVATE"), { name: "TimeoutError" }), "timeout"],
    [new Error("PRIVATE"), "other"],
    [{ message: "PRIVATE", code: "ENOSPC" }, "other"],
  ];
  for (const [error, expected] of cases) assert.equal(diagnosticErrorType(error), expected);
});
