import { storedAgentReportSchema, type StoredAgentReport } from "@schoolhawk/core/agent-reports";
import { studentReportFixture } from "../../agent/tests/fixtures";

export const brevoEnvironment = {
  BREVO_KEY: "PRIVATE_BREVO_KEY",
  BREVO_SENDER_EMAIL: "sender@example.test",
  BREVO_SENDER_NAME: "SchoolHawkAI",
  BREVO_SMS_SENDER: "SchoolHawk",
  REPORT_EMAIL_RECIPIENTS: "parent@example.test",
  REPORT_SMS_RECIPIENTS: "+12025550123",
};

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
