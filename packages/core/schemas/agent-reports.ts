import { z } from "zod";
import { reviewIdSchema, reviewTimestamp } from "../review";
import { studentSnapshotSchema } from "./student-snapshot";

export const MAX_AGENT_RESPONSE_BYTES = 1024 * 1024;
export const agentReportIdSchema = z.string().regex(/^report_[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const agentReplySchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  responseId: z.string().min(1).max(256),
  receivedAt: reviewTimestamp,
  durationMs: count,
  text: z.string().min(1).max(MAX_AGENT_RESPONSE_BYTES).refine(value =>
    value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= MAX_AGENT_RESPONSE_BYTES),
  usage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count }).strict().optional(),
}).strict();
export type AgentReply = z.infer<typeof agentReplySchema>;

export const agentConnectionTestSchema = agentReplySchema.extend({
  kind: z.literal("connection-test"), connected: z.literal(true),
});
export type AgentConnectionTest = z.infer<typeof agentConnectionTestSchema>;

export const reportStudentSchema = z.object({
  ref: reviewIdSchema,
  name: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/)
    .refine(value => !/^(?:student|child)[\s_-]*\d+$/i.test(value) && !/^unmapped\b/i.test(value)),
}).strict();

const analysisSchema = agentReplySchema.extend({
  kind: z.literal("student-report-analysis"),
  snapshotId: reviewIdSchema,
  reviewId: reviewIdSchema,
  studentRefs: z.array(reviewIdSchema).max(2000).refine(values => new Set(values).size === values.length),
  sourceStatus: studentSnapshotSchema.shape.status,
  sourceNotices: studentSnapshotSchema.shape.notices,
  validation: z.literal("unverified-ai-analysis"),
  students: z.array(reportStudentSchema).max(2000).optional(),
});
function validateStudents(value: z.infer<typeof analysisSchema>, context: z.RefinementCtx): void {
  if (value.students === undefined) return;
  const references = new Set(value.students.map(student => student.ref));
  if (references.size !== value.students.length || references.size !== value.studentRefs.length ||
      value.studentRefs.some(ref => !references.has(ref))) {
    context.addIssue({ code: "custom", message: "Student names do not match the analysis student references." });
  }
}
export const studentReportAnalysisSchema = analysisSchema.superRefine(validateStudents);
export type StudentReportAnalysis = z.infer<typeof studentReportAnalysisSchema>;

const storedSchema = analysisSchema.extend({
  version: z.literal(1),
  reportId: agentReportIdSchema,
  savedAt: reviewTimestamp,
});
export const storedAgentReportSchema = storedSchema.superRefine(validateStudents);
export type StoredAgentReport = z.infer<typeof storedAgentReportSchema>;

export const agentReportSummarySchema = storedSchema.pick({
  reportId: true, provider: true, receivedAt: true, savedAt: true,
}).extend({ studentCount: count.max(2000) });
export type AgentReportSummary = z.infer<typeof agentReportSummarySchema>;

export const reportInputHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const reportCheckpointSchema = z.object({
  version: z.literal(1), scopeHash: reportInputHashSchema, inputHash: reportInputHashSchema,
  reportIds: z.array(agentReportIdSchema).min(1).max(2000)
    .refine(values => new Set(values).size === values.length),
  savedAt: reviewTimestamp, deliveryIncomplete: z.boolean(),
}).strict();
export type ReportCheckpoint = z.infer<typeof reportCheckpointSchema>;
