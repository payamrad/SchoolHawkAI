import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CommunicationError, ReportCommunicator, communicationMessageSchema, prepareNoChangeNotice,
  type CommunicationChannelName, type CommunicationReceipt, type NoChangeNotice, type ReportRecipients,
} from "@schoolhawk/communication";
import { createBrevoChannelsFromEnv, readReportRecipients } from "@schoolhawk/communication/brevo";
import { agentReportIdSchema, type StoredAgentReport } from "@schoolhawk/core/agent-reports";
import { withReviewStore } from "@schoolhawk/storage/review-sqlite";
import { DiagnosticLogError } from "@schoolhawk/core/diagnostics";

const HELP = `Brevo report delivery (explicit external email/SMS transmission)

  Communicate recipients [--channel email|sms|all]
  Communicate send --report <saved-report-id> [--channel email|sms|all]
  Communicate test --channel email|sms --to <one-recipient>
  Communicate --help

BREVO_KEY is the API key; BREVIO_KEY is accepted as a compatibility alias.
Email needs BREVO_SENDER_EMAIL and optional BREVO_SENDER_NAME.
SMS needs BREVO_SMS_SENDER, approved by Brevo for the destination country.
REPORT_EMAIL_RECIPIENTS and REPORT_SMS_RECIPIENTS are comma-separated private lists.
SMS recipients must use E.164 format, for example +12025550123.

send reads an already saved AI report; it does not call Azure or recollect data.
Email sends the full plain-text AI report. SMS sends a short notice and local reference.
test sends one harmless test message to the explicit recipient, not the whole list.
No real student data or database is needed for test.
Provider acceptance is not confirmed delivery. Failures/uncertain outcomes are explicit.
There are no automatic retries; Brevo email idempotency lasts only 15 minutes.
SMS tags are for tracking, not a promise of deduplication.
`;

export class CommunicationUsageError extends Error {}

export interface ReportDeliveryPlan {
  communicator: ReportCommunicator;
  recipients: ReportRecipients;
}
export interface ReportDeliveryResult {
  reportId: string;
  status: "accepted" | "partial" | "failed";
  accepted: CommunicationReceipt[];
  failed: { channel: CommunicationChannelName; to: string; code: string; outcome: "not-sent" | "unknown" }[];
}

export class ReportDeliveryError extends Error {
  constructor(result: ReportDeliveryResult) {
    super(`Report ${result.reportId} remains saved locally. ${result.accepted.length} message(s) were accepted; ` +
      `${result.failed.length} failed or have uncertain outcomes. Inspect the delivery result before retrying; do not regenerate the AI report just to retry delivery.`);
  }
}

export function prepareReportDelivery(
  environment: NodeJS.ProcessEnv = process.env, selected: CommunicationChannelName | "all" = "all",
): ReportDeliveryPlan {
  const recipients = readReportRecipients(environment, selected);
  const channels: CommunicationChannelName[] = [];
  if (recipients.email.length) channels.push("email");
  if (recipients.sms.length) channels.push("sms");
  if (!channels.length) throw new CommunicationUsageError("No recipients are configured for the selected channels. Set the private REPORT_EMAIL_RECIPIENTS and/or REPORT_SMS_RECIPIENTS lists.");
  return { recipients, communicator: new ReportCommunicator(createBrevoChannelsFromEnv(environment, channels)) };
}

export async function deliverReport(report: StoredAgentReport, plan: ReportDeliveryPlan): Promise<ReportDeliveryResult> {
  return deliverToRecipients(report.reportId, plan, (channel, to) => channel === "email"
    ? plan.communicator.sendEmail(report, to) : plan.communicator.sendSms(report, to));
}

export async function deliverNoChangeNotice(notice: NoChangeNotice, plan: ReportDeliveryPlan): Promise<ReportDeliveryResult> {
  return deliverToRecipients(notice.reportId, plan, (channel, to) =>
    plan.communicator.sendPrepared(prepareNoChangeNotice(notice, channel, to)));
}

async function deliverToRecipients(reportId: string, plan: ReportDeliveryPlan,
  send: (channel: CommunicationChannelName, to: string) => Promise<CommunicationReceipt>): Promise<ReportDeliveryResult> {
  const targets = [
    ...plan.recipients.email.map(to => ({ channel: "email" as const, to })),
    ...plan.recipients.sms.map(to => ({ channel: "sms" as const, to })),
  ];
  const outcomes = await Promise.allSettled(targets.map(async target => send(target.channel, target.to)));
  const accepted: CommunicationReceipt[] = [];
  const failed: ReportDeliveryResult["failed"] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") accepted.push(outcome.value);
    else {
      if (outcome.reason instanceof DiagnosticLogError) throw outcome.reason;
      const error = outcome.reason instanceof CommunicationError ? outcome.reason : new CommunicationError("PROVIDER_FAILED");
      failed.push({ ...targets[index], code: error.code, outcome: error.outcome });
    }
  }
  return { reportId, status: failed.length ? accepted.length ? "partial" : "failed" : "accepted", accepted, failed };
}

export function parseCommunicationArgs(args: string[]):
  { command: "help" } |
  { command: "recipients"; channel: CommunicationChannelName | "all" } |
  { command: "send"; reportId: string; channel: CommunicationChannelName | "all" } |
  { command: "test"; channel: CommunicationChannelName; to: string } {
  if (args.length === 1 && args[0] === "--help") return { command: "help" };
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      report: { type: "string" }, channel: { type: "string" }, to: { type: "string" },
    } });
    const command = positionals[0];
    const allowed: Record<string, string[]> = { recipients: ["channel"], send: ["report", "channel"], test: ["channel", "to"] };
    if (positionals.length !== 1 || !Object.hasOwn(allowed, command)) throw new Error();
    for (const key of Object.keys(values)) if (!allowed[command].includes(key) ||
      args.filter(arg => arg === `--${key}` || arg.startsWith(`--${key}=`)).length !== 1) throw new Error();
    const channel = values.channel ?? "all";
    if (channel !== "email" && channel !== "sms" && channel !== "all") throw new Error();
    if (command === "recipients") return { command, channel };
    if (command === "send") return { command, channel, reportId: agentReportIdSchema.parse(values.report) };
    if (channel === "all" || !values.to) throw new Error();
    return { command: "test", channel, to: values.to };
  } catch { throw new CommunicationUsageError("Invalid Communicate arguments. Use npm run cli -- Communicate --help. No messages were sent."); }
}

export async function runCommunicationCli(args: string[], root: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const input = parseCommunicationArgs(args);
  if (input.command === "help") { console.log(HELP); return; }
  if (input.command === "recipients") {
    console.log(JSON.stringify(readReportRecipients(environment, input.channel), null, 2));
    return;
  }
  if (input.command === "test") {
    const communicator = new ReportCommunicator(createBrevoChannelsFromEnv(environment, [input.channel]));
    const parsed = communicationMessageSchema.safeParse({
      channel: input.channel, to: input.to, reportId: `report_${randomBytes(32).toString("hex")}`,
      idempotencyKey: `delivery_${randomBytes(32).toString("hex")}`,
      ...(input.channel === "email" ? { subject: "SchoolHawkAI test email",
        text: "This is your requested SchoolHawkAI transactional email test through Brevo. No student records are included." }
        : { text: "SchoolHawkAI: This is your requested Brevo SMS test. No student records are included." }),
    });
    if (!parsed.success) throw new CommunicationUsageError("Use one valid email address or an E.164 phone number for the selected test channel. No test message was sent.");
    console.error(`COMMUNICATION: Sending one requested test ${input.channel}; no student data is included.`);
    console.log(JSON.stringify(await communicator.sendPrepared(parsed.data), null, 2));
    return;
  }
  const plan = prepareReportDelivery(environment, input.channel);
  const report = await withReviewStore(root, store => store.getAgentReport(input.reportId));
  if (!report) throw new CommunicationUsageError("No saved AI report matches this ID. Use Agent reports to select a report.");
  console.error("COMMUNICATION: Sending the saved AI report to the configured private recipient lists.");
  const result = await deliverReport(report, plan);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "accepted") throw new ReportDeliveryError(result);
}
