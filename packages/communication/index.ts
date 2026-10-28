import { createHash } from "node:crypto";
import { z } from "zod";
import {
  agentReportIdSchema, MAX_EMAIL_BODY_BYTES, storedAgentReportSchema, type StoredAgentReport,
} from "@schoolhawk/core/agent-reports";
import { reviewTimestamp } from "@schoolhawk/core/review";
import { DiagnosticLogError, reportDiagnostic } from "@schoolhawk/core/diagnostics";

export type CommunicationChannelName = "email" | "sms";
export const MAX_SMS_CHARACTERS = 160;
export { MAX_EMAIL_BODY_BYTES } from "@schoolhawk/core/agent-reports";
export const emailAddressSchema = z.string().trim().pipe(z.email()).refine(value => value.length <= 254);
export const phoneNumberSchema = z.string().trim().regex(/^\+[1-9]\d{1,14}$/);
const messageBase = {
  reportId: agentReportIdSchema,
  idempotencyKey: z.string().regex(/^delivery_[a-f0-9]{64}$/),
};
export const emailMessageSchema = z.object({
  ...messageBase, channel: z.literal("email"), to: emailAddressSchema,
  subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/),
  text: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= MAX_EMAIL_BODY_BYTES),
}).strict();
export type EmailMessage = z.infer<typeof emailMessageSchema>;

export const smsMessageSchema = z.object({
  ...messageBase, channel: z.literal("sms"), to: phoneNumberSchema,
  text: z.string().min(1).max(MAX_SMS_CHARACTERS).regex(/^[A-Za-z0-9 .:()_-]+$/),
}).strict();
export type SmsMessage = z.infer<typeof smsMessageSchema>;
export const communicationMessageSchema = z.discriminatedUnion("channel", [emailMessageSchema, smsMessageSchema]);
export type CommunicationMessage = z.infer<typeof communicationMessageSchema>;

export const reportRecipientsSchema = z.object({
  email: z.array(emailAddressSchema).max(20),
  sms: z.array(phoneNumberSchema).max(20),
}).strict().refine(value => new Set(value.email).size === value.email.length && new Set(value.sms).size === value.sms.length);
export type ReportRecipients = z.infer<typeof reportRecipientsSchema>;

export const providerReceiptSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  providerMessageId: z.string().min(1).max(256),
  acceptedAt: reviewTimestamp,
  status: z.literal("accepted"),
}).strict();
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export interface ChannelSendOptions { readonly signal: AbortSignal }
export interface CommunicationChannel<Message extends EmailMessage | SmsMessage> {
  send(message: Readonly<Message>, options: ChannelSendOptions): Promise<ProviderReceipt>;
}
export type EmailChannel = CommunicationChannel<EmailMessage>;
export type SmsChannel = CommunicationChannel<SmsMessage>;
export interface CommunicationChannels { email?: EmailChannel; sms?: SmsChannel }

export interface CommunicationReceipt extends ProviderReceipt {
  channel: CommunicationChannelName;
  reportId: string;
  idempotencyKey: string;
  to: string;
  durationMs: number;
}

export interface ReportCommunication {
  sendEmail(report: StoredAgentReport, recipient: string): Promise<CommunicationReceipt>;
  sendSms(report: StoredAgentReport, recipient: string): Promise<CommunicationReceipt>;
}

const failures = {
  CONFIGURATION: { outcome: "not-sent", message: "Invalid communication configuration. Check channel adapters and the request timeout." },
  CHANNEL_NOT_CONFIGURED: { outcome: "not-sent", message: "The requested communication channel is not configured. Supply its provider adapter first." },
  INVALID_REPORT: { outcome: "not-sent", message: "Communication requires a valid saved AI report. No message was sent." },
  INVALID_REPORT_FORMAT: { outcome: "not-sent", message: "The saved AI response is not readable report text or a matching legacy email report. Update the Azure agent with SamplePrompt.txt and generate a new report. No email was sent; the original response remains saved." },
  STUDENT_NAMES_MISSING: { outcome: "not-sent", message: "The saved AI report does not contain student names. Generate a new named report before emailing it." },
  INVALID_RECIPIENT: { outcome: "not-sent", message: "Provide one valid email address or an international E.164 phone number for the selected channel. No message was sent." },
  INVALID_MESSAGE: { outcome: "not-sent", message: "The prepared communication message is invalid or oversized. No content was silently truncated and no message was sent." },
  PROVIDER_REJECTED: { outcome: "not-sent", message: "The provider rejected the message before accepting it. Check the configured provider and recipient." },
  PROVIDER_AUTHENTICATION: { outcome: "not-sent", message: "The provider rejected the credentials or their permissions. Check the email API key or SMS account credentials and required permissions." },
  PROVIDER_ACCOUNT_PENDING: { outcome: "not-sent", message: "The provider account is awaiting validation or activation. Complete provider approval before retrying." },
  PROVIDER_CREDITS: { outcome: "not-sent", message: "The provider has insufficient sending credits. Add the required credits before retrying." },
  PROVIDER_SENDER: { outcome: "not-sent", message: "The provider rejected the sender configuration. Verify the sending email/domain or SMS number/messaging service." },
  PROVIDER_REGISTRATION: { outcome: "not-sent", message: "SMS sender or destination-country registration is not approved. Complete the provider registration process before retrying." },
  PROVIDER_RATE_LIMITED: { outcome: "not-sent", message: "The provider rate limit was reached. No automatic retry was attempted." },
  PROVIDER_FAILED: { outcome: "unknown", message: "The communication provider failed. Delivery may be uncertain; no automatic retry was attempted. Private error details were withheld." },
  INVALID_RECEIPT: { outcome: "unknown", message: "The provider returned an invalid acceptance receipt. Delivery may be uncertain; do not retry automatically without checking." },
  TIMEOUT: { outcome: "unknown", message: "The communication request timed out. Delivery may still occur; no automatic retry was attempted." },
} as const;
export type CommunicationErrorCode = keyof typeof failures;

export class CommunicationError extends Error {
  readonly outcome: "not-sent" | "unknown";
  constructor(readonly code: CommunicationErrorCode) {
    super(failures[code].message);
    this.name = "CommunicationError";
    this.outcome = failures[code].outcome;
  }
}

export function readReportRecipients(
  environment: NodeJS.ProcessEnv = process.env, selected: CommunicationChannelName | "all" = "all",
): ReportRecipients {
  const list = (value: string | undefined): string[] => {
    if (value === undefined || !value.trim()) return [];
    if (Buffer.byteLength(value, "utf8") > 8192) throw new CommunicationError("CONFIGURATION");
    const parts = value.split(",").map(part => part.trim());
    if (parts.some(part => !part)) throw new CommunicationError("CONFIGURATION");
    return parts;
  };
  const parsed = reportRecipientsSchema.safeParse({
    email: selected === "sms" ? [] : list(environment.REPORT_EMAIL_RECIPIENTS),
    sms: selected === "email" ? [] : list(environment.REPORT_SMS_RECIPIENTS),
  });
  if (!parsed.success) throw new CommunicationError("CONFIGURATION");
  return parsed.data;
}

function preparationFailure(code: CommunicationErrorCode, channel: CommunicationChannelName): never {
  reportDiagnostic({ level: "error", code: "SCHEMA_INVALID", stage: "COMMUNICATION_PREPARE",
    channel, errorType: "validation", status: "failed" });
  throw new CommunicationError(code);
}

function inputReport(input: unknown, channel: CommunicationChannelName): StoredAgentReport {
  const report = storedAgentReportSchema.safeParse(input);
  if (!report.success) return preparationFailure("INVALID_REPORT", channel);
  return report.data;
}

function deliveryKey(reportId: string, channel: CommunicationChannelName, recipient: string): string {
  return `delivery_${createHash("sha256").update(JSON.stringify(["report-delivery-v1", reportId, channel, recipient])).digest("hex")}`;
}

function structuredOutput(text: string): boolean {
  return /^\s*(?:[{["]|```|~~~)/.test(text) || /[{[]\s*"[^"]+"\s*:/.test(text);
}

function emailReportText(report: StoredAgentReport): string {
  if (!structuredOutput(report.text)) return report.text;
  const text = report.text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : text); }
  catch { return preparationFailure("INVALID_REPORT_FORMAT", "email"); }
  // Older Azure prompts returned an envelope. Never mail its evidence or transport metadata.
  const prose = z.string().min(1).refine(value => value.trim().length > 0 && !structuredOutput(value));
  const legacy = z.object({
    status: z.literal("ok"), snapshotId: z.literal(report.snapshotId),
    reports: z.array(z.object({
      studentId: z.string(), studentLabel: z.string(),
      email: z.object({ bodyText: prose }),
      limitations: z.array(prose).optional(),
    })).min(1).max(2000),
    errors: z.array(z.unknown()).length(0),
  }).safeParse(value);
  if (!legacy.success || !report.students || legacy.data.reports.length !== report.students.length ||
      new Set(legacy.data.reports.map(entry => entry.studentId)).size !== report.students.length) {
    return preparationFailure("INVALID_REPORT_FORMAT", "email");
  }
  const students = report.students;
  const entries = new Map(legacy.data.reports.map(entry => [entry.studentId, entry]));
  return students.map(student => {
    const entry = entries.get(student.ref);
    if (!entry || entry.studentLabel !== student.name) return preparationFailure("INVALID_REPORT_FORMAT", "email");
    return [
      ...(students.length > 1 ? [`Student: ${student.name}`] : []),
      ...(entry.limitations?.length ? [`Source notes: ${entry.limitations.join(" ")}`] : []),
      entry.email.bodyText,
    ].join("\n\n");
  }).join("\n\n");
}

export function prepareEmailReport(input: unknown, recipient: string): EmailMessage {
  const report = inputReport(input, "email");
  const address = emailAddressSchema.safeParse(recipient);
  if (!address.success) return preparationFailure("INVALID_RECIPIENT", "email");
  if (!report.students || report.students.length !== report.studentRefs.length) {
    return preparationFailure("STUDENT_NAMES_MISSING", "email");
  }
  const names = report.students.map(student => student.name);
  const limited = report.sourceStatus === "incomplete-source-coverage" || report.sourceNotices.length > 0;
  const lines = [
    "SchoolHawkAI - school update",
    `${names.length === 1 ? "Student" : "Students"}: ${names.join(", ")}`,
    "AI-generated summary: recommendations have not been independently verified.",
    limited ? "Coverage note: Some school information is incomplete, stale, or uncertain. Additional missing work or new messages may not have been captured." :
      "Coverage note: This summary covers the available school records, not necessarily all school activity.",
    "",
    emailReportText(report),
  ];
  const message = emailMessageSchema.safeParse({
    channel: "email", reportId: report.reportId, to: address.data,
    idempotencyKey: deliveryKey(report.reportId, "email", address.data),
    subject: names.length === 1 ? `SchoolHawkAI: ${names[0]} - AI student report` : "SchoolHawkAI: AI student report",
    text: lines.join("\n"),
  });
  if (!message.success) return preparationFailure("INVALID_MESSAGE", "email");
  return message.data;
}

export function prepareSmsReport(input: unknown, recipient: string): SmsMessage {
  const report = inputReport(input, "sms");
  const number = phoneNumberSchema.safeParse(recipient);
  if (!number.success) return preparationFailure("INVALID_RECIPIENT", "sms");
  const limited = report.sourceStatus === "incomplete-source-coverage" || report.sourceNotices.length > 0;
  const count = report.studentRefs.length;
  const text = `SchoolHawkAI: AI report ready (${count} student${count === 1 ? "" : "s"}). ` +
    (limited ? "Source limits apply. " : "") + `Ref: ${report.reportId}`;
  const message = smsMessageSchema.safeParse({
    channel: "sms", reportId: report.reportId, to: number.data,
    idempotencyKey: deliveryKey(report.reportId, "sms", number.data), text,
  });
  if (!message.success) return preparationFailure("INVALID_MESSAGE", "sms");
  return message.data;
}

const noChangeNoticeSchema = z.object({
  reportId: agentReportIdSchema, checkedAt: reviewTimestamp,
  limited: z.boolean(), previousDeliveryIncomplete: z.boolean(),
}).strict();
export type NoChangeNotice = z.infer<typeof noChangeNoticeSchema>;

export function prepareNoChangeNotice(input: NoChangeNotice, channel: CommunicationChannelName, recipient: string): CommunicationMessage {
  const parsed = noChangeNoticeSchema.safeParse(input);
  if (!parsed.success) return preparationFailure("INVALID_MESSAGE", channel);
  const notice = parsed.data;
  const to = (channel === "email" ? emailAddressSchema : phoneNumberSchema).safeParse(recipient);
  if (!to.success) return preparationFailure("INVALID_RECIPIENT", channel);
  const text = channel === "sms"
    ? "SchoolHawkAI: No new data captured. AI report skipped. Existing concerns still apply." +
      (notice.limited ? " Coverage is limited." : "") +
      (notice.previousDeliveryIncomplete ? " Prior report delivery needs checking." : "")
    : "No new or changed data was found in the available school-portal report input for any student. " +
      "AI reporting was skipped to save tokens. Previously reported missing work and other concerns may still need attention." +
      (notice.limited ? "\n\nCoverage is incomplete, stale, or limited to selected records. Additional portal changes may not have been captured." :
        "\n\nThis comparison covers available records from the configured portals, not a guarantee that all school activity was captured.") +
      (notice.previousDeliveryIncomplete ? "\n\nPrevious AI report delivery is unconfirmed or incomplete. Inspect the saved reports before retrying delivery." : "");
  const message = communicationMessageSchema.safeParse({
    channel, to: to.data, reportId: notice.reportId, text,
    idempotencyKey: deliveryKey(JSON.stringify(["no-change-v1", notice.reportId, notice.checkedAt]), channel, to.data),
    ...(channel === "email" ? { subject: notice.limited ? "SchoolHawkAI: No new data captured - coverage limited" :
      "SchoolHawkAI: No new school data" } : {}),
  });
  if (!message.success) return preparationFailure("INVALID_MESSAGE", channel);
  return message.data;
}

export class ReportCommunicator implements ReportCommunication {
  readonly #email: EmailChannel | undefined;
  readonly #sms: SmsChannel | undefined;
  readonly #timeoutMs: number;

  constructor(channels: CommunicationChannels, timeoutMs = 30000) {
    if (!channels || typeof channels !== "object" ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        channels.email !== undefined && (!channels.email || typeof channels.email.send !== "function") ||
        channels.sms !== undefined && (!channels.sms || typeof channels.sms.send !== "function")) {
      throw new CommunicationError("CONFIGURATION");
    }
    this.#email = channels.email;
    this.#sms = channels.sms;
    this.#timeoutMs = timeoutMs;
  }

  async sendEmail(report: StoredAgentReport, recipient: string): Promise<CommunicationReceipt> {
    return this.#send(prepareEmailReport(report, recipient), this.#email);
  }

  async sendSms(report: StoredAgentReport, recipient: string): Promise<CommunicationReceipt> {
    return this.#send(prepareSmsReport(report, recipient), this.#sms);
  }

  async sendPrepared(input: CommunicationMessage): Promise<CommunicationReceipt> {
    const parsed = communicationMessageSchema.safeParse(input);
    if (!parsed.success) throw new CommunicationError("INVALID_MESSAGE");
    return parsed.data.channel === "email" ? this.#send(parsed.data, this.#email) : this.#send(parsed.data, this.#sms);
  }

  async #send<Message extends EmailMessage | SmsMessage>(
    input: Message, channel: CommunicationChannel<Message> | undefined,
  ): Promise<CommunicationReceipt> {
    const message = Object.freeze(input);
    if (!channel) {
      reportDiagnostic({ level: "error", code: "REQUEST_FAILED", stage: "COMMUNICATION_PREPARE",
        channel: message.channel, status: "failed" });
      throw new CommunicationError("CHANNEL_NOT_CONFIGURED");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CommunicationError("TIMEOUT"));
        controller.abort();
      }, this.#timeoutMs);
    });
    const started = Date.now();
    try {
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "COMMUNICATION_SEND", channel: message.channel });
      const response = await Promise.race([channel.send(message, { signal: controller.signal }), deadline]);
      const accepted = providerReceiptSchema.safeParse(response);
      if (!accepted.success) throw new CommunicationError("INVALID_RECEIPT");
      const durationMs = Math.max(0, Date.now() - started);
      const result: CommunicationReceipt = {
        ...accepted.data, channel: message.channel, reportId: message.reportId,
        idempotencyKey: message.idempotencyKey, to: message.to, durationMs,
      };
      reportDiagnostic({ level: "info", code: "COMMUNICATION_ACCEPTED", stage: "COMMUNICATION_SEND",
        channel: message.channel, status: "success", durationMs, counts: { accepted: 1 } });
      return result;
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      const failure = error instanceof CommunicationError ? error : new CommunicationError("PROVIDER_FAILED");
      reportDiagnostic({ level: "error", code: "REQUEST_FAILED", stage: "COMMUNICATION_SEND",
        channel: message.channel, status: "failed", durationMs: Math.max(0, Date.now() - started),
        errorType: failure.code === "TIMEOUT" ? "timeout" : "other" });
      throw failure;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
