import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentError } from "@schoolhawk/agent";
import { studentSnapshotSchema } from "@schoolhawk/core/student-snapshot";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { apiKey, environment, foundryResponse, studentReportFixture } from "../../../packages/agent/tests/fixtures";
import { namedFamilyFixture } from "../../../packages/core/tests/review-fixtures";
import { setupDatabase } from "../../../scripts/setup-database";
import { AgentUsageError, parseAgentArgs, runAgentCli } from "../src/agent";
import { cliFailureMessage, runCli } from "../src/index";

test("Agent help and strict arguments require no credentials, database, logs or network", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-help-"));
  context.mock.method(console, "log", () => {});
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request."); });
  try {
    await runCli(["Agent", "--help"], root);
    assert.equal(existsSync(path.join(root, "logs")), false);
    assert.equal(existsSync(path.join(root, "data")), false);
    for (const args of [[], ["unknown"], ["test", "--config", "x"], ["analyze"],
      ["analyze", "--config", "x", "--report", "y"], ["analyze", "--report", "x", "--report=y"],
      ["analyze", "--report="], ["test", "--api-key", "PRIVATE"], ["analyze", "--report", "x", "extra"]]) {
      assert.throws(() => parseAgentArgs(args), AgentUsageError);
    }
    assert.equal(parseAgentArgs(["test"]).command, "test");
    assert.equal(parseAgentArgs(["analyze", "--config", "review.json"]).command, "analyze");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Agent test communicates with synthetic input without opening school storage or logging credentials", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-test-"));
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    requests++;
    assert.equal(new Headers(options.headers).get("api-key"), apiKey);
    assert.match(String(options.body), /No student records/);
    return new Response(JSON.stringify(foundryResponse("PRIVATE_REPLY")));
  });
  try {
    await withLocalDiagnostics(root, "cli", () => runAgentCli(["test"], root, environment));
    assert.equal(requests, 1);
    assert.equal(JSON.parse(output[0]).connected, true);
    assert.equal(existsSync(path.join(root, "data")), false);
    assert.equal(existsSync(path.join(root, "playwright")), false);
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.match(log, /AGENT_TEST_SUMMARY/);
    assert.doesNotMatch(log, /PRIVATE|api-key|fixture\.services/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Agent analyze sends a private report unchanged and returns its linked AI analysis without persisting that analysis", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-report-"));
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  const report = studentReportFixture();
  const file = path.join(root, "report.json");
  const contents = JSON.stringify(report);
  writeFileSync(file, contents, { mode: 0o600 });
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    assert.deepEqual(JSON.parse(request.input[0].content[0].text), report);
    return new Response(JSON.stringify(foundryResponse("PRIVATE_ANALYSIS")));
  });
  try {
    await withLocalDiagnostics(root, "cli", () => runAgentCli(["analyze", "--report", "report.json"], root, environment));
    const result = JSON.parse(output[0]);
    assert.equal(result.text, "PRIVATE_ANALYSIS");
    assert.equal(result.snapshotId, report.id);
    assert.equal(result.studentRefs.length, 2);
    assert.equal(readFileSync(file, "utf8"), contents);
    assert.equal(existsSync(path.join(root, "data")), false);
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.match(log, /AGENT_ANALYSIS_SUMMARY/);
    assert.doesNotMatch(log, /PRIVATE|Quinn|Rowan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Agent analyze can build the current name-matched snapshot from local data before contacting the agent", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-config-"));
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  const { settings, skyward, canvas } = namedFamilyFixture();
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    requests++;
    const request = JSON.parse(String(options.body));
    const report = studentSnapshotSchema.parse(JSON.parse(request.input[0].content[0].text));
    assert.equal(report.totals.students, 2);
    assert.deepEqual(report.students.map(student => student.label), ["avery", "casey"]);
    assert.equal(report.totals.assignmentSourceRecords, 3);
    assert.doesNotMatch(String(options.body), /PRIVATE_AGENT_KEY/);
    return new Response(JSON.stringify(foundryResponse()));
  });
  try {
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try {
      store.importAssignmentRun("parent", skyward);
      store.importCanvasAssignmentRun("canvas-parent", canvas);
    } finally { store.close(); key.fill(0); }
    writeFileSync(path.join(root, "review.json"), JSON.stringify(settings), { mode: 0o600 });
    await withLocalDiagnostics(root, "cli", () => runAgentCli(["analyze", "--config", "review.json"], root, environment));
    assert.equal(requests, 1);
    assert.equal(JSON.parse(output[0]).studentRefs.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe, missing and invalid report files fail before contacting the agent", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-invalid-"));
  context.mock.method(console, "error", () => {});
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => { requests++; return new Response("{}"); });
  const file = path.join(root, "report.json");
  try {
    for (const contents of ["{invalid", JSON.stringify({ students: [] })]) {
      writeFileSync(file, contents, { mode: 0o600 });
      await assert.rejects(runAgentCli(["analyze", "--report", file], root, environment), AgentUsageError);
    }
    writeFileSync(file, JSON.stringify(studentReportFixture()));
    chmodSync(file, 0o644);
    await assert.rejects(runAgentCli(["analyze", "--report", file], root, environment), AgentUsageError);
    chmodSync(file, 0o600);
    symlinkSync(file, path.join(root, "link.json"));
    await assert.rejects(runAgentCli(["analyze", "--report", "link.json"], root, environment), AgentUsageError);
    await assert.rejects(runAgentCli(["analyze", "--report", "missing.json"], root, environment), AgentUsageError);
    assert.equal(requests, 0);
    assert.equal(existsSync(path.join(root, "data")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing agent credentials fail before database access and HTTP failures have agent-specific sanitized guidance", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-failure-"));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async () => new Response(`PRIVATE_BODY ${apiKey}`, { status: 401 }));
  try {
    await assert.rejects(runAgentCli(["analyze", "--config", "review.json"], root, {}), AgentError);
    assert.equal(existsSync(path.join(root, "data")), false);
    await assert.rejects(withLocalDiagnostics(root, "cli", () => runAgentCli(["test"], root, environment)), error => {
      assert(error instanceof AgentError);
      const message = cliFailureMessage(error, ["Agent", "test"]);
      assert.match(message, /^AGENT:.*HTTP 401/);
      assert.doesNotMatch(message, /PRIVATE|database|disk availability/);
      return true;
    });
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.match(log, /"httpStatus":401/);
    assert.match(log, /COMMAND_FAILED/);
    assert.doesNotMatch(log, /PRIVATE|api-key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
