import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CommunicationError, emailAddressSchema, emailMessageSchema, providerReceiptSchema,
  reportRecipientsSchema, smsMessageSchema,
  type ChannelSendOptions, type CommunicationChannelName, type CommunicationChannels,
  type CommunicationErrorCode, type EmailChannel, type EmailMessage, type ProviderReceipt, type ReportRecipients,
  type SmsChannel, type SmsMessage,
} from "./index";

const API_ROOT = "https://api.brevo.com/v3";
const MAX_RESPONSE_BYTES = 65536;
const keySchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const senderNameSchema = z.string().trim().min(1).max(128).regex(/^[^\r\n\0]+$/);
const smsSenderSchema = z.string().trim().transform(value => /^\+\d+$/.test(value) ? value.slice(1) : value)
  .pipe(z.string().regex(/^(?:[A-Za-z0-9]{3,11}|\d{12,15})$/));
const providerErrorSchema = z.object({
  code: z.enum(["invalid_parameter", "missing_parameter", "out_of_range", "not_enough_credits", "permission_denied",
    "unauthorized", "account_under_validation", "duplicate_parameter", "duplicate_request",
    "method_not_allowed", "not_acceptable", "bad_request", "unprocessable_entity"]).optional(),
  message: z.string().optional(),
});
type ProviderErrorCode = z.infer<typeof providerErrorSchema>["code"];

export class BrevoApiError extends CommunicationError {
  constructor(code: CommunicationErrorCode, readonly httpStatus: number, readonly providerCode?: ProviderErrorCode) {
    super(code);
    this.name = "BrevoApiError";
    this.message += ` Brevo HTTP ${httpStatus}${providerCode ? ` (${providerCode})` : ""}.`;
  }
}

function apiFailure(status: number, body: unknown): BrevoApiError {
  const parsed = providerErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "";
  if (status < 400 || status >= 500) return new BrevoApiError("PROVIDER_FAILED", status, code);
  let failure: CommunicationErrorCode = status >= 500 ? "PROVIDER_FAILED" : "PROVIDER_REJECTED";
  if (status === 401 || status === 403 || code === "unauthorized" || code === "permission_denied") failure = "PROVIDER_AUTHENTICATION";
  else if (status === 402 || code === "not_enough_credits") failure = "PROVIDER_CREDITS";
  else if (status === 429) failure = "PROVIDER_RATE_LIMITED";
  else if (code === "account_under_validation") failure = "PROVIDER_ACCOUNT_PENDING";
  else if (code === "duplicate_parameter" || code === "duplicate_request") failure = "PROVIDER_FAILED";
  else if (status >= 400 && status < 500 && /registration|register|toll.free|country.{0,30}(?:blocked|unavailable|approved)/i.test(message)) {
    failure = "PROVIDER_REGISTRATION";
  } else if (status >= 400 && status < 500 && /sender|domain|dkim|dmarc|dns/i.test(message)) failure = "PROVIDER_SENDER";
  return new BrevoApiError(failure, status, code);
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new CommunicationError("INVALID_RECEIPT");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new CommunicationError("INVALID_RECEIPT");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new CommunicationError("INVALID_RECEIPT");
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CommunicationError("INVALID_RECEIPT"); }
}

class BrevoTransport {
  readonly #key: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor(key: string, transport: typeof globalThis.fetch) {
    const parsed = keySchema.safeParse(key);
    if (!parsed.success) throw new CommunicationError("CONFIGURATION");
    this.#key = parsed.data;
    this.#fetch = transport;
  }

  async post(resource: "/smtp/email" | "/transactionalSMS/sms", body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.#fetch(`${API_ROOT}${resource}`, {
        method: "POST", redirect: "error", signal,
        headers: { accept: "application/json", "content-type": "application/json", "api-key": this.#key },
        body: JSON.stringify(body),
      });
      let data: unknown;
      try { data = await readResponse(response); }
      catch (error) {
        if (!response.ok) throw apiFailure(response.status, undefined);
        throw error;
      }
      if (!response.ok) throw apiFailure(response.status, data);
      if (response.status !== 201) throw new CommunicationError("INVALID_RECEIPT");
      return data;
    } catch (error) {
      if (error instanceof CommunicationError) throw error;
      throw new CommunicationError(signal.aborted ? "TIMEOUT" : "PROVIDER_FAILED");
    }
  }
}

export interface BrevoEmailOptions { apiKey: string; senderEmail: string; senderName?: string }

function emailIdempotencyKey(value: string): string {
  // Brevo limits this header's length; preserve stable retry identity in UUID form.
  const bytes = createHash("sha256").update(`schoolhawk-brevo-email-v1:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class BrevoEmailChannel implements EmailChannel {
  readonly #client: BrevoTransport;
  readonly #sender: { email: string; name: string };
  constructor(options: BrevoEmailOptions, transport = globalThis.fetch) {
    const email = emailAddressSchema.safeParse(options.senderEmail);
    const name = senderNameSchema.safeParse(options.senderName ?? "SchoolHawkAI");
    if (!email.success || !name.success) throw new CommunicationError("CONFIGURATION");
    this.#sender = { email: email.data, name: name.data };
    this.#client = new BrevoTransport(options.apiKey, transport);
  }

  async send(input: Readonly<EmailMessage>, options: ChannelSendOptions): Promise<ProviderReceipt> {
    const parsed = emailMessageSchema.safeParse(input);
    if (!parsed.success) throw new CommunicationError("INVALID_MESSAGE");
    const message = parsed.data;
    const result = await this.#client.post("/smtp/email", {
      sender: this.#sender, to: [{ email: message.to }], subject: message.subject, textContent: message.text,
      headers: { idempotencyKey: emailIdempotencyKey(message.idempotencyKey) },
      tags: ["schoolhawk", message.idempotencyKey],
    }, options.signal);
    const messageId = z.string().min(1).max(256);
    const response = z.object({ messageId: messageId.optional(), messageIds: z.array(messageId).length(1).optional() }).safeParse(result);
    if (!response.success) throw new CommunicationError("INVALID_RECEIPT");
    const id = response.data.messageId ?? response.data.messageIds?.[0];
    if (!id || response.data.messageId && response.data.messageIds && response.data.messageId !== response.data.messageIds[0]) {
      throw new CommunicationError("INVALID_RECEIPT");
    }
    return providerReceiptSchema.parse({
      provider: "brevo-email", providerMessageId: id, acceptedAt: new Date().toISOString(), status: "accepted",
    });
  }
}

export interface BrevoSmsOptions { apiKey: string; sender: string }
export class BrevoSmsChannel implements SmsChannel {
  readonly #client: BrevoTransport;
  readonly #sender: string;
  constructor(options: BrevoSmsOptions, transport = globalThis.fetch) {
    const sender = smsSenderSchema.safeParse(options.sender);
    if (!sender.success) throw new CommunicationError("CONFIGURATION");
    this.#sender = sender.data;
    this.#client = new BrevoTransport(options.apiKey, transport);
  }

  async send(input: Readonly<SmsMessage>, options: ChannelSendOptions): Promise<ProviderReceipt> {
    const parsed = smsMessageSchema.safeParse(input);
    if (!parsed.success) throw new CommunicationError("INVALID_MESSAGE");
    const message = parsed.data;
    if (message.to.replace(/^\+/, "").length < 6) throw new CommunicationError("INVALID_RECIPIENT");
    const result = await this.#client.post("/transactionalSMS/sms", {
      sender: this.#sender, recipient: message.to, content: message.text,
      type: "transactional", unicodeEnabled: false, tag: message.idempotencyKey,
    }, options.signal);
    const response = z.object({ messageId: z.union([
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,30}$/),
    ]) }).safeParse(result);
    if (!response.success) throw new CommunicationError("INVALID_RECEIPT");
    return providerReceiptSchema.parse({
      provider: "brevo-sms", providerMessageId: String(response.data.messageId), acceptedAt: new Date().toISOString(), status: "accepted",
    });
  }
}

export function createBrevoChannelsFromEnv(
  environment: NodeJS.ProcessEnv = process.env, selected: readonly CommunicationChannelName[] = ["email", "sms"],
): CommunicationChannels {
  const primary = environment.BREVO_KEY;
  const alias = environment.BREVIO_KEY;
  if (primary !== undefined && alias !== undefined && primary !== alias) throw new CommunicationError("CONFIGURATION");
  const apiKey = primary ?? alias ?? "";
  const channels: CommunicationChannels = {};
  if (selected.includes("email")) channels.email = new BrevoEmailChannel({
    apiKey, senderEmail: environment.BREVO_SENDER_EMAIL ?? "", senderName: environment.BREVO_SENDER_NAME,
  });
  if (selected.includes("sms")) channels.sms = new BrevoSmsChannel({ apiKey, sender: environment.BREVO_SMS_SENDER ?? "" });
  return channels;
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
