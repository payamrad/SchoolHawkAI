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

export const studentReportAnalysisSchema = agentReplySchema.extend({
  kind: z.literal("student-report-analysis"),
  snapshotId: reviewIdSchema,
  reviewId: reviewIdSchema,
  studentRefs: z.array(reviewIdSchema).max(2000).refine(values => new Set(values).size === values.length),
  sourceStatus: studentSnapshotSchema.shape.status,
  sourceNotices: studentSnapshotSchema.shape.notices,
  validation: z.literal("unverified-ai-analysis"),
});
export type StudentReportAnalysis = z.infer<typeof studentReportAnalysisSchema>;

export const storedAgentReportSchema = studentReportAnalysisSchema.extend({
  version: z.literal(1),
  reportId: agentReportIdSchema,
  savedAt: reviewTimestamp,
});
export type StoredAgentReport = z.infer<typeof storedAgentReportSchema>;

export const agentReportSummarySchema = storedAgentReportSchema.pick({
  reportId: true, provider: true, receivedAt: true, savedAt: true,
}).extend({ studentCount: count.max(2000) });
export type AgentReportSummary = z.infer<typeof agentReportSummarySchema>;
