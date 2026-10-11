import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
