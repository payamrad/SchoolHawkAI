import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { briefingInputSchema } from "@schoolhawk/briefing";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { assignmentRun, config } from "../../../packages/core/tests/review-fixtures";
import { setupDatabase } from "../../../scripts/setup-database";
import { runCli, cliFailureMessage } from "../src/index";
import { parseReviewArgs, ReviewUsageError } from "../src/review";

test("Review argument validation is strict and help creates no logs or database", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-review-cli-"));
  context.mock.method(console, "log", () => {});
  try {
    await runCli(["Review", "--help"], root);
    assert.equal(existsSync(path.join(root, "logs")), false);
    assert.equal(existsSync(path.join(root, "data")), false);
    for (const args of [[], ["run"], ["run", "--config", "a", "--config=b"], ["briefing", "--config", "a", "--profile", "b"],
      ["changes", "--profile", "family", "--limit", "1001"], ["changes", "--profile", "family", "--offset", "-1"],
      ["source", "--profile", "family"], ["__proto__", "--profile", "family"]]) {
      assert.throws(() => parseReviewArgs(args), ReviewUsageError);
    }
    assert.equal(parseReviewArgs(["run", "--config", "a"]).command, "run");
    assert.match(cliFailureMessage(new ReviewUsageError("Use Review --help."), ["Review"]), /REVIEW: Use Review/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing review configuration gives setup guidance and preserves ENOENT diagnostics before database access", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-review-config-"));
  context.mock.method(console, "error", () => {});
  try {
    for (const command of ["run", "briefing"]) {
      const args = ["Review", command, "--config", "PRIVATE_MISSING_CONFIG.json"];
      await assert.rejects(() => runCli(args, root), error => {
        assert(error instanceof ReviewUsageError);
        assert.equal(error.code, "ENOENT");
        const message = cliFailureMessage(error, args);
        assert.match(message, /^REVIEW: Review configuration file not found/);
        assert.match(message, /install -m 600 config\/review\.example\.json config\/review\.local\.json/);
        assert.match(message, /edit its account aliases and student bindings/);
        assert.match(message, /No database was opened/);
        assert.doesNotMatch(message, /CLI command failed|PRIVATE_MISSING_CONFIG/);
        return true;
      });
    }
    assert.equal(existsSync(path.join(root, "data")), false);
    assert.equal(existsSync(path.join(root, "playwright")), false);
    assert.equal(existsSync(path.join(root, "PRIVATE_MISSING_CONFIG.json")), false);
    for (const file of readdirSync(path.join(root, "logs"))) {
      const log = readFileSync(path.join(root, "logs", file), "utf8");
      const events = log.trim().split("\n").map(line => JSON.parse(line));
      const failure = events.at(-1);
      assert.equal(failure.code, "COMMAND_FAILED");
      assert.equal(failure.stage, "CONFIGURATION");
      assert.equal(failure.errorType, "missing-file");
      assert.equal(failure.errorCode, "ENOENT");
      assert.doesNotMatch(log, /PRIVATE_MISSING_CONFIG/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid review configuration paths and contents are diagnosed without modifying files or opening storage", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-review-config-"));
  context.mock.method(console, "error", () => {});
  const target = path.join(root, "preserved.json");
  writeFileSync(target, JSON.stringify(config()), { mode: 0o600 });
  try {
    for (const problem of ["permissions", "symlink", "directory", "oversized", "json", "schema"]) {
      const file = path.join(root, `${problem}.json`);
      if (problem === "symlink") symlinkSync(target, file);
      else if (problem === "directory") mkdirSync(file, { mode: 0o700 });
      else {
        writeFileSync(file, problem === "oversized" ? "x".repeat(100001) : problem === "json" ? '{"PRIVATE_CONFIG_BODY":' :
          problem === "schema" ? '{"version":1,"PRIVATE_CONFIG_BODY":"not valid"}' : JSON.stringify(config()), { mode: 0o600 });
        if (problem === "permissions") chmodSync(file, 0o644);
      }
      await assert.rejects(() => runCli(["Review", "run", "--config", file], root), error => {
        assert(error instanceof ReviewUsageError, problem);
        assert.match(error.message, /No database was opened/);
        assert.match(error.message, problem === "oversized" ? /exceeds 100 KB/ :
          ["json", "schema"].includes(problem) ? /Invalid review configuration/ : /private, readable regular file/);
        assert.doesNotMatch(error.message, /PRIVATE_CONFIG_BODY/);
        return true;
      });
    }
    assert.equal(existsSync(path.join(root, "data")), false);
    assert.equal(existsSync(path.join(root, "playwright")), false);
    assert.equal(readFileSync(target, "utf8"), JSON.stringify(config()));
    const events = readdirSync(path.join(root, "logs")).flatMap(file =>
      readFileSync(path.join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    assert.equal(events.filter(event => event.code === "SCHEMA_INVALID" && event.stage === "CONFIGURATION").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CONFIG_BODY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local Review run, briefing and source inspection work end to end without sessions or network", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-review-cli-"));
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  try {
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try { store.importAssignmentRun("parent", assignmentRun(new Date(Date.now() - 1000).toISOString())); }
    finally { store.close(); key.fill(0); }
    const configuration = path.join(root, "review.json");
    writeFileSync(configuration, JSON.stringify(config()), { mode: 0o600 });
    await runCli(["Review", "run", "--config", "review.json"], root);
    const summary = JSON.parse(output.pop()!);
    assert.equal(summary.bootstrap, true);
    assert(summary.actions > 0);
    await runCli(["Review", "briefing", "--config", "review.json"], root);
    const encoded = output.pop()!;
    const briefing = briefingInputSchema.parse(JSON.parse(encoded));
    assert(Buffer.byteLength(encoded) <= briefing.limits.maxBytes);
    assert.doesNotMatch(encoded, /PRIVATE_STUDENT|PRIVATE_TEACHER|PRIVATE_DESCRIPTION|student-1|https?:/);
    await runCli(["Review", "source", "--profile", "family", "--review", briefing.reviewId, "--source", briefing.sources[0].id], root);
    assert(JSON.parse(output.pop()!).url);
    await runCli(["Review", "changes", "--profile", "family", "--limit", "1"], root);
    assert.equal(JSON.parse(output.pop()!).length, 1);
    await runCli(["Review", "briefing", "--config", "review.json", "--text"], root);
    assert.match(output.pop()!, /not an unqualified all-clear/);
    assert.equal(existsSync(path.join(root, "playwright/.auth/skyward.json")), false);
    for (const file of readdirSync(path.join(root, "logs"))) {
      const log = readFileSync(path.join(root, "logs", file), "utf8");
      assert.doesNotMatch(log, /PRIVATE_STUDENT|PRIVATE_TEACHER|PRIVATE_DESCRIPTION|PRIVATE_TITLE|student-1|https?:/);
    }
    chmodSync(configuration, 0o644);
    await assert.rejects(() => runCli(["Review", "run", "--config", "review.json"], root), /private/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
