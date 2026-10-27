import assert from "node:assert/strict";
import { test } from "node:test";
import { withDiagnosticSink } from "@schoolhawk/core/diagnostics";
import { CommunicationError, ReportCommunicator, prepareSmsReport } from "../index";
import { TwilioApiError, TwilioSmsChannel, createTwilioSmsChannelFromEnv } from "../twilio";
import { savedReport, transportFixture, twilioEnvironment, twilioReceipt } from "./fixtures";

const settings = {
  accountSid: twilioEnvironment.TWILIO_ACCOUNT_SID,
  authToken: twilioEnvironment.TWILIO_AUTH_TOKEN,
  fromNumber: twilioEnvironment.TWILIO_FROM_NUMBER,
};
const signal = () => new AbortController().signal;

test("Twilio sends one form-encoded SMS with Basic authentication and the original bounded notice", async () => {
  const { calls, transport } = transportFixture(twilioReceipt());
  const message = prepareSmsReport(savedReport(), "+12025550123");
  const controller = new AbortController();
  const result = await new TwilioSmsChannel(settings, transport).send(message, { signal: controller.signal });
  assert.equal(result.provider, "twilio-sms");
  assert.equal(result.providerMessageId, twilioReceipt().sid);
  assert.equal(result.status, "accepted");
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.url, `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.signal, controller.signal);
  const headers = new Headers(request.options.headers);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`);
  assert.equal(headers.get("idempotency-key"), null);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(request.options.body))),
    { To: message.to, Body: message.text, From: settings.fromNumber });
  assert(message.text.length <= 160);
  assert.doesNotMatch(String(request.options.body), /PRIVATE_AI_REPORT|PRIVATE_TWILIO_TOKEN|StatusCallback|MediaUrl/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TWILIO_TOKEN/);
});

test("Twilio Messaging Services use MessagingServiceSid instead of a From number", async () => {
  const { calls, transport } = transportFixture(twilioReceipt({ status: "accepted" }));
  const messagingServiceSid = `MG${"c".repeat(32)}`;
  const channel = new TwilioSmsChannel({ ...settings, fromNumber: undefined, messagingServiceSid }, transport);
  await channel.send(prepareSmsReport(savedReport(), "+12025550123"), { signal: signal() });
  const body = new URLSearchParams(String(calls[0].options.body));
  assert.equal(body.get("MessagingServiceSid"), messagingServiceSid);
  assert.equal(body.has("From"), false);
});

test("Twilio configuration requires account credentials and exactly one valid sender", () => {
  assert(createTwilioSmsChannelFromEnv(twilioEnvironment) instanceof TwilioSmsChannel);
  assert(createTwilioSmsChannelFromEnv({ ...twilioEnvironment, TWILIO_FROM_NUMBER: "",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}` }) instanceof TwilioSmsChannel);
  assert.doesNotMatch(JSON.stringify(createTwilioSmsChannelFromEnv(twilioEnvironment)), /PRIVATE_TWILIO_TOKEN/);
  for (const options of [
    { ...settings, accountSid: "" }, { ...settings, accountSid: `AC${"/".repeat(32)}` },
    { ...settings, authToken: "" }, { ...settings, authToken: "bad\r\nheader" },
    { ...settings, fromNumber: "12025550100" }, { ...settings, fromNumber: undefined },
    { ...settings, messagingServiceSid: `MG${"c".repeat(32)}` },
    { ...settings, fromNumber: undefined, messagingServiceSid: "bad" },
  ]) assert.throws(() => new TwilioSmsChannel(options), error =>
    error instanceof CommunicationError && error.code === "CONFIGURATION");
});

test("invalid or oversized SMS messages fail before contacting Twilio", async () => {
  const { calls, transport } = transportFixture(twilioReceipt());
  const channel = new TwilioSmsChannel(settings, transport);
  const message = prepareSmsReport(savedReport(), "+12025550123");
  for (const invalid of [{ ...message, to: "12025550123" }, { ...message, text: "x".repeat(161) }, { ...message, text: "Unicode \u2603" }]) {
    await assert.rejects(channel.send(invalid, { signal: signal() }), error =>
      error instanceof CommunicationError && error.code === "INVALID_MESSAGE");
  }
  assert.equal(calls.length, 0);
});

test("Twilio rejection codes are classified without exposing raw errors, phone numbers or credentials", async () => {
  for (const [status, code, expected, outcome] of [
    [401, 20003, "PROVIDER_AUTHENTICATION", "not-sent"],
    [403, 20003, "PROVIDER_AUTHENTICATION", "not-sent"],
    [429, 20429, "PROVIDER_RATE_LIMITED", "not-sent"],
    [400, 21606, "PROVIDER_SENDER", "not-sent"],
    [400, 21660, "PROVIDER_SENDER", "not-sent"],
    [400, 30032, "PROVIDER_REGISTRATION", "not-sent"],
    [400, 30034, "PROVIDER_REGISTRATION", "not-sent"],
    [400, 21608, "PROVIDER_REJECTED", "not-sent"],
    [400, 21610, "PROVIDER_REJECTED", "not-sent"],
    [503, 20003, "PROVIDER_FAILED", "unknown"],
  ] as const) {
    const { calls, transport } = transportFixture({ code, message: "PRIVATE +12025550123 PRIVATE_TWILIO_TOKEN" }, status);
    await assert.rejects(new TwilioSmsChannel(settings, transport).send(
      prepareSmsReport(savedReport(), "+12025550123"), { signal: signal() }), error => {
      assert(error instanceof TwilioApiError);
      assert.equal(error.code, expected);
      assert.equal(error.outcome, outcome);
      assert.equal(error.httpStatus, status);
      assert.equal(error.providerCode, code);
      assert.doesNotMatch(error.message, /PRIVATE|12025550123/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("Twilio accepts only matching outgoing message receipts and never treats failed or scheduled messages as success", async () => {
  const message = prepareSmsReport(savedReport(), "+12025550123");
  for (const status of ["accepted", "queued", "sending", "sent", "delivered"]) {
    const channel = new TwilioSmsChannel(settings, transportFixture(twilioReceipt({ status })).transport);
    assert.equal((await channel.send(message, { signal: signal() })).status, "accepted");
  }
  for (const payload of [
    {}, twilioReceipt({ sid: 123 }), twilioReceipt({ sid: "invalid" }),
    twilioReceipt({ account_sid: `AC${"c".repeat(32)}` }), twilioReceipt({ to: "+12025550124" }),
    ...["scheduled", "failed", "undelivered", "canceled", "received", "receiving", "unknown"].map(status => twilioReceipt({ status })),
    twilioReceipt({ error_code: 30034 }), twilioReceipt({ error_message: "PRIVATE failure" }),
  ]) {
    const { transport } = transportFixture(payload);
    await assert.rejects(new TwilioSmsChannel(settings, transport).send(message, { signal: signal() }), error =>
      error instanceof CommunicationError && error.code === "INVALID_RECEIPT" && error.outcome === "unknown");
  }
});

test("Twilio malformed, oversized, unexpected-status and network responses remain explicit and are never retried", async () => {
  const message = prepareSmsReport(savedReport(), "+12025550123");
  for (const response of [
    () => new Response("<html>PRIVATE</html>", { status: 201 }),
    () => new Response("x".repeat(65537), { status: 201 }),
    () => new Response("{}", { status: 201, headers: { "content-length": "65537" } }),
    () => new Response(JSON.stringify(twilioReceipt()), { status: 200 }),
    () => new Response(JSON.stringify(twilioReceipt()), { status: 202 }),
    () => new Response(null, { status: 204 }),
    () => new Response("", { status: 302 }),
    () => { throw new Error("PRIVATE network failure"); },
  ]) {
    let calls = 0;
    const channel = new TwilioSmsChannel(settings, async () => { calls++; return response(); });
    await assert.rejects(channel.send(message, { signal: signal() }), error =>
      error instanceof CommunicationError && error.outcome === "unknown" && !error.message.includes("PRIVATE"));
    assert.equal(calls, 1);
  }
  await assert.rejects(new TwilioSmsChannel(settings, async () => new Response("PRIVATE", { status: 401 }))
    .send(message, { signal: signal() }), error => error instanceof TwilioApiError && error.code === "PROVIDER_AUTHENTICATION");
});

test("Twilio observes caller cancellation and the communicator does not retry uncertain SMS delivery", async () => {
  let calls = 0;
  const transport: typeof fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls++;
    options?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE connection")), { once: true });
  });
  const communicator = new ReportCommunicator({ sms: new TwilioSmsChannel(settings, transport) }, 10);
  await withDiagnosticSink(() => {}, () => assert.rejects(communicator.sendSms(savedReport(), "+12025550123"),
    error => error instanceof CommunicationError && error.code === "TIMEOUT"));
  assert.equal(calls, 1);
});
