import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CommunicationError, emailAddressSchema, emailMessageSchema, providerReceiptSchema,
  type ChannelSendOptions, type CommunicationErrorCode, type EmailChannel, type EmailMessage, type ProviderReceipt,
} from "./index";
import { readProviderResponse } from "./http";

const API_ROOT = "https://api.brevo.com/v3";
const keySchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const senderNameSchema = z.string().trim().min(1).max(128).regex(/^[^\r\n\0]+$/);
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
  else if (/sender|domain|dkim|dmarc|dns/i.test(message)) failure = "PROVIDER_SENDER";
  return new BrevoApiError(failure, status, code);
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

  async post(body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.#fetch(`${API_ROOT}/smtp/email`, {
        method: "POST", redirect: "error", signal,
        headers: { accept: "application/json", "content-type": "application/json", "api-key": this.#key },
        body: JSON.stringify(body),
      });
      let data: unknown;
      try { data = await readProviderResponse(response); }
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
    const result = await this.#client.post({
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

export function createBrevoEmailChannelFromEnv(environment: NodeJS.ProcessEnv = process.env): BrevoEmailChannel {
  const primary = environment.BREVO_KEY;
  const alias = environment.BREVIO_KEY;
  if (primary !== undefined && alias !== undefined && primary !== alias) throw new CommunicationError("CONFIGURATION");
  const apiKey = primary ?? alias ?? "";
  return new BrevoEmailChannel({
    apiKey, senderEmail: environment.BREVO_SENDER_EMAIL ?? "", senderName: environment.BREVO_SENDER_NAME,
  });
}
