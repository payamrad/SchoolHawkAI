import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { AgentReportStorageError } from "@schoolhawk/storage/agent-reports";
import { CommunicationError } from "@schoolhawk/communication";
import { brevoEnvironment, savedReport, twilioEnvironment, twilioReceipt } from "../../../packages/communication/tests/fixtures";
import { setupDatabase } from "../../../scripts/setup-database";
import { runCli } from "../src/index";
import { CommunicationUsageError, ReportDeliveryError, parseCommunicationArgs, prepareReportDelivery, runCommunicationCli } from "../src/communication";

function requestBody(url: unknown, options: RequestInit): Record<string, unknown> {
  return String(url).startsWith("https://api.twilio.com/") ? Object.fromEntries(new URLSearchParams(String(options.body))) :
    JSON.parse(String(options.body));
}

function seed(root: string) {
  setupDatabase(root);
  const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
  const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
  try {
    const { version: _version, reportId: _reportId, savedAt: _savedAt, ...analysis } = savedReport();
    return store.saveAgentReport(analysis);
  } finally { store.close(); key.fill(0); }
}

test("communication help and argument validation require no key, database, or delivery", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-communicate-help-"));
  context.mock.method(console, "log", () => {});
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request."); });
  try {
    await runCli(["Communicate", "--help"], root);
    assert.equal(existsSync(path.join(root, "logs")), false);
    assert.equal(existsSync(path.join(root, "data")), false);
    for (const args of [[], ["send"], ["send", "--report", "bad"], ["test"], ["test", "--channel", "all", "--to", "x"],
      ["recipients", "--report", "x"], ["recipients", "--channel", "fax"],
      ["test", "--channel", "email", "--channel", "sms", "--to", "x"]]) {
      assert.throws(() => parseCommunicationArgs(args), CommunicationUsageError);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recipient lists can be inspected without provider credentials or local storage", async context => {
  const output: string[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request."); });
  await runCommunicationCli(["recipients"], "/unused", {
    REPORT_EMAIL_RECIPIENTS: "parent@example.test,other@example.test", REPORT_SMS_RECIPIENTS: "+12025550123",
  });
  assert.deepEqual(JSON.parse(output[0]), { email: ["parent@example.test", "other@example.test"], sms: ["+12025550123"] });
  assert.throws(() => prepareReportDelivery({}), CommunicationUsageError);
  assert.throws(() => prepareReportDelivery({ REPORT_EMAIL_RECIPIENTS: "parent@example.test" }), CommunicationError);
});

test("explicit tests send exactly one harmless message per selected channel, not the configured recipient list", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-communicate-test-"));
  const output: string[] = [];
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    calls.push({ url: String(url), body: requestBody(url, options) });
    return new Response(JSON.stringify(String(url).endsWith("/smtp/email") ? { messageId: "<test@brevo.test>" } : twilioReceipt()), { status: 201 });
  });
  try {
    const emailEnv = { ...brevoEnvironment, REPORT_EMAIL_RECIPIENTS: "not-the-test@example.test" };
    const smsEnv = { ...twilioEnvironment, REPORT_SMS_RECIPIENTS: "+12025550124" };
    await withLocalDiagnostics(root, "cli", () => runCommunicationCli(["test", "--channel", "email", "--to", "parent@example.test"], root, emailEnv));
    await withLocalDiagnostics(root, "cli", () => runCommunicationCli(["test", "--channel", "sms", "--to", "+12025550123"], root, smsEnv));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.to, [{ email: "parent@example.test" }]);
    assert.equal(calls[1].url, `https://api.twilio.com/2010-04-01/Accounts/${twilioEnvironment.TWILIO_ACCOUNT_SID}/Messages.json`);
    assert.equal(calls[1].body.To, "+12025550123");
    assert.match(String(calls[0].body.textContent), /No student records/);
    assert.match(String(calls[1].body.Body), /Twilio SMS test.*No student records/);
    assert.equal(JSON.parse(output[0]).status, "accepted");
    assert.equal(JSON.parse(output[1]).provider, "twilio-sms");
    assert.equal(existsSync(path.join(root, "data")), false);
    for (const file of readdirSync(path.join(root, "logs"))) {
      const log = readFileSync(path.join(root, "logs", file), "utf8");
      assert.doesNotMatch(log, /PRIVATE_BREVO_KEY|PRIVATE_TWILIO_TOKEN|Basic |parent@example|12025550123/);
    }
    await assert.rejects(runCommunicationCli(["test", "--channel", "sms", "--to", "7146004407"], root, smsEnv), CommunicationUsageError);
    assert.equal(calls.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved reports fan out to private lists independently, and a partial failure is explicit without another Azure call", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-communicate-send-"));
  const output: string[] = [];
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert(String(url).startsWith("https://api.brevo.com/") || String(url).startsWith("https://api.twilio.com/"));
    calls.push({ url: String(url), body: requestBody(url, options) });
    return String(url).endsWith("/smtp/email")
      ? new Response(JSON.stringify({ messageId: `<email-${calls.length}@brevo.test>` }), { status: 201 })
      : new Response(JSON.stringify({ code: 21606, message: "PRIVATE provider detail" }), { status: 400 });
  });
  try {
    const stored = seed(root);
    const env = { ...brevoEnvironment, ...twilioEnvironment, REPORT_EMAIL_RECIPIENTS: "parent@example.test,other@example.test" };
    await assert.rejects(withLocalDiagnostics(root, "cli", () =>
      runCommunicationCli(["send", "--report", stored.reportId], root, env)), ReportDeliveryError);
    const result = JSON.parse(output[0]);
    assert.equal(result.reportId, stored.reportId);
    assert.equal(result.status, "partial");
    assert.equal(result.accepted.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].code, "PROVIDER_SENDER");
    assert.equal(calls.length, 3);
    const emails = calls.filter(call => call.url.endsWith("/smtp/email"));
    assert(emails.every(call => Array.isArray(call.body.to) && call.body.to.length === 1));
    assert(emails.every(call => String(call.body.textContent).endsWith(stored.text)));
    const key = readFileSync(path.join(root, "playwright/.auth/messages.key"));
    const store = new SqliteReviewStore(path.join(root, "data/database/schoolhawk.sqlite"), key);
    try {
      const email = store.getPreviousCommunication(stored.studentRefs)!.latestEmail;
      assert.equal(email.text, emails[0].body.textContent);
      assert.equal(email.subject, emails[0].body.subject);
      assert.equal(email.kind, "report");
      assert.equal(email.reportId, stored.reportId);
      assert.equal(Object.hasOwn(email, "to"), false);
    } finally { store.close(); key.fill(0); }
    const sms = calls.find(call => call.url.endsWith("/Messages.json"))!;
    assert(!String(sms.body.Body).includes(stored.text));
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.doesNotMatch(log, /PRIVATE_AI_REPORT_TEXT|PRIVATE_BREVO_KEY|PRIVATE_TWILIO_TOKEN|Basic |parent@example|12025550123/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted email with a history persistence failure fails explicitly rather than claiming success or retrying", async context => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-email-persistence-failure-"));
  const output: string[] = [];
  let sends = 0;
  context.mock.method(console, "log", (value: string) => output.push(value));
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async () => {
    sends++;
    return new Response(JSON.stringify({ messageId: "<accepted@example.test>" }), { status: 201 });
  });
  try {
    const stored = seed(root);
    const connection = new Database(path.join(root, "data/database/schoolhawk.sqlite"));
    try {
      connection.exec("CREATE TRIGGER fail_email_history BEFORE INSERT ON email_communications BEGIN SELECT RAISE(ABORT, 'PRIVATE_WRITE_FAILURE'); END;");
    } finally { connection.close(); }
    await assert.rejects(runCommunicationCli(["send", "--report", stored.reportId, "--channel", "email"], root,
      { ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "" }), error => {
      assert(error instanceof AgentReportStorageError);
      assert.match(error.message, /accepted.*could not be saved/);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(sends, 1);
    assert.equal(output.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("report delivery constructs only providers with selected nonempty recipient lists", () => {
  assert(prepareReportDelivery({ ...brevoEnvironment, REPORT_SMS_RECIPIENTS: "" }).communicator);
  assert(prepareReportDelivery({ ...twilioEnvironment, REPORT_SMS_RECIPIENTS: "+12025550123",
    BREVO_KEY: "conflicting", BREVIO_KEY: "unused" }, "sms").communicator);
  assert.throws(() => prepareReportDelivery(brevoEnvironment), CommunicationError);
  assert.throws(() => prepareReportDelivery({ ...twilioEnvironment, REPORT_EMAIL_RECIPIENTS: "parent@example.test" }), CommunicationError);
});
