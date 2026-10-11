import { z } from "zod";

export const REVIEW_VERSION = 1;
export const reviewTimestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const alias = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const identity = z.string().min(1).max(300);
const text = z.string().max(1_000_000);
export const reviewPortalSchema = z.enum(["skyward", "canvas"]);
export const reviewSectionSchema = z.enum(["assignments", "grades", "messages", "attendance", "calendar", "announcements", "forms"]);
export const reviewStatusSchema = z.enum(["complete", "partial", "failed", "auth-required", "not-observed", "unsupported"]);
export const reviewIdSchema = z.string().regex(/^[a-z]+_[a-f0-9]{64}$/);
export const reviewTimeZoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Use a supported IANA timezone.");

const ruleValuesSchema = z.object({
  dueSoonHours: z.number().int().min(1).max(72),
  upcomingDays: z.number().int().min(1).max(30),
  staleAfterHours: z.number().int().min(1).max(168),
  failureThreshold: z.number().int().min(1).max(20),
  removalConfirmations: z.number().int().min(2).max(10),
  immediateDeadlineAlerts: z.boolean(),
  immediateOperationalAlerts: z.boolean(),
}).strict();
const defaultRules = {
  dueSoonHours: 24, upcomingDays: 7, staleAfterHours: 36, failureThreshold: 3, removalConfirmations: 2,
  immediateDeadlineAlerts: false, immediateOperationalAlerts: false,
};
export const priorityRulesSchema = ruleValuesSchema;
export const briefingOptionsSchema = z.object({
  recentHours: z.number().int().min(1).max(168).default(24),
  maxItems: z.number().int().min(1).max(100).default(40),
  maxBytes: z.number().int().min(4096).max(131072).default(32768),
}).strict();

const bindingSchema = z.object({
  portal: reviewPortalSchema, accountId: alias, studentId: identity,
}).strict();
export const reviewConfigSchema = z.object({
  version: z.literal(1),
  profileId: alias,
  timeZone: reviewTimeZoneSchema.default("America/Los_Angeles"),
  sources: z.array(z.object({
    portal: reviewPortalSchema, accountId: alias,
    sections: z.array(reviewSectionSchema).min(1).max(7),
  }).strict()).min(1).max(20),
  children: z.array(z.object({
    id: alias,
    bindings: z.array(bindingSchema).min(1).max(20),
    rules: ruleValuesSchema.partial().optional(),
  }).strict()).max(100).default([]),
  rules: ruleValuesSchema.partial().default({}).transform(value => ({ ...defaultRules, ...value })),
  briefing: briefingOptionsSchema.prefault({}),
}).strict().superRefine((config, context) => {
  const sources = config.sources.map(source => JSON.stringify([source.portal, source.accountId]));
  const bindings = config.children.flatMap(child => child.bindings.map(binding => JSON.stringify(binding)));
  if (new Set(sources).size !== sources.length ||
      config.sources.some(source => new Set(source.sections).size !== source.sections.length) ||
      new Set(config.children.map(child => child.id)).size !== config.children.length ||
      new Set(bindings).size !== bindings.length ||
      config.children.some(child => child.bindings.some(binding => !config.sources.some(source =>
        source.portal === binding.portal && source.accountId === binding.accountId)))) {
    context.addIssue({ code: "custom", message: "Duplicate or unconfigured review source/child binding." });
  }
});
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
export type PriorityRules = z.infer<typeof priorityRulesSchema>;
export type ReviewPortal = z.infer<typeof reviewPortalSchema>;
export type ReviewSection = z.infer<typeof reviewSectionSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type ReviewIdFactory = (kind: string, parts: unknown[]) => string;

export class ReviewError extends Error {}

export const reviewFieldsSchema = z.object({
  title: text,
  course: text.nullable(),
  dueDate: z.iso.date().nullable(),
  dueAt: reviewTimestamp.nullable(),
  missing: z.boolean().nullable(),
  grade: text.nullable(),
  score: text.nullable(),
  maxScore: text.nullable(),
  status: text.nullable(),
  term: text.nullable(),
  gradingScale: text.nullable(),
  sentDate: z.iso.date().nullable(),
  unread: z.boolean().nullable(),
  contentHash: z.string().nullable(),
}).strict();
export type ReviewFields = z.infer<typeof reviewFieldsSchema>;
export type ReviewField = keyof ReviewFields;
export const reviewFieldSchema = reviewFieldsSchema.keyof();
export const reviewEntitySchema = z.enum(["assignment", "grade", "message"]);
export type ReviewEntity = z.infer<typeof reviewEntitySchema>;
export const fieldChangeSchema = z.object({
  field: reviewFieldSchema,
  before: z.union([text, z.boolean(), z.null()]),
  after: z.union([text, z.boolean(), z.null()]),
}).strict();

export const evidenceSchema = z.object({
  id: reviewIdSchema,
  portal: reviewPortalSchema,
  accountId: alias,
  section: reviewSectionSchema,
  studentId: identity.nullable(),
  courseId: identity.nullable(),
  recordId: identity.nullable(),
  runId: z.uuid(),
  capturedAt: reviewTimestamp,
  parserVersion: z.number().int().positive(),
  url: z.url().nullable(),
}).strict();
export type ReviewEvidence = z.infer<typeof evidenceSchema>;
export interface ReviewRecord {
  id: string;
  entity: ReviewEntity;
  fields: ReviewFields;
  evidence: ReviewEvidence;
}
const knownMissingSchema = z.object({ value: z.boolean(), evidence: evidenceSchema }).strict().nullable();

export const coverageSchema = z.object({
  kind: z.enum(["full", "window", "unread", "discovery"]),
  startDate: z.iso.date().nullable(),
  endDate: z.iso.date().nullable(),
  marker: z.string().max(10000),
}).strict();
export type ReviewCoverage = z.infer<typeof coverageSchema>;
export interface ReviewScopeObservation {
  id: string;
  streamId: string;
  studentId: string | null;
  courseId: string | null;
  part: string;
  status: ReviewStatus;
  coverage: ReviewCoverage;
  records: ReviewRecord[];
  evidence: ReviewEvidence;
}
export interface ReviewObservation {
  streamId: string;
  runId: string;
  capturedAt: string;
  fingerprint: string;
  status: ReviewStatus;
  discoveryComplete: boolean;
  evidence: ReviewEvidence;
  scopes: ReviewScopeObservation[];
}

export const trackedRecordSchema = z.object({
  id: reviewIdSchema,
  entity: reviewEntitySchema,
  fields: reviewFieldsSchema,
  evidence: evidenceSchema,
  scopeIds: z.array(reviewIdSchema),
  coverageMarkers: z.record(z.string(), z.string()),
  lastKnownMissing: knownMissingSchema,
  firstSeenAt: reviewTimestamp,
  lastSeenAt: reviewTimestamp,
  active: z.boolean(),
  absences: z.number().int().nonnegative(),
}).strict();
export type TrackedReviewRecord = z.infer<typeof trackedRecordSchema>;
export const scopeStateSchema = z.object({
  id: reviewIdSchema,
  streamId: reviewIdSchema,
  studentId: identity.nullable(),
  courseId: identity.nullable(),
  part: z.string().max(100),
  status: reviewStatusSchema,
  evidence: evidenceSchema,
  lastCompleteAt: reviewTimestamp.nullable(),
  failureCount: z.number().int().nonnegative(),
  coverage: coverageSchema,
  baselineCoverage: coverageSchema.nullable(),
  recordIds: z.array(reviewIdSchema).max(100000),
}).strict();
export type ReviewScopeState = z.infer<typeof scopeStateSchema>;

export const changeEventSchema = z.object({
  id: reviewIdSchema,
  recordId: reviewIdSchema,
  entity: z.enum([...reviewEntitySchema.options, "collection"]),
  kind: z.enum(["first-observed", "newly-observed", "updated", "no-longer-observed", "reappeared"]),
  detectedAt: reviewTimestamp,
  observedAt: reviewTimestamp,
  fields: z.array(fieldChangeSchema).max(14),
  before: evidenceSchema.nullable(),
  after: evidenceSchema,
}).strict();
export type ReviewChange = z.infer<typeof changeEventSchema>;
export const reviewStateSchema = z.object({
  version: z.literal(1),
  identityHash: z.string(),
  initializedAt: reviewTimestamp,
  streams: z.array(z.object({
    id: reviewIdSchema, evidence: evidenceSchema, status: reviewStatusSchema,
    latestAt: reviewTimestamp, latestRunId: z.uuid(), lastCompleteAt: reviewTimestamp.nullable(),
    failureCount: z.number().int().nonnegative(),
  }).strict()).max(140),
  processed: z.record(z.string(), z.string()),
  scopes: z.array(scopeStateSchema).max(10000),
  records: z.array(trackedRecordSchema).max(100000),
}).strict();
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const healthIssueSchema = z.enum([
  "collection-incomplete", "collection-stale", "never-collected", "unsupported-section", "unmapped-student",
  "lookback-limited", "unread-only", "scope-not-observed", "record-not-observed",
  "source-conflict", "late-observations-ignored", "source-history-changed",
]);
export type HealthIssue = z.infer<typeof healthIssueSchema>;
export const healthSchema = z.object({
  id: reviewIdSchema, portal: reviewPortalSchema, section: reviewSectionSchema,
  childId: alias.nullable(), part: z.string().max(100), status: reviewStatusSchema,
  lastAttemptAt: reviewTimestamp.nullable(), lastCompleteAt: reviewTimestamp.nullable(),
  failureCount: z.number().int().nonnegative(), issues: z.array(healthIssueSchema),
  coverage: coverageSchema.nullable(), evidenceId: reviewIdSchema.nullable(),
}).strict();
export type ReviewHealth = z.infer<typeof healthSchema>;

export const priorityReasonSchema = z.enum([
  "missing-work", "missing-status-unverified", "due-soon", "due-today", "due-tomorrow", "upcoming", "overdue-status-unknown",
  "first-observed", "new-record", "record-changed", "grade-changed", "new-unread-message",
  "no-longer-observed", "reappeared", "collection-health", "collection-recovered", "source-conflict",
]);
export const actionCandidateSchema = z.object({
  id: reviewIdSchema, recordIds: z.array(reviewIdSchema).max(2),
  entity: z.enum(["assignment", "grade", "message", "collection"]),
  childId: alias.nullable(),
  title: text, course: text.nullable(),
  facts: reviewFieldsSchema.nullable(),
  relatedFacts: z.array(z.object({ sourceId: reviewIdSchema, fields: reviewFieldsSchema }).strict()).max(1),
  lastKnownMissing: knownMissingSchema,
  priority: z.enum(["high", "normal", "low"]),
  delivery: z.enum(["daily", "immediate-eligible"]),
  reasons: z.array(priorityReasonSchema).min(1),
  dueDate: z.iso.date().nullable(), dueAt: reviewTimestamp.nullable(),
  dueTimeZone: reviewTimeZoneSchema,
  changes: z.array(changeEventSchema).max(10000),
  evidenceIds: z.array(reviewIdSchema).max(20002),
  uncertainty: z.array(healthIssueSchema),
  extractionConfidence: z.enum(["verified-observation", "last-known"]),
  interpretation: z.literal("deterministic"),
}).strict();
export type ActionCandidate = z.infer<typeof actionCandidateSchema>;

export const reviewResultSchema = z.object({
  version: z.literal(1), engineVersion: z.literal(1), id: reviewIdSchema, profileId: alias,
  evaluatedAt: reviewTimestamp, recentSince: reviewTimestamp, timeZone: reviewTimeZoneSchema,
  rules: priorityRulesSchema,
  childRules: z.array(z.object({ childId: alias, rules: priorityRulesSchema }).strict()).max(100),
  briefingOptions: briefingOptionsSchema,
  bootstrap: z.boolean(),
  changes: z.array(changeEventSchema).max(100000),
  actions: z.array(actionCandidateSchema).max(100000),
  health: z.array(healthSchema).max(10000),
  evidence: z.array(evidenceSchema).max(300000),
  notices: z.array(healthIssueSchema),
}).strict();
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export function childFor(config: ReviewConfig, source: Pick<ReviewEvidence, "portal" | "accountId" | "studentId">): string | null {
  return config.children.find(child => child.bindings.some(binding =>
    binding.portal === source.portal && binding.accountId === source.accountId && binding.studentId === source.studentId))?.id ?? null;
}

export function rulesFor(config: ReviewConfig, childId: string | null): PriorityRules {
  return priorityRulesSchema.parse({ ...config.rules, ...config.children.find(child => child.id === childId)?.rules });
}

export function reviewDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}

export function semanticText(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, " ").trim();
}

export function supportedReviewSection(portal: ReviewPortal, section: ReviewSection): boolean {
  return section === "assignments" || portal === "skyward" && ["grades", "messages"].includes(section);
}
