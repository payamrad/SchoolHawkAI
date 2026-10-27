import { storedAgentReportSchema, type StoredAgentReport } from "@schoolhawk/core/agent-reports";
import { studentReportFixture } from "../../agent/tests/fixtures";

export const brevoEnvironment = {
  BREVO_KEY: "PRIVATE_BREVO_KEY",
  BREVO_SENDER_EMAIL: "sender@example.test",
  BREVO_SENDER_NAME: "SchoolHawkAI",
  REPORT_EMAIL_RECIPIENTS: "parent@example.test",
  REPORT_SMS_RECIPIENTS: "+12025550123",
};

export const twilioEnvironment = {
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "PRIVATE_TWILIO_TOKEN",
  TWILIO_FROM_NUMBER: "+12025550100",
};

export function twilioReceipt(overrides: Record<string, unknown> = {}) {
  return {
    sid: `SM${"b".repeat(32)}`, account_sid: twilioEnvironment.TWILIO_ACCOUNT_SID,
    to: "+12025550123", status: "queued", error_code: null, error_message: null, ...overrides,
  };
}

export function transportFixture(payload: unknown, status = 201) {
  const calls: { url: string; options: RequestInit }[] = [];
  const transport: typeof fetch = async (url, options) => {
    if (!options) throw new Error("Missing synthetic request options.");
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, transport };
}

export function savedReport(overrides: Partial<StoredAgentReport> = {}): StoredAgentReport {
  const source = studentReportFixture();
  return storedAgentReportSchema.parse({
    provider: "azure-foundry", responseId: "resp_fixture", receivedAt: source.generatedAt,
    durationMs: 123, text: "PRIVATE_AI_REPORT_TEXT",
    kind: "student-report-analysis", snapshotId: source.id, reviewId: source.reviewId,
    studentRefs: source.students.map(student => student.id),
    students: source.students.map(student => ({ ref: student.id, name: student.label })),
    sourceStatus: "incomplete-source-coverage", sourceNotices: ["collection-incomplete"],
    validation: "unverified-ai-analysis", version: 1, reportId: `report_${"a".repeat(64)}`,
    savedAt: source.generatedAt, ...overrides,
  });
}
