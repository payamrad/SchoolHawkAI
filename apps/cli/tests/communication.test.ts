import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { SqliteReviewStore } from "@schoolhawk/storage/review-sqlite";
import { CommunicationError } from "@schoolhawk/communication";
import { brevoEnvironment, savedReport } from "../../../packages/communication/tests/fixtures";
import { setupDatabase } from "../../../scripts/setup-database";
import { runCli } from "../src/index";
import { CommunicationUsageError, ReportDeliveryError, parseCommunicationArgs, prepareReportDelivery, runCommunicationCli } from "../src/communication";

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
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify(String(url).endsWith("/smtp/email") ? { messageId: "<test@brevo.test>" } : { messageId: 12345 }), { status: 201 });
  });
  try {
    const env = { ...brevoEnvironment, REPORT_EMAIL_RECIPIENTS: "not-the-test@example.test", REPORT_SMS_RECIPIENTS: "+12025550124" };
    await withLocalDiagnostics(root, "cli", () => runCommunicationCli(["test", "--channel", "email", "--to", "parent@example.test"], root, env));
    await withLocalDiagnostics(root, "cli", () => runCommunicationCli(["test", "--channel", "sms", "--to", "+12025550123"], root, env));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.to, [{ email: "parent@example.test" }]);
    assert.equal(calls[1].body.recipient, "+12025550123");
    assert.match(String(calls[0].body.textContent), /No student records/);
    assert.match(String(calls[1].body.content), /No student records/);
    assert.equal(JSON.parse(output[0]).status, "accepted");
    assert.equal(JSON.parse(output[1]).status, "accepted");
    assert.equal(existsSync(path.join(root, "data")), false);
    for (const file of readdirSync(path.join(root, "logs"))) {
      const log = readFileSync(path.join(root, "logs", file), "utf8");
      assert.doesNotMatch(log, /PRIVATE_BREVO_KEY|parent@example|12025550123/);
    }
    await assert.rejects(runCommunicationCli(["test", "--channel", "sms", "--to", "7146004407"], root, env), CommunicationUsageError);
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
    assert(String(url).startsWith("https://api.brevo.com/"));
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return String(url).endsWith("/smtp/email")
      ? new Response(JSON.stringify({ messageId: `<email-${calls.length}@brevo.test>` }), { status: 201 })
      : new Response(JSON.stringify({ code: "not_enough_credits", message: "PRIVATE provider detail" }), { status: 402 });
  });
  try {
    const stored = seed(root);
    const env = { ...brevoEnvironment, REPORT_EMAIL_RECIPIENTS: "parent@example.test,other@example.test" };
    await assert.rejects(withLocalDiagnostics(root, "cli", () =>
      runCommunicationCli(["send", "--report", stored.reportId], root, env)), ReportDeliveryError);
    const result = JSON.parse(output[0]);
    assert.equal(result.reportId, stored.reportId);
    assert.equal(result.status, "partial");
    assert.equal(result.accepted.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].code, "PROVIDER_CREDITS");
    assert.equal(calls.length, 3);
    const emails = calls.filter(call => call.url.endsWith("/smtp/email"));
    assert(emails.every(call => Array.isArray(call.body.to) && call.body.to.length === 1));
    assert(emails.every(call => String(call.body.textContent).endsWith(stored.text)));
    const sms = calls.find(call => call.url.endsWith("/transactionalSMS/sms"))!;
    assert(!String(sms.body.content).includes(stored.text));
    const log = readFileSync(path.join(root, "logs", readdirSync(path.join(root, "logs"))[0]), "utf8");
    assert.doesNotMatch(log, /PRIVATE_AI_REPORT_TEXT|PRIVATE_BREVO_KEY|parent@example|12025550123/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
