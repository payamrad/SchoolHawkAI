import { z } from "zod";
import {
  CommunicationError, phoneNumberSchema, providerReceiptSchema, smsMessageSchema,
  type ChannelSendOptions, type CommunicationErrorCode, type ProviderReceipt, type SmsChannel, type SmsMessage,
} from "./index";
import { readProviderResponse } from "./http";

const accountSidSchema = z.string().regex(/^AC[0-9a-fA-F]{32}$/);
const serviceSidSchema = z.string().regex(/^MG[0-9a-fA-F]{32}$/);
const credentials = {
  accountSid: accountSidSchema,
  authToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
};
const optionsSchema = z.union([
  z.object({ ...credentials, fromNumber: phoneNumberSchema, messagingServiceSid: z.undefined().optional() }),
  z.object({ ...credentials, fromNumber: z.undefined().optional(), messagingServiceSid: serviceSidSchema }),
]);
const errorSchema = z.object({ code: z.number().int().min(10000).max(99999).optional() });

export interface TwilioSmsOptions {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
}

export class TwilioApiError extends CommunicationError {
  constructor(code: CommunicationErrorCode, readonly httpStatus: number, readonly providerCode?: number) {
    super(code);
    this.name = "TwilioApiError";
    this.message += ` Twilio HTTP ${httpStatus}${providerCode === undefined ? "" : ` (${providerCode})`}.`;
  }
}

function apiFailure(status: number, body: unknown): TwilioApiError {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  if (status < 400 || status >= 500) return new TwilioApiError("PROVIDER_FAILED", status, code);
  let failure: CommunicationErrorCode = "PROVIDER_REJECTED";
  if (status === 401 || status === 403 || code === 20003) failure = "PROVIDER_AUTHENTICATION";
  else if (status === 429 || code === 20429) failure = "PROVIDER_RATE_LIMITED";
  else if (code === 21606 || code === 21660) failure = "PROVIDER_SENDER";
  else if (code === 30032 || code === 30034) failure = "PROVIDER_REGISTRATION";
  return new TwilioApiError(failure, status, code);
}

export class TwilioSmsChannel implements SmsChannel {
  readonly #accountSid: string;
  readonly #authorization: string;
  readonly #sender: { From: string } | { MessagingServiceSid: string };
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: TwilioSmsOptions, transport = globalThis.fetch) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) throw new CommunicationError("CONFIGURATION");
    const settings = parsed.data;
    this.#accountSid = settings.accountSid;
    this.#authorization = `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`;
    this.#sender = settings.fromNumber !== undefined ? { From: settings.fromNumber } : { MessagingServiceSid: settings.messagingServiceSid };
    this.#fetch = transport;
  }

  async send(input: Readonly<SmsMessage>, options: ChannelSendOptions): Promise<ProviderReceipt> {
    const parsed = smsMessageSchema.safeParse(input);
    if (!parsed.success) throw new CommunicationError("INVALID_MESSAGE");
    const message = parsed.data;
    try {
      const response = await this.#fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.#accountSid}/Messages.json`, {
        method: "POST", redirect: "error", signal: options.signal,
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", authorization: this.#authorization },
        body: new URLSearchParams({ To: message.to, Body: message.text, ...this.#sender }).toString(),
      });
      let data: unknown;
      try { data = await readProviderResponse(response); }
      catch (error) {
        if (!response.ok) throw apiFailure(response.status, undefined);
        throw error;
      }
      if (!response.ok) throw apiFailure(response.status, data);
      if (response.status !== 201) throw new CommunicationError("INVALID_RECEIPT");
      const receipt = z.object({
        sid: z.string().regex(/^SM[0-9a-fA-F]{32}$/),
        account_sid: z.literal(this.#accountSid),
        to: z.literal(message.to),
        status: z.enum(["accepted", "queued", "sending", "sent", "delivered"]),
        error_code: z.null().optional(),
        error_message: z.null().optional(),
      }).safeParse(data);
      if (!receipt.success) throw new CommunicationError("INVALID_RECEIPT");
      return providerReceiptSchema.parse({
        provider: "twilio-sms", providerMessageId: receipt.data.sid,
        acceptedAt: new Date().toISOString(), status: "accepted",
      });
    } catch (error) {
      if (error instanceof CommunicationError) throw error;
      throw new CommunicationError(options.signal.aborted ? "TIMEOUT" : "PROVIDER_FAILED");
    }
  }
}

export function createTwilioSmsChannelFromEnv(environment: NodeJS.ProcessEnv = process.env): TwilioSmsChannel {
  return new TwilioSmsChannel({
    accountSid: environment.TWILIO_ACCOUNT_SID ?? "",
    authToken: environment.TWILIO_AUTH_TOKEN ?? "",
    fromNumber: environment.TWILIO_FROM_NUMBER || undefined,
    messagingServiceSid: environment.TWILIO_MESSAGING_SERVICE_SID || undefined,
  });
}
