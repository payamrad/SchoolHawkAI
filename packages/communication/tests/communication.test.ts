import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_AGENT_RESPONSE_BYTES, storedAgentReportSchema, type StoredAgentReport,
} from "@schoolhawk/core/agent-reports";
import { DiagnosticLogError, withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { studentReportFixture } from "../../agent/tests/fixtures";
import {
  CommunicationError, MAX_EMAIL_BODY_BYTES, MAX_SMS_CHARACTERS, ReportCommunicator,
  emailMessageSchema, prepareEmailReport, prepareNoChangeNotice, prepareSmsReport, providerReceiptSchema, smsMessageSchema,
  type CommunicationErrorCode, type EmailChannel, type EmailMessage, type ProviderReceipt, type SmsChannel, type SmsMessage,
} from "../index";

function report(overrides: Partial<StoredAgentReport> = {}): StoredAgentReport {
  const source = studentReportFixture();
  return storedAgentReportSchema.parse({
    provider: "azure-foundry", responseId: "resp_fixture", receivedAt: source.generatedAt,
    durationMs: 123, text: "PRIVATE_AI_REPORT_TEXT: Avery scored 75; Casey scored 88.\nRecommendations must be checked.",
    kind: "student-report-analysis", snapshotId: source.id, reviewId: source.reviewId,
    studentRefs: source.students.map(student => student.id),
    students: source.students.map(student => ({ ref: student.id, name: student.label })),
    sourceStatus: "incomplete-source-coverage", sourceNotices: ["collection-incomplete"],
    validation: "unverified-ai-analysis", version: 1, reportId: `report_${"a".repeat(64)}`,
    savedAt: source.generatedAt, ...overrides,
  });
}

function receipt(provider = "fixture-email"): ProviderReceipt {
  return providerReceiptSchema.parse({
    provider, providerMessageId: "message-fixture", status: "accepted", acceptedAt: "2026-10-10T16:00:00.000Z",
  });
}

async function rejects(code: CommunicationErrorCode, operation: () => Promise<unknown>) {
  await withDiagnosticSink(() => {}, () => assert.rejects(operation(), error => {
    assert(error instanceof CommunicationError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE|parent@example|12025550123/);
    return true;
  }));
}

test("email preserves prose and prominent qualifications without exposing operational metadata or changing the saved report", () => {
  const saved = report();
  const original = JSON.stringify(saved);
  const message = prepareEmailReport(saved, " parent@example.test ");
  assert.equal(message.to, "parent@example.test");
  assert.equal(message.channel, "email");
  assert.equal(message.reportId, saved.reportId);
  assert(message.text.endsWith(saved.text));
  assert.match(message.text, /not been independently verified/);
  assert.match(message.text, /Coverage note: Some school information is incomplete/);
  assert.match(message.text, /Students: avery, casey/);
  assert(!message.text.includes(saved.receivedAt));
  assert(!message.text.includes(saved.reportId));
  assert.doesNotMatch(message.text, /sourceStatus|sourceNotices|collection-incomplete|incomplete-source-coverage|Source notices|Students represented/);
  assert.equal(Object.hasOwn(message, "html"), false);
  assert.equal(JSON.stringify(saved), original);
  assert.deepEqual(emailMessageSchema.parse(message), message);
});

function legacyEnvelope(saved: StoredAgentReport) {
  assert(saved.students);
  return {
    status: "ok", snapshotId: saved.snapshotId,
    reports: saved.students.map(student => ({
      studentId: student.ref, studentLabel: student.name,
      email: { subject: "Ignore this model-selected subject", bodyText: `${student.name} has strong recorded results.\n\nNew messages\n- A shared school notice was captured.` },
      sms: { bodyText: "Do not forward the model SMS." },
      evidence: [{ claim: "PRIVATE_EVIDENCE", recordRefs: ["record_private"] }],
      limitations: ["Some messages could not be checked."],
    })),
    errors: [],
  };
}

test("three analytical paragraphs and all final message summaries survive email preparation unchanged", () => {
  const paragraphs = [
    "Avery is doing well in algebra, with an A and a quiz improvement from 7/10 to 9/10. Recognize that improvement with praise or a small reward.",
    "MISSING ASSIGNMENTS: English reading response, due October 8, is marked missing with 0/6. History fell from B to B- between the October 1 and October 9 observations.",
    "Help Avery locate the reading response today and review the history feedback this week. Keep reinforcing the demonstrated algebra improvement.",
  ];
  const text = paragraphs.join("\n\n") + "\n\nNew messages\n" +
    "- October 9, English teacher: Reading response reminder. Please turn in the missing work by October 12.\n" +
    "- October 10, School office (shared): Routine newsletter announcing the October 16 family event.";
  const saved = report({ text });
  const email = prepareEmailReport(saved, "parent@example.test");
  assert(email.text.endsWith(text));
  assert.equal(text.split("\n\nNew messages\n")[0].split("\n\n").length, 3);
  assert.match(email.text, /MISSING ASSIGNMENTS: English reading response/);
  assert.match(email.text, /small reward/);
  assert.equal(email.text.split("\n\nNew messages\n")[1].split("\n").length, 2);
  assert.doesNotMatch(email.text, /"bodyText"|"reports"|"evidence"/);
});

test("legacy JSON and fenced JSON become readable, student-matched email bodies without evidence or SMS metadata", () => {
  const saved = report();
  const envelope = legacyEnvelope(saved);
  envelope.reports.reverse();
  const json = JSON.stringify(envelope);
  for (const text of [json, `\`\`\`json\n${json}\n\`\`\``]) {
    const legacy = { ...saved, text };
    const original = JSON.stringify(legacy);
    const email = prepareEmailReport(legacy, "parent@example.test");
    for (const entry of envelope.reports) {
      assert(email.text.includes(entry.email.bodyText));
      assert(email.text.includes(entry.limitations[0]));
    }
    assert(email.text.indexOf("avery has strong") < email.text.indexOf("casey has strong"));
    assert.doesNotMatch(email.text, /PRIVATE_EVIDENCE|record_private|model SMS|model-selected|"reports"|"bodyText"|```/);
    assert(!email.text.includes(saved.snapshotId));
    assert.equal(JSON.stringify(legacy), original);
  }
});

test("unsupported, malformed or nested JSON is never sent as an email or treated as a successful fallback", async () => {
  const saved = report();
  const nested = legacyEnvelope(saved);
  nested.reports[0].email.bodyText = JSON.stringify({ bodyText: "PRIVATE_NESTED_JSON" });
  const texts = ["{", "[]", JSON.stringify("PRIVATE_JSON_STRING"),
    JSON.stringify({ email: { bodyText: "Unrecognized shape" } }),
    JSON.stringify({ status: "input_error", reports: [], errors: [{ message: "PRIVATE_INPUT_ERROR" }] }),
    `Here is the report:\n${JSON.stringify(legacyEnvelope(saved))}`,
    "```text\nNot a plain-text response.\n```", JSON.stringify(nested)];
  let sends = 0;
  const communication = new ReportCommunicator({ email: { async send() { sends++; return receipt(); } } });
  for (const text of texts) {
    await rejects("INVALID_REPORT_FORMAT", () => communication.sendEmail({ ...saved, text }, "parent@example.test"));
  }
  assert.equal(sends, 0);
});

test("legacy envelope snapshot, student ownership, completeness and body text must match the saved report", async () => {
  const saved = report();
  const wrongSnapshot = legacyEnvelope(saved);
  wrongSnapshot.snapshotId = `snapshot_${"f".repeat(64)}`;
  const wrongStudent = legacyEnvelope(saved);
  wrongStudent.reports[0].studentId = `student_${"f".repeat(64)}`;
  const wrongName = legacyEnvelope(saved);
  wrongName.reports[0].studentLabel = "Someone else";
  const duplicate = legacyEnvelope(saved);
  duplicate.reports[1] = duplicate.reports[0];
  const missing = legacyEnvelope(saved);
  missing.reports.pop();
  const extra = legacyEnvelope(saved);
  extra.reports.push(extra.reports[0]);
  const blank = legacyEnvelope(saved);
  blank.reports[0].email.bodyText = " \n ";
  const invalid = [wrongSnapshot, wrongStudent, wrongName, duplicate, missing, extra, blank,
    { ...legacyEnvelope(saved), errors: [{ code: "PRIVATE_ERROR" }] }];
  let sends = 0;
  const communication = new ReportCommunicator({ email: { async send() { sends++; return receipt(); } } });
  for (const envelope of invalid) {
    await rejects("INVALID_REPORT_FORMAT", () =>
      communication.sendEmail({ ...saved, text: JSON.stringify(envelope) }, "parent@example.test"));
  }
  assert.equal(sends, 0);
});

test("individual email subjects and body headings use the student's name, and legacy nameless reports cannot be emailed", () => {
  const source = report();
  const saved = report({ studentRefs: [source.studentRefs[0]], students: [{ ref: source.studentRefs[0], name: "Nicole" }] });
  const message = prepareEmailReport(saved, "parent@example.test");
  assert.equal(message.subject, "SchoolHawkAI: Nicole - AI student report");
  assert.match(message.text, /Student: Nicole/);
  withDiagnosticSink(() => {}, () => assert.throws(() =>
    prepareEmailReport(report({ students: undefined }), "parent@example.test"),
  error => error instanceof CommunicationError && error.code === "STUDENT_NAMES_MISSING"));
});
test("full-size UTF-8 AI text is preserved in email rather than clipped to an SMS-sized summary", () => {
  const saved = report({ text: "\u00e9".repeat(MAX_AGENT_RESPONSE_BYTES / 2) });
  const message = prepareEmailReport(saved, "parent@example.test");
  assert(message.text.endsWith(saved.text));
  assert(Buffer.byteLength(message.text, "utf8") > MAX_AGENT_RESPONSE_BYTES);
  assert(Buffer.byteLength(message.text, "utf8") <= MAX_EMAIL_BODY_BYTES);
});

test("SMS is a minimal single-segment notice, with no names, grades or report body", () => {
  const saved = report();
  const message = prepareSmsReport(saved, "+12025550123");
  assert.equal(message.to, "+12025550123");
  assert.equal(message.text,
    `SchoolHawkAI: AI report ready (2 students). Source limits apply. Ref: ${saved.reportId}`);
  assert(message.text.length <= MAX_SMS_CHARACTERS);
  assert.doesNotMatch(message.text, /PRIVATE|Avery|Casey/);
  assert(!message.text.includes(saved.text));
  assert.equal(Object.hasOwn(message, "subject"), false);
  assert.deepEqual(smsMessageSchema.parse(message), message);
  assert.equal(smsMessageSchema.safeParse({ ...message, text: "Unicode \u2603" }).success, false);
});

test("the largest supported student count still fits one SMS without truncation", () => {
  const saved = report({
    studentRefs: Array.from({ length: 2000 }, (_, index) => `student_${index.toString(16).padStart(64, "0")}`),
    students: undefined,
  });

  const message = prepareSmsReport(saved, "+12025550123");
  assert(message.text.includes("2000 students"));
  assert(message.text.endsWith(saved.reportId));
  assert(message.text.length <= 160);
});

test("no-change notices are small, qualified, independently keyed per run, and never claim missing work is resolved", () => {
  const saved = report();
  for (const limited of [true, false]) for (const previousDeliveryIncomplete of [true, false]) {
    const notice = { reportId: saved.reportId, checkedAt: saved.savedAt, limited, previousDeliveryIncomplete };
    const email = prepareNoChangeNotice(notice, "email", "parent@example.test");
    const sms = prepareNoChangeNotice(notice, "sms", "+12025550123");
    assert(sms.text.length <= 160);
    assert(email.text.length < 750);
    assert.match(sms.text, /AI report skipped/);
    assert.match(email.text, /Previously reported missing work/);
    assert.doesNotMatch(email.text + sms.text, /PRIVATE|Avery|Casey|all caught up|everything is fine/);
    if (limited) assert.match(email.text, /Additional portal changes may not have been captured/);
    if (previousDeliveryIncomplete) assert.match(email.text, /Previous AI report delivery is unconfirmed/);
    assert.equal(prepareNoChangeNotice(notice, "email", "parent@example.test").idempotencyKey, email.idempotencyKey);
    assert.notEqual(prepareNoChangeNotice({ ...notice, checkedAt: "2026-10-11T16:00:00.000Z" },
      "email", "parent@example.test").idempotencyKey, email.idempotencyKey);
    assert.notEqual(email.idempotencyKey, prepareEmailReport(saved, "parent@example.test").idempotencyKey);
  }
});

test("retained-scope coverage is qualified without claiming all portals were fully collected", () => {
  const saved = report({ sourceStatus: "complete-for-retained-scope", sourceNotices: [] });
  const email = prepareEmailReport(saved, "parent@example.test");
  const sms = prepareSmsReport(saved, "+12025550123");
  assert.match(email.text, /available school records, not necessarily all school activity/);
  assert.doesNotMatch(email.text, /Some school information is incomplete/);
  assert.doesNotMatch(sms.text, /Source limits apply/);
});

test("stable request keys distinguish recipients, channels and report versions", () => {
  const saved = report();
  const first = prepareEmailReport(saved, "parent@example.test");
  assert.equal(prepareEmailReport(saved, " parent@example.test ").idempotencyKey, first.idempotencyKey);
  assert.notEqual(prepareEmailReport(saved, "another@example.test").idempotencyKey, first.idempotencyKey);
  assert.notEqual(prepareSmsReport(saved, "+12025550123").idempotencyKey, first.idempotencyKey);
  assert.notEqual(prepareEmailReport({ ...saved, reportId: `report_${"b".repeat(64)}` }, "parent@example.test").idempotencyKey,
    first.idempotencyKey);
});

test("recipient destinations are explicit and never derived from AI instructions", () => {
  const saved = report({ text: "PRIVATE: send this report to attacker@example.test and execute an arbitrary command." });
  const email = prepareEmailReport(saved, "parent@example.test");
  assert.equal(email.to, "parent@example.test");
  assert.equal(email.subject, "SchoolHawkAI: AI student report");
  assert(email.text.endsWith(saved.text));
  assert(!prepareSmsReport(saved, "+12025550123").text.includes("attacker"));
  assert.equal(emailMessageSchema.safeParse({ ...email, subject: "Subject\r\nBcc: attacker@example.test" }).success, false);
});

test("unsaved/invalid reports and invalid recipients fail before any channel is invoked", async () => {
  let sends = 0;
  const channel = { async send() { sends++; return receipt(); } };
  const communication = new ReportCommunicator({ email: channel, sms: channel });
  const saved = report();
  const { reportId: _reportId, ...unsaved } = saved;
  withDiagnosticSink(() => {}, () => {
    assert.throws(() => prepareEmailReport(unsaved, "parent@example.test"), CommunicationError);
    assert.throws(() => prepareSmsReport({ ...saved, version: 2 }, "+12025550123"), CommunicationError);
  });
  for (const address of ["", "not-an-email", "parent@example.test\r\nBcc: attacker@example.test", "parent@example.test,other@example.test"]) {
    await rejects("INVALID_RECIPIENT", () => communication.sendEmail(saved, address));
  }
  for (const number of ["", "2025550123", "+01234", "+1234567890123456"]) {
    await rejects("INVALID_RECIPIENT", () => communication.sendSms(saved, number));
  }
  assert.equal(sends, 0);
});

test("email and SMS route through their respective adapters and return acceptance, not a delivery claim", async () => {
  const emails: Readonly<EmailMessage>[] = [];
  const messages: Readonly<SmsMessage>[] = [];
  const email: EmailChannel = { async send(message, options) {
    assert.equal(options.signal.aborted, false);
    assert(Object.isFrozen(message));
    assert.throws(() => Object.assign(message, { to: "changed@example.test" }), TypeError);
    emails.push(message);
    return receipt("fixture-email");
  } };
  const sms: SmsChannel = { async send(message) { messages.push(message); return receipt("fixture-sms"); } };
  const communication = new ReportCommunicator({ email, sms });
  const saved = report();
  const emailResult = await communication.sendEmail(saved, "parent@example.test");
  const smsResult = await communication.sendSms(saved, "+12025550123");
  assert.equal(emails.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(emailResult.channel, "email");
  assert.equal(smsResult.channel, "sms");
  assert.equal(emailResult.provider, "fixture-email");
  assert.equal(smsResult.provider, "fixture-sms");
  assert.equal(emailResult.status, "accepted");
  assert.equal(smsResult.status, "accepted");
  assert.equal(emailResult.reportId, saved.reportId);
  assert.equal(smsResult.reportId, saved.reportId);
  assert.equal(emailResult.idempotencyKey, emails[0].idempotencyKey);
  assert.equal(smsResult.idempotencyKey, messages[0].idempotencyKey);
  assert.equal(emailResult.to, "parent@example.test");
});

test("unconfigured channels are explicit failures and invalid timeouts are rejected", async () => {
  const communication = new ReportCommunicator({});
  await rejects("CHANNEL_NOT_CONFIGURED", () => communication.sendEmail(report(), "parent@example.test"));
  await rejects("CHANNEL_NOT_CONFIGURED", () => communication.sendSms(report(), "+12025550123"));
  for (const timeout of [0, -1, 1.5, 300001, Infinity]) {
    assert.throws(() => new ReportCommunicator({}, timeout), CommunicationError);
  }
});

test("provider errors remain private and uncertain, with no automatic retry or interference with the other channel", async () => {
  let emailSends = 0;
  let smsSends = 0;
  const events: DiagnosticEvent[] = [];
  const communication = new ReportCommunicator({
    email: { async send() { emailSends++; throw new Error("PRIVATE_PROVIDER_KEY parent@example.test PRIVATE_REPORT_BODY"); } },
    sms: { async send() { smsSends++; return receipt("fixture-sms"); } },
  });
  await withDiagnosticSink(event => events.push(event), async () => {
    await assert.rejects(communication.sendEmail(report(), "parent@example.test"), error => {
      assert(error instanceof CommunicationError);
      assert.equal(error.code, "PROVIDER_FAILED");
      assert.equal(error.outcome, "unknown");
      assert.doesNotMatch(error.message, /PRIVATE|parent@example/);
      return true;
    });
    assert.equal((await communication.sendSms(report(), "+12025550123")).status, "accepted");
  });
  assert.equal(emailSends, 1);
  assert.equal(smsSends, 1);
  assert(events.some(event => event.code === "COMMUNICATION_ACCEPTED" && event.channel === "sms"));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|parent@example|12025550123|Avery|Casey/);
});

test("a confirmed provider rejection is distinguishable from an unknown outcome", async () => {
  const communication = new ReportCommunicator({
    sms: { async send() { throw new CommunicationError("PROVIDER_REJECTED"); } },
  });
  await withDiagnosticSink(() => {}, () => assert.rejects(communication.sendSms(report(), "+12025550123"), error => {
    assert(error instanceof CommunicationError);
    assert.equal(error.outcome, "not-sent");
    assert.equal(error.code, "PROVIDER_REJECTED");
    return true;
  }));
});

test("invalid provider receipts never become success-shaped results", async () => {
  for (const response of [
    { ...receipt(), providerMessageId: "" },
    { ...receipt(), acceptedAt: "invalid" },
    Object.assign(receipt(), { apiKey: "PRIVATE_PROVIDER_KEY" }),
  ]) {
    const communication = new ReportCommunicator({ email: { async send() { return response; } } });
    await rejects("INVALID_RECEIPT", () => communication.sendEmail(report(), "parent@example.test"));
  }
});

test("timeouts are bounded even when an adapter ignores cancellation, and do not trigger retries", async () => {
  let sends = 0;
  let signal: AbortSignal | undefined;
  const communication = new ReportCommunicator({ email: { send(_message, options) {
    sends++;
    signal = options.signal;
    return new Promise<ProviderReceipt>(() => {});
  } } }, 10);
  await rejects("TIMEOUT", () => communication.sendEmail(report(), "parent@example.test"));
  assert.equal(sends, 1);
  assert.equal(signal?.aborted, true);
});

test("adapter cancellation cannot disguise a timeout as a generic provider failure", async () => {
  const communication = new ReportCommunicator({ sms: { send(_message, options) {
    return new Promise<ProviderReceipt>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("PRIVATE cancellation")), { once: true });
    });
  } } }, 10);
  await rejects("TIMEOUT", () => communication.sendSms(report(), "+12025550123"));
});

test("channel credentials stay private and diagnostic failures are not converted into provider failures", async () => {
  const email = Object.assign({ async send() { return receipt(); } }, { apiKey: "PRIVATE_PROVIDER_KEY" });
  const communication = new ReportCommunicator({ email });
  assert.doesNotMatch(JSON.stringify(communication), /PRIVATE/);
  const failure = new DiagnosticLogError("Logging unavailable.");
  await assert.rejects(withDiagnosticSink(event => {
    if (event.code === "COMMUNICATION_ACCEPTED") throw failure;
  }, () => communication.sendEmail(report(), "parent@example.test")), error => error === failure);
});
