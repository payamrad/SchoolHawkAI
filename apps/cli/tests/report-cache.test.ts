import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { environment, foundryResponse, studentReportFixture, studentReportHistoryFixture } from "../../../packages/agent/tests/fixtures";
import { brevoEnvironment, twilioEnvironment, twilioReceipt } from "../../../packages/communication/tests/fixtures";
import { setupDatabase } from "../../../scripts/setup-database";
import { runAgentCli } from "../src/agent";
import { ReportDeliveryError } from "../src/communication";

function fixture(context: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-report-cache-"));
  const output: string[] = [];
  const sent: { subject?: string; text: string }[] = [];
  const state = { ai: 0, aiFailures: 0, deliveryFails: false };
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    const sms = String(url).startsWith("https://api.twilio.com/");
    const body = sms ? Object.fromEntries(new URLSearchParams(String(options.body))) : JSON.parse(String(options.body));
    if (String(url).includes(".services.ai.azure.com/")) {
      state.ai++;
      if (state.aiFailures > 0) { state.aiFailures--; return new Response("{}", { status: 503 }); }
      return new Response(JSON.stringify({ ...foundryResponse("A parent-friendly academic summary."), id: `resp_${state.ai}` }));
    }
    assert(String(url).startsWith("https://api.brevo.com/v3/") || sms);
    sent.push({ subject: body.subject, text: sms ? body.Body : body.textContent });
    if (state.deliveryFails) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(sms ? twilioReceipt() : { messageId: `<${sent.length}@example.test>` }), { status: 201 });
  });
  setupDatabase(root);
  const withStore = <Result>(operation: (store: SqliteReviewStore) => Result): Result => {
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try { return operation(store); }
    finally { store.close(); key.fill(0); }
  };
  const family = studentReportHistoryFixture();
  withStore(store => {
    for (const source of family.history) {
      if (source.portal === "canvas") store.importCanvasAssignmentRun(source.accountId, source.run);
      else if (source.section === "assignments") store.importAssignmentRun(source.accountId, source.run);
      else if (source.section === "grades") store.importGradeRun(source.accountId, source.run);
      else store.importRun(source.accountId, source.run);
    }
  });
  writeFileSync(path.join(root, "review.json"), JSON.stringify(family.settings), { mode: 0o600 });
  const snapshot = studentReportFixture();
  const saveInput = () => writeFileSync(path.join(root, "report.json"), JSON.stringify(snapshot), { mode: 0o600 });
  saveInput();
  return {
    root, output, sent, state, family, snapshot, saveInput, withStore,
    env: { ...environment, ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "" },
    last: () => JSON.parse(output.at(-1)!),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("unchanged per-student input skips all Azure calls across reopened stores and sends one short family notice", async context => {
  const f = fixture(context);
  const args = ["analyze", "--config", "review.json", "--per-student", "--notify"];
  try {
    await runAgentCli(args, f.root, f.env);
    assert.equal(f.state.ai, 2);
    assert.equal(f.sent.length, 2);
    assert.equal(f.last().status, "complete");
    const previousReportIds = f.last().reports.map((report: { reportId: string }) => report.reportId);
    await runAgentCli(args, f.root, { ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "" });
    assert.equal(f.state.ai, 2);
    assert.equal(f.sent.length, 3);
    assert.equal(f.last().kind, "student-report-unchanged");
    assert.equal(f.last().skipped, true);
    assert.deepEqual(f.last().previousReportIds, previousReportIds);
    assert.match(f.sent[2].subject!, /No new data/);
    assert.match(f.sent[2].text, /for any student/);
    assert.match(f.sent[2].text, /missing work/);
    assert(f.sent[2].text.length < 750);
    assert.equal(f.withStore(store => store.listAgentReports().length), 2);

    const source = f.family.history.find(source => source.portal === "canvas")!;
    assert(source.portal === "canvas");
    const changed = structuredClone(source.run);
    changed.runId = randomUUID();
    changed.capturedAt = "2026-10-11T16:00:00.000Z";
    for (const student of changed.students) for (const course of student.courses) {
      for (const assignment of course.assignments) assignment.source.capturedAt = changed.capturedAt;
    }
    changed.students[0].courses[0].assignments[0].pointsPossible = 123;
    f.withStore(store => store.importCanvasAssignmentRun(source.accountId, changed));
    await runAgentCli(args, f.root, f.env);
    assert.equal(f.state.ai, 4, "One student's changed Canvas input regenerates the full configured batch.");
    assert.equal(f.last().kind, "student-report-batch");
    await runAgentCli([...args, "--force"], f.root, f.env);
    assert.equal(f.state.ai, 6, "Explicit forcing bypasses the unchanged-input cache.");
  } finally { f.close(); }
});

test("unchanged student reports can send a short Twilio-only notice without Brevo credentials or another Azure call", async context => {
  const f = fixture(context);
  try {
    const args = ["analyze", "--config", "review.json", "--per-student"];
    await runAgentCli(args, f.root, f.env);
    assert.equal(f.state.ai, 2);
    await runAgentCli([...args, "--notify"], f.root, {
      ...twilioEnvironment, REPORT_SMS_RECIPIENTS: "+12025550123",
    });
    assert.equal(f.state.ai, 2);
    assert.equal(f.last().kind, "student-report-unchanged");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /No new/);
    assert(f.sent[0].text.length <= 160);
    assert.doesNotMatch(f.sent[0].text, /avery|casey|academic summary/);
  } finally { f.close(); }
});

test("failed student analyses do not advance the successful-batch checkpoint", async context => {
  const f = fixture(context);
  const args = ["analyze", "--config", "review.json", "--per-student"];
  try {
    f.state.aiFailures = 1;
    await assert.rejects(runAgentCli(args, f.root, f.env), /One or more student reports or deliveries failed/);
    assert.equal(f.state.ai, 2);
    assert.equal(f.last().status, "partial");
    await runAgentCli(args, f.root, f.env);
    assert.equal(f.state.ai, 4);
    assert.equal(f.last().status, "complete");
    await runAgentCli(args, f.root, {});
    assert.equal(f.state.ai, 4);
    assert.equal(f.last().skipped, true);
    assert.equal(f.sent.length, 0, "Local analysis without --notify never sends a notification.");
  } finally { f.close(); }
});

test("file-based grading changes are compared against the last successful report, not a failed attempt", async context => {
  const f = fixture(context);
  const args = ["analyze", "--report", "report.json"];
  try {
    await runAgentCli(args, f.root, f.env);
    const previous = f.last().reportId;
    await runAgentCli(args, f.root, {});
    assert.equal(f.state.ai, 1);
    assert.deepEqual(f.last().previousReportIds, [previous]);
    f.snapshot.students[0].courses.flatMap(course => course.grades)[0].history[0].data.score = "99";
    f.saveInput();
    f.state.aiFailures = 1;
    await assert.rejects(runAgentCli(args, f.root, f.env));
    assert.equal(f.state.ai, 2);
    await runAgentCli(args, f.root, f.env);
    assert.equal(f.state.ai, 3);
    const updated = f.last().reportId;
    assert.notEqual(updated, previous);
    await runAgentCli(args, f.root, {});
    assert.equal(f.state.ai, 3);
    assert.deepEqual(f.last().previousReportIds, [updated]);
  } finally { f.close(); }
});

test("delivery failures preserve the paid-for AI checkpoint and unchanged notices retain coverage and delivery warnings", async context => {
  const f = fixture(context);
  const args = ["analyze", "--report", "report.json", "--notify"];
  try {
    f.state.deliveryFails = true;
    await assert.rejects(runAgentCli(args, f.root, f.env), ReportDeliveryError);
    assert.equal(f.state.ai, 1);
    assert.equal(f.withStore(store => store.listAgentReports().length), 1);
    f.state.deliveryFails = false;
    await runAgentCli([...args, "--collection-incomplete"], f.root, { ...brevoEnvironment, ...twilioEnvironment });
    assert.equal(f.state.ai, 1);
    assert.equal(f.last().kind, "student-report-unchanged");
    assert.equal(f.last().sourceStatus, "limited");
    assert.equal(f.last().communication.accepted.length, 2);
    const email = f.sent.find(message => message.subject?.includes("No new data"))!;
    assert.match(email.text, /Additional portal changes may not have been captured/);
    assert.match(email.text, /Previous AI report delivery is unconfirmed/);
    assert(f.sent.at(-1)!.text.length <= 160);
    f.state.deliveryFails = true;
    await assert.rejects(runAgentCli(args, f.root, { ...brevoEnvironment, ...twilioEnvironment }), ReportDeliveryError);
    assert.equal(f.state.ai, 1);
    assert.equal(f.last().communication.status, "failed");
  } finally { f.close(); }
});
