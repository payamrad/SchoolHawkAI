import assert from "node:assert/strict";
import { test } from "node:test";
import { withDiagnosticSink } from "@schoolhawk/core/diagnostics";
import { CommunicationError, ReportCommunicator, prepareEmailReport, prepareSmsReport } from "../index";
import { BrevoApiError, BrevoEmailChannel, BrevoSmsChannel, createBrevoChannelsFromEnv, readReportRecipients } from "../brevo";
import { brevoEnvironment, savedReport } from "./fixtures";

function transportFixture(payload: unknown, status = 201) {
  const calls: { url: string; options: RequestInit }[] = [];
  const transport: typeof fetch = async (url, options) => {
    assert(options);
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, transport };
}

function email(transport: typeof fetch) {
  return new BrevoEmailChannel({ apiKey: brevoEnvironment.BREVO_KEY,
    senderEmail: brevoEnvironment.BREVO_SENDER_EMAIL, senderName: brevoEnvironment.BREVO_SENDER_NAME }, transport);
}

test("Brevo email uses the transactional text endpoint, one explicit recipient and a stable idempotency header", async () => {
  const { calls, transport } = transportFixture({ messageId: "<fixture@brevo.test>" });
  const message = prepareEmailReport(savedReport(), "parent@example.test");
  const channel = email(transport);
  const result = await channel.send(message, { signal: new AbortController().signal });
  assert.equal(result.provider, "brevo-email");
  assert.equal(result.providerMessageId, "<fixture@brevo.test>");
  assert.equal(result.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(new Headers(calls[0].options.headers).get("api-key"), brevoEnvironment.BREVO_KEY);
  const body = JSON.parse(String(calls[0].options.body));
  assert.deepEqual(body.sender, { email: "sender@example.test", name: "SchoolHawkAI" });
  assert.deepEqual(body.to, [{ email: "parent@example.test" }]);
  assert.equal(body.textContent, message.text);
  assert.match(body.headers.idempotencyKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(body.headers.idempotencyKey.length, 36);
  assert(body.tags.includes(message.idempotencyKey));
  for (const name of ["htmlContent", "templateId", "attachment", "scheduledAt", "cc", "bcc"]) assert.equal(Object.hasOwn(body, name), false);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_BREVO_KEY/);
  await channel.send(message, { signal: new AbortController().signal });
  assert.equal(JSON.parse(String(calls[1].options.body)).headers.idempotencyKey, body.headers.idempotencyKey);
  await channel.send(prepareEmailReport(savedReport(), "other@example.test"), { signal: new AbortController().signal });
  assert.notEqual(JSON.parse(String(calls[2].options.body)).headers.idempotencyKey, body.headers.idempotencyKey);
});

test("Brevo email accepts either documented single-message receipt shape without inventing IDs", async () => {
  for (const payload of [{ messageId: "<a@b.test>" }, { messageIds: ["<a@b.test>"] }]) {
    const { transport } = transportFixture(payload);
    assert.equal((await email(transport).send(prepareEmailReport(savedReport(), "parent@example.test"),
      { signal: new AbortController().signal })).providerMessageId, "<a@b.test>");
  }
  for (const payload of [{}, { messageIds: ["one", "two"] }, { messageId: "one", messageIds: ["two"] }]) {
    await assert.rejects(email(transportFixture(payload).transport).send(
      prepareEmailReport(savedReport(), "parent@example.test"), { signal: new AbortController().signal }),
    error => error instanceof CommunicationError && error.code === "INVALID_RECEIPT");
  }
});

test("Brevo SMS uses the API-reference endpoint and preserves the single-segment transactional notice", async () => {
  const { calls, transport } = transportFixture({ messageId: 1511882900176220, smsCount: 1, reference: "fixture-reference" });
  const channel = new BrevoSmsChannel({ apiKey: brevoEnvironment.BREVO_KEY, sender: "SchoolHawk" }, transport);
  const message = prepareSmsReport(savedReport(), "+12025550123");
  const result = await channel.send(message, { signal: new AbortController().signal });
  assert.equal(result.provider, "brevo-sms");
  assert.equal(result.providerMessageId, "1511882900176220");
  assert.equal(calls[0].url, "https://api.brevo.com/v3/transactionalSMS/sms");
  const body = JSON.parse(String(calls[0].options.body));
  assert.deepEqual(body, { sender: "SchoolHawk", recipient: "+12025550123", content: message.text,
    type: "transactional", unicodeEnabled: false, tag: message.idempotencyKey });
  assert(body.content.length <= 160);
  assert.doesNotMatch(body.content, /PRIVATE_AI_REPORT|STOP/);
  assert.equal(Object.hasOwn(body, "organisationPrefix"), false);
  assert.equal(Object.hasOwn(body, "webUrl"), false);
});

test("unsafe SMS numeric IDs and missing receipts remain uncertain rather than being rounded or fabricated", async () => {
  for (const messageId of [Number.MAX_SAFE_INTEGER + 1, -1, "not-a-number"]) {
    const channel = new BrevoSmsChannel({ apiKey: brevoEnvironment.BREVO_KEY, sender: "SchoolHawk" },
      transportFixture({ messageId }).transport);
    await assert.rejects(channel.send(prepareSmsReport(savedReport(), "+12025550123"),
      { signal: new AbortController().signal }), error => error instanceof CommunicationError && error.outcome === "unknown");
  }
});

test("Brevo errors expose safe classifications but never the raw provider message or credentials", async () => {
  const cases = [
    { status: 403, body: { code: "permission_denied", message: "PRIVATE key is not authorized" }, expected: "PROVIDER_AUTHENTICATION", outcome: "not-sent" },
    { status: 402, body: { code: "not_enough_credits", message: "PRIVATE credits" }, expected: "PROVIDER_CREDITS", outcome: "not-sent" },
    { status: 400, body: { code: "account_under_validation", message: "PRIVATE account" }, expected: "PROVIDER_ACCOUNT_PENDING", outcome: "not-sent" },
    { status: 400, body: { code: "invalid_parameter", message: "PRIVATE sender domain not verified" }, expected: "PROVIDER_SENDER", outcome: "not-sent" },
    { status: 400, body: { code: "invalid_parameter", message: "PRIVATE toll-free registration is required" }, expected: "PROVIDER_REGISTRATION", outcome: "not-sent" },
    { status: 429, body: { message: "PRIVATE limit" }, expected: "PROVIDER_RATE_LIMITED", outcome: "not-sent" },
    { status: 400, body: { code: "duplicate_parameter", message: "PRIVATE duplicate" }, expected: "PROVIDER_FAILED", outcome: "unknown" },
    { status: 500, body: { code: "permission_denied", message: "PRIVATE uncertain backend" }, expected: "PROVIDER_FAILED", outcome: "unknown" },
  ];
  for (const { status, body, expected, outcome } of cases) {
    const { calls, transport } = transportFixture(body, status);
    await assert.rejects(email(transport).send(prepareEmailReport(savedReport(), "parent@example.test"),
      { signal: new AbortController().signal }), error => {
      assert(error instanceof BrevoApiError);
      assert.equal(error.code, expected);
      assert.equal(error.outcome, outcome);
      assert.equal(error.httpStatus, status);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("malformed, oversized and scheduled-only replies do not become successful acceptance receipts", async () => {
  const message = prepareEmailReport(savedReport(), "parent@example.test");
  for (const response of [
    () => new Response("<html>PRIVATE</html>", { status: 201 }),
    () => new Response("x".repeat(65537), { status: 201 }),
    () => new Response("{}", { status: 202 }),
  ]) {
    await assert.rejects(email(async () => response()).send(message, { signal: new AbortController().signal }),
      error => error instanceof CommunicationError && error.outcome === "unknown");
  }
});

test("Brevo channels use caller cancellation and the communicator never retries an uncertain request", async () => {
  let calls = 0;
  const transport: typeof fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls++;
    options?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE connection")), { once: true });
  });
  const communicator = new ReportCommunicator({ email: email(transport) }, 10);
  await withDiagnosticSink(() => {}, () => assert.rejects(communicator.sendEmail(savedReport(), "parent@example.test"),
    error => error instanceof CommunicationError && error.code === "TIMEOUT"));
  assert.equal(calls, 1);
});

test("private recipient lists validate all entries, reject duplicates, and support selecting a single channel", () => {
  assert.deepEqual(readReportRecipients(brevoEnvironment), { email: ["parent@example.test"], sms: ["+12025550123"] });
  assert.deepEqual(readReportRecipients({ REPORT_EMAIL_RECIPIENTS: " first@example.test, second@example.test " }), {
    email: ["first@example.test", "second@example.test"], sms: [],
  });
  assert.deepEqual(readReportRecipients({ REPORT_EMAIL_RECIPIENTS: "parent@example.test", REPORT_SMS_RECIPIENTS: "invalid" }, "email"), {
    email: ["parent@example.test"], sms: [],
  });
  for (const environment of [
    { REPORT_EMAIL_RECIPIENTS: "parent@example.test," },
    { REPORT_EMAIL_RECIPIENTS: "parent@example.test,parent@example.test" },
    { REPORT_SMS_RECIPIENTS: "7146004407" },
    { REPORT_SMS_RECIPIENTS: "+12025550123,+12025550123" },
  ]) assert.throws(() => readReportRecipients(environment), CommunicationError);
});

test("configuration preserves BREVO_KEY, supports the supplied spelling alias, and isolates optional channels", () => {
  const configured = createBrevoChannelsFromEnv(brevoEnvironment);
  assert(configured.email && configured.sms);
  assert.doesNotMatch(JSON.stringify(configured), /PRIVATE_BREVO_KEY/);
  assert(createBrevoChannelsFromEnv({ ...brevoEnvironment, BREVO_KEY: undefined, BREVIO_KEY: "PRIVATE_ALIAS" }, ["email"]).email);
  assert(createBrevoChannelsFromEnv({ BREVO_KEY: "PRIVATE_KEY", BREVO_SMS_SENDER: "+18005550123" }, ["sms"]).sms);
  assert.throws(() => createBrevoChannelsFromEnv({ ...brevoEnvironment, BREVIO_KEY: "CONFLICTING_KEY" }), CommunicationError);
  assert.throws(() => createBrevoChannelsFromEnv({ ...brevoEnvironment, BREVO_KEY: "" }), CommunicationError);
  assert.throws(() => new BrevoSmsChannel({ apiKey: "PRIVATE_KEY", sender: "SchoolHawkAI" }), CommunicationError);
  assert.throws(() => new BrevoEmailChannel({ apiKey: "PRIVATE_KEY", senderEmail: "bad\r\nheader@example.test" }), CommunicationError);
});
