import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { AgentError } from "@schoolhawk/agent";
import { storedAgentReportSchema } from "@schoolhawk/core/agent-reports";
import { studentSnapshotSchema } from "@schoolhawk/core/student-snapshot";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { AgentReportStorageError } from "@schoolhawk/storage/agent-reports";
import { brevoEnvironment } from "../../../packages/communication/tests/fixtures";
import { ReportDeliveryError } from "../src/communication";
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
      ["analyze", "--report="], ["test", "--api-key", "PRIVATE"], ["analyze", "--report", "x", "extra"],
      ["reports", "--config", "x"], ["reports", "--limit", "0"], ["reports", "--limit", "1001"],
      ["reports", "--offset", "-1"], ["reports", "--limit", "1", "--limit=2"],
      ["report"], ["report", "--id", "invalid"], ["__proto__"],
      ["test", "--notify"], ["reports", "--notify"], ["analyze", "--report", "x", "--assignment-days", "10"],
      ["analyze", "--config", "x", "--message-days", "0"], ["analyze", "--report", "x", "--per-student"]]) {
      assert.throws(() => parseAgentArgs(args), AgentUsageError);
    }
    assert.equal(parseAgentArgs(["test"]).command, "test");
    assert.equal(parseAgentArgs(["analyze", "--config", "review.json"]).command, "analyze");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-student analysis sends one named email per child and never invokes SMS when its recipient list is empty", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-named-email-"));
  const output: string[] = [];
  const aiStudents: string[] = [];
  const emailSubjects: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (String(url).includes(".services.ai.azure.com/")) {
      const snapshot = studentSnapshotSchema.parse(JSON.parse(body.input[0].content[0].text));
      assert.equal(snapshot.totals.students, 1);
      assert.equal(snapshot.selection.studentRef, snapshot.students[0].id);
      assert.equal(snapshot.selection.assignments.days, 7);
      assert.equal(snapshot.selection.messages.days, 7);
      aiStudents.push(snapshot.students[0].label);
      return new Response(JSON.stringify({ ...foundryResponse(`Analysis for ${snapshot.students[0].label}.`), id: `resp_${aiStudents.length}` }));
    }
    assert.equal(String(url), "https://api.brevo.com/v3/smtp/email");
    emailSubjects.push(body.subject);
    assert.match(body.textContent, new RegExp(`Student: ${aiStudents.at(-1)}`));
    return new Response(JSON.stringify({ messageId: `<student-${emailSubjects.length}@brevo.test>` }), { status: 201 });
  });
  try {
    const { settings, skyward, canvas } = namedFamilyFixture();
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try {
      store.importAssignmentRun("parent", skyward);
      store.importCanvasAssignmentRun("canvas-parent", canvas);
    } finally { store.close(); key.fill(0); }
    writeFileSync(path.join(root, "review.json"), JSON.stringify(settings), { mode: 0o600 });
    await runAgentCli(["analyze", "--config", "review.json", "--per-student", "--notify", "--assignment-days", "7", "--message-days", "7"],
      root, { ...environment, ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "", BREVO_SMS_SENDER: undefined });
    const result = JSON.parse(output[0]);
    assert.equal(result.kind, "student-report-batch");
    assert.equal(result.status, "complete");
    assert.deepEqual(aiStudents, ["avery", "casey"]);
    assert.deepEqual(emailSubjects, ["SchoolHawkAI: avery - AI student report", "SchoolHawkAI: casey - AI student report"]);
    assert.equal(result.reports.length, 2);
    assert(result.reports.every((report: { studentRefs: string[]; students: { name: string }[]; communication: { accepted: unknown[] } }) =>
      report.studentRefs.length === 1 && report.students.length === 1 && report.communication.accepted.length === 1));
    assert.deepEqual(result.failures, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one student's AI failure does not resend or prevent the other student's named report", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-student-partial-"));
  const output: string[] = [];
  const attempted: string[] = [];
  const emailed: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (String(url).includes(".services.ai.azure.com/")) {
      const snapshot = studentSnapshotSchema.parse(JSON.parse(body.input[0].content[0].text));
      const name = snapshot.students[0].label;
      attempted.push(name);
      return name === "avery" ? new Response("{}", { status: 503 }) :
        new Response(JSON.stringify({ ...foundryResponse("Analysis for casey."), id: "resp_casey" }));
    }
    assert.equal(String(url), "https://api.brevo.com/v3/smtp/email");
    emailed.push(body.subject);
    return new Response(JSON.stringify({ messageId: "<casey@brevo.test>" }), { status: 201 });
  });
  try {
    const { settings, skyward, canvas } = namedFamilyFixture();
    setupDatabase(root);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try {
      store.importAssignmentRun("parent", skyward);
      store.importCanvasAssignmentRun("canvas-parent", canvas);
    } finally { store.close(); key.fill(0); }
    writeFileSync(path.join(root, "review.json"), JSON.stringify(settings), { mode: 0o600 });
    await assert.rejects(runAgentCli(["analyze", "--config", "review.json", "--per-student", "--notify"], root,
      { ...environment, ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "" }), /One or more student reports or deliveries failed/);
    const result = JSON.parse(output[0]);
    assert.equal(result.status, "partial");
    assert.deepEqual(attempted, ["avery", "casey"]);
    assert.deepEqual(emailed, ["SchoolHawkAI: casey - AI student report"]);
    assert.equal(result.reports.length, 1);
    assert.equal(result.failures[0].name, "avery");
    assert.equal(result.failures[0].code, "HTTP_ERROR");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("notified analysis validates recipients before Azure, saves the response, and exposes partial delivery without losing the report", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-notify-"));
  const output: string[] = [];
  const calls: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    const target = String(url);
    calls.push(target);
    if (target.includes(".services.ai.azure.com/")) {
      const body = JSON.parse(String(options.body));
      const report = studentSnapshotSchema.parse(JSON.parse(body.input[0].content[0].text));
      assert.equal(report.status, "incomplete-source-coverage");
      assert(report.notices.includes("collection-incomplete"));
      return new Response(JSON.stringify(foundryResponse("PRIVATE_NOTIFY_ANALYSIS")));
    }
    assert(target.startsWith("https://api.brevo.com/"));
    return target.endsWith("/smtp/email")
      ? new Response(JSON.stringify({ messageId: "<notify@brevo.test>" }), { status: 201 })
      : new Response(JSON.stringify({ code: "not_enough_credits" }), { status: 402 });
  });
  const file = path.join(root, "report.json");
  writeFileSync(file, JSON.stringify(studentReportFixture()), { mode: 0o600 });
  try {
    await assert.rejects(runAgentCli(["analyze", "--report", file, "--notify"], root, environment));
    assert.equal(calls.length, 0);
    setupDatabase(root);
    await assert.rejects(runAgentCli(["analyze", "--report", file, "--notify", "--collection-incomplete"], root,
      { ...environment, ...brevoEnvironment }), ReportDeliveryError);
    assert.equal(calls.length, 3);
    const result = JSON.parse(output[0]);
    assert.equal(result.communication.status, "partial");
    assert.equal(result.sourceStatus, "incomplete-source-coverage");
    assert.equal(result.communication.accepted.length, 1);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try {
      const saved = store.getAgentReport(result.reportId)!;
      assert.equal(saved.text, "PRIVATE_NOTIFY_ANALYSIS");
      assert(saved.sourceNotices.includes("collection-incomplete"));
      assert.equal(Object.hasOwn(saved, "communication"), false);
    } finally { store.close(); key.fill(0); }
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

test("Agent analyze saves a private report response before printing it, and saved reports can be read without Azure credentials", async context => {
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
    const connection = new Database(path.join(root, "data/database/schoolhawk.sqlite"));
    try { connection.exec("BEGIN IMMEDIATE; ROLLBACK;"); }
    finally { connection.close(); }
    return new Response(JSON.stringify(foundryResponse("PRIVATE_ANALYSIS")));
  });
  try {
    setupDatabase(root);
    await withLocalDiagnostics(root, "cli", () => runAgentCli(["analyze", "--report", "report.json"], root, environment));
    const result = storedAgentReportSchema.parse(JSON.parse(output[0]));
    assert.equal(result.text, "PRIVATE_ANALYSIS");
    assert.equal(result.snapshotId, report.id);
    assert.equal(result.studentRefs.length, 2);
    assert.equal(readFileSync(file, "utf8"), contents);
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try { assert.deepEqual(store.getAgentReport(result.reportId), result); }
    finally { store.close(); key.fill(0); }
    context.mock.method(globalThis, "fetch", async () => { throw new Error("Saved-report inspection must not call Azure."); });
    await runAgentCli(["reports", "--limit", "1"], root, {});
    const listing = JSON.parse(output[1]);
    assert.equal(listing.reports[0].reportId, result.reportId);
    assert.equal(listing.reports[0].studentCount, 2);
    assert.equal(Object.hasOwn(listing.reports[0], "text"), false);
    await runAgentCli(["report", "--id", result.reportId], root, {});
    assert.deepEqual(JSON.parse(output[2]), result);
    await assert.rejects(runAgentCli(["report", "--id", `report_${"0".repeat(64)}`], root, {}), /No saved AI report/);
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.match(log, /AGENT_ANALYSIS_SUMMARY/);
    assert.match(log, /AGENT_REPORT_SAVED/);
    assert.doesNotMatch(log, /PRIVATE_ANALYSIS|PRIVATE_AGENT_KEY|PRIVATE_MESSAGE_BODY|PRIVATE_TITLE|PRIVATE_DESCRIPTION|PRIVATE_SENDER|PRIVATE_TEACHER|Quinn|Rowan/);
    assert(!log.includes(report.id));
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
    assert(storedAgentReportSchema.safeParse(JSON.parse(output[0])).success);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("valid file-based analysis requires local storage before an agent request is sent", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-no-storage-"));
  context.mock.method(console, "error", () => {});
  const file = path.join(root, "report.json");
  writeFileSync(file, JSON.stringify(studentReportFixture()), { mode: 0o600 });
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => { requests++; return new Response(JSON.stringify(foundryResponse())); });
  try {
    await assert.rejects(runAgentCli(["analyze", "--report", file], root, environment));
    assert.equal(requests, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a response that cannot be saved fails the command without printing a success-shaped report", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-save-failure-"));
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  const file = path.join(root, "report.json");
  writeFileSync(file, JSON.stringify(studentReportFixture()), { mode: 0o600 });
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify(foundryResponse("PRIVATE_UNSAVED_ANALYSIS")));
  });
  context.mock.method(SqliteReviewStore.prototype, "saveAgentReport", () => {
    throw new AgentReportStorageError("The AI response could not be saved locally.");
  });
  try {
    setupDatabase(root);
    await assert.rejects(runAgentCli(["analyze", "--report", file], root, environment), error => {
      assert(error instanceof AgentReportStorageError);
      assert.match(cliFailureMessage(error, ["Agent", "analyze"]), /^AGENT:.*could not be saved/);
      return true;
    });
    assert.equal(requests, 1);
    assert.deepEqual(output, []);
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

test("changed input requires agent credentials after local comparison, and HTTP failures retain sanitized guidance", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-agent-failure-"));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async () => new Response(`PRIVATE_BODY ${apiKey}`, { status: 401 }));
  try {
    setupDatabase(root);
    writeFileSync(path.join(root, "report.json"), JSON.stringify(studentReportFixture()), { mode: 0o600 });
    await assert.rejects(runAgentCli(["analyze", "--report", "report.json"], root, {}), AgentError);
    await assert.rejects(withLocalDiagnostics(root, "cli", () => runAgentCli(["test"], root, environment)), error => {
      assert(error instanceof AgentError);
      const message = cliFailureMessage(error, ["Agent", "test"]);
      assert.match(message, /^AGENT:.*HTTP 401/);
      assert.doesNotMatch(message, /PRIVATE|database|disk availability/);
      return true;
    });
    const log = readdirSync(path.join(root, "logs")).map(file => readFileSync(path.join(root, "logs", file), "utf8")).join("\n");
    assert.match(log, /"httpStatus":401/);
    assert.match(log, /COMMAND_FAILED/);
    assert.doesNotMatch(log, /PRIVATE|api-key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
