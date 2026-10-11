import { z } from "zod";
import {
  ReviewError, healthIssueSchema, priorityReasonSchema, priorityRulesSchema, reviewEntitySchema, reviewFieldSchema, reviewIdSchema,
  reviewPortalSchema, reviewResultSchema, reviewSectionSchema, reviewStatusSchema, reviewTimestamp, reviewTimeZoneSchema,
  type ActionCandidate, type ReviewFields, type ReviewResult,
} from "@schoolhawk/core/review";

const childRef = z.string().regex(/^child-[1-9]\d*$/);
const shortText = z.string().max(240);
const smallValue = z.union([z.string().max(160), z.boolean(), z.null()]);
const ruleParametersSchema = priorityRulesSchema.pick({
  dueSoonHours: true, upcomingDays: true, staleAfterHours: true, failureThreshold: true, removalConfirmations: true,
});
const factsSchema = z.object({
  title: shortText, course: z.string().max(160).nullable(),
  dueDate: z.iso.date().nullable(), dueAt: reviewTimestamp.nullable(), missing: z.boolean().nullable(),
  grade: z.string().max(120).nullable(), score: z.string().max(120).nullable(), maxScore: z.string().max(120).nullable(),
  status: z.string().max(120).nullable(), term: z.string().max(120).nullable(), gradingScale: z.string().max(120).nullable(),
  sentDate: z.iso.date().nullable(), unread: z.boolean().nullable(),
}).strict();
const sourceSchema = z.object({
  id: reviewIdSchema, portal: reviewPortalSchema, section: reviewSectionSchema,
  capturedAt: reviewTimestamp, parserVersion: z.number().int().positive(),
}).strict();
const compactChangeSchema = z.object({
  id: reviewIdSchema,
  kind: z.enum(["first-observed", "newly-observed", "updated", "no-longer-observed", "reappeared"]),
  observedAt: reviewTimestamp, beforeSource: reviewIdSchema.nullable(), afterSource: reviewIdSchema,
  fields: z.array(z.object({ field: reviewFieldSchema, before: smallValue, after: smallValue,
    valuesOmitted: z.boolean() }).strict()).max(14),
}).strict();
const itemSchema = z.object({
  id: reviewIdSchema, childRef: childRef.nullable(),
  entity: z.enum([...reviewEntitySchema.options, "collection"]),
  priority: z.enum(["high", "normal", "low"]), delivery: z.enum(["daily", "immediate-eligible"]),
  reasons: z.array(priorityReasonSchema).min(1), title: shortText,
  ruleParameters: ruleParametersSchema,
  dueDate: z.iso.date().nullable(), dueAt: reviewTimestamp.nullable(), dueTimeZone: reviewTimeZoneSchema,
  facts: factsSchema.nullable(),
  relatedFacts: z.array(z.object({ sourceRef: reviewIdSchema, facts: factsSchema }).strict()).max(1),
  lastKnownMissing: z.object({ value: z.boolean(), sourceRef: reviewIdSchema }).strict().nullable(),
  changes: z.array(compactChangeSchema).max(3),
  omittedChanges: z.number().int().nonnegative(),
  sourceRefs: z.array(reviewIdSchema).max(9),
  uncertainty: z.array(healthIssueSchema),
  extractionConfidence: z.enum(["verified-observation", "last-known"]),
  interpretation: z.literal("deterministic"),
  textTruncated: z.boolean(),
}).strict();
const healthDetailSchema = z.object({
  id: reviewIdSchema, portal: reviewPortalSchema, section: reviewSectionSchema,
  childRef: childRef.nullable(), part: z.string().max(100), status: reviewStatusSchema,
  lastAttemptAt: reviewTimestamp.nullable(), lastCompleteAt: reviewTimestamp.nullable(),
  failureCount: z.number().int().nonnegative(), issues: z.array(healthIssueSchema),
  coverage: z.object({ kind: z.enum(["full", "window", "unread", "discovery"]),
    startDate: z.iso.date().nullable(), endDate: z.iso.date().nullable() }).strict().nullable(),
}).strict();

export const briefingInputSchema = z.object({
  version: z.literal(1), reviewId: reviewIdSchema, engineVersion: z.literal(1),
  generatedAt: reviewTimestamp, recentSince: reviewTimestamp, timeZone: reviewTimeZoneSchema,
  contentTrust: z.literal("untrusted-source-data"),
  privacy: z.literal("minimized-not-anonymized"),
  conclusion: z.enum(["attention-required", "incomplete", "baseline-established", "no-material-changes-within-checked-scope"]),
  children: z.array(childRef).max(100),
  coverage: z.object({
    scope: z.literal("configured-sources-only"), complete: z.boolean(), limited: z.boolean(),
    total: z.number().int().nonnegative(), problems: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(), details: z.array(healthDetailSchema).max(64),
  }).strict(),
  notices: z.array(healthIssueSchema),
  totals: z.object({ items: z.number().int().nonnegative(), highPriority: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative() }).strict(),
  omitted: z.object({ items: z.number().int().nonnegative(), highPriority: z.number().int().nonnegative() }).strict(),
  limits: z.object({ maxItems: z.number().int().min(1).max(100), maxBytes: z.number().int().min(4096).max(131072) }).strict(),
  items: z.array(itemSchema).max(100),
  sources: z.array(sourceSchema).max(900),
}).strict().superRefine((input, context) => {
  const sources = new Set(input.sources.map(source => source.id));
  const children = new Set(input.children);
  const completeConclusion = input.conclusion === "no-material-changes-within-checked-scope";
  if (sources.size !== input.sources.length || children.size !== input.children.length ||
      new Set(input.items.map(item => item.id)).size !== input.items.length ||
      input.items.length > input.limits.maxItems ||
      input.items.length + input.omitted.items !== input.totals.items ||
      input.coverage.details.length + input.coverage.omitted !== input.coverage.total ||
      input.coverage.problems > input.coverage.total ||
      input.coverage.complete && (input.coverage.problems > 0 || input.notices.length > 0) ||
      input.items.filter(item => item.priority === "high").length + input.omitted.highPriority !== input.totals.highPriority ||
      input.items.some(item => item.childRef !== null && !children.has(item.childRef) ||
        item.sourceRefs.some(id => !sources.has(id)) ||
        item.relatedFacts.some(facts => !item.sourceRefs.includes(facts.sourceRef)) ||
        item.lastKnownMissing !== null && !item.sourceRefs.includes(item.lastKnownMissing.sourceRef) ||
        item.changes.some(change => !item.sourceRefs.includes(change.afterSource) ||
          change.beforeSource !== null && !item.sourceRefs.includes(change.beforeSource)) ||
        item.entity !== "collection" && !item.sourceRefs.length) ||
      input.coverage.details.some(detail => detail.childRef !== null && !children.has(detail.childRef)) ||
      completeConclusion && (!input.coverage.complete || input.coverage.problems || input.totals.items ||
        input.totals.changes || input.notices.length || input.omitted.items || input.coverage.omitted) ||
      Buffer.byteLength(JSON.stringify(input), "utf8") > input.limits.maxBytes) {
    context.addIssue({ code: "custom", message: "Inconsistent, ungrounded, or oversized briefing input." });
  }
});
export type BriefingInput = z.infer<typeof briefingInputSchema>;

function compactItem(action: ActionCandidate, child: string | null,
  ruleParameters: z.infer<typeof ruleParametersSchema>): BriefingInput["items"][number] {
  let truncated = false;
  const clip = (value: string, limit: number) => {
    const plain = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (plain.length > limit) truncated = true;
    return plain.slice(0, limit);
  };
  const nullable = (value: string | null, limit = 120) => value === null ? null : clip(value, limit);
  const facts = (value: ReviewFields): z.infer<typeof factsSchema> => ({
    title: clip(value.title, 240), course: nullable(value.course, 160), dueDate: value.dueDate, dueAt: value.dueAt,
    missing: value.missing, grade: nullable(value.grade), score: nullable(value.score), maxScore: nullable(value.maxScore),
    status: nullable(value.status), term: nullable(value.term), gradingScale: nullable(value.gradingScale),
    sentDate: value.sentDate, unread: value.unread,
  });
  const selected = action.changes.slice(-3);
  const sourceRefs = new Set(action.evidenceIds.slice(0, action.relatedFacts.length + 1));
  if (action.lastKnownMissing) sourceRefs.add(action.lastKnownMissing.evidence.id);
  const changes = selected.map(change => {
    sourceRefs.add(change.after.id);
    if (change.before) sourceRefs.add(change.before.id);
    return {
      id: change.id, kind: change.kind, observedAt: change.observedAt, beforeSource: change.before?.id ?? null,
      afterSource: change.after.id,
      fields: change.fields.map(field => ({
        field: field.field,
        before: field.field === "contentHash" ? null : typeof field.before === "string" ? clip(field.before, 160) : field.before,
        after: field.field === "contentHash" ? null : typeof field.after === "string" ? clip(field.after, 160) : field.after,
        valuesOmitted: field.field === "contentHash",
      })),
    };
  });
  const output = {
    id: action.id, childRef: child, entity: action.entity, priority: action.priority, delivery: action.delivery,
    reasons: action.reasons, title: clip(action.title, 240), dueDate: action.dueDate, dueAt: action.dueAt,
    ruleParameters,
    dueTimeZone: action.dueTimeZone, facts: action.facts ? facts(action.facts) : null,
    relatedFacts: action.relatedFacts.map(value => ({ sourceRef: value.sourceId, facts: facts(value.fields) })),
    lastKnownMissing: action.lastKnownMissing ? { value: action.lastKnownMissing.value, sourceRef: action.lastKnownMissing.evidence.id } : null,
    changes, omittedChanges: action.changes.length - selected.length, sourceRefs: [...sourceRefs],
    uncertainty: action.uncertainty, extractionConfidence: action.extractionConfidence,
    interpretation: action.interpretation, textTruncated: truncated,
  };
  return itemSchema.parse(output);
}

export function buildBriefingInput(value: ReviewResult): BriefingInput {
  const review = reviewResultSchema.parse(value);
  const childIds = review.childRules.map(child => child.childId).sort();
  const child = (id: string | null) => id === null ? null : `child-${childIds.indexOf(id) + 1}`;
  const problem = (issues: string[]) => issues.some(issue => !["lookback-limited", "unread-only"].includes(issue));
  const problems = review.health.filter(entry => problem(entry.issues)).length;
  const complete = problems === 0 && review.notices.length === 0;
  const input: BriefingInput = {
    version: 1, engineVersion: 1, reviewId: review.id, generatedAt: review.evaluatedAt, recentSince: review.recentSince,
    timeZone: review.timeZone, contentTrust: "untrusted-source-data", privacy: "minimized-not-anonymized",
    conclusion: !complete ? "incomplete" : review.actions.some(action => action.priority !== "low") ? "attention-required" :
      review.bootstrap ? "baseline-established" : review.actions.length || review.changes.length ? "attention-required" : "no-material-changes-within-checked-scope",
    children: childIds.map((_, index) => `child-${index + 1}`),
    coverage: { scope: "configured-sources-only", complete,
      limited: review.health.some(entry => entry.issues.includes("lookback-limited") || entry.issues.includes("unread-only")),
      total: review.health.length, problems, omitted: review.health.length, details: [] },
    notices: review.notices,
    totals: { items: review.actions.length, highPriority: review.actions.filter(action => action.priority === "high").length,
      changes: review.changes.length },
    omitted: { items: review.actions.length, highPriority: review.actions.filter(action => action.priority === "high").length },
    limits: { maxItems: review.briefingOptions.maxItems, maxBytes: review.briefingOptions.maxBytes }, items: [], sources: [],
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(input), "utf8");
  const sortedHealth = review.health.slice().sort((a, b) => Number(problem(b.issues)) - Number(problem(a.issues)) || a.id.localeCompare(b.id));
  for (const entry of sortedHealth.slice(0, 64)) {
    input.coverage.details.push({
      id: entry.id, portal: entry.portal, section: entry.section, childRef: child(entry.childId), part: entry.part,
      status: entry.status, lastAttemptAt: entry.lastAttemptAt, lastCompleteAt: entry.lastCompleteAt,
      failureCount: entry.failureCount, issues: entry.issues,
      coverage: entry.coverage ? { kind: entry.coverage.kind, startDate: entry.coverage.startDate, endDate: entry.coverage.endDate } : null,
    });
    input.coverage.omitted--;
    if (bytes() > input.limits.maxBytes / 3) {
      input.coverage.details.pop(); input.coverage.omitted++;
      break;
    }
  }
  const sources = new Map(review.evidence.map(source => [source.id, source]));
  for (const action of review.actions.slice(0, input.limits.maxItems)) {
    const rules = review.childRules.find(entry => entry.childId === action.childId)?.rules ?? review.rules;
    const item = compactItem(action, child(action.childId), {
      dueSoonHours: rules.dueSoonHours, upcomingDays: rules.upcomingDays, staleAfterHours: rules.staleAfterHours,
      failureThreshold: rules.failureThreshold, removalConfirmations: rules.removalConfirmations,
    });
    const addedSources: BriefingInput["sources"] = [];
    for (const id of item.sourceRefs) if (!input.sources.some(source => source.id === id)) {
      const source = sources.get(id);
      if (!source) throw new ReviewError("Briefing evidence is missing from the saved review.");
      addedSources.push({ id, portal: source.portal, section: source.section, capturedAt: source.capturedAt, parserVersion: source.parserVersion });
    }
    input.items.push(item); input.sources.push(...addedSources);
    input.omitted.items--;
    if (item.priority === "high") input.omitted.highPriority--;
    if (bytes() + 1 > input.limits.maxBytes) {
      input.items.pop(); input.sources.splice(input.sources.length - addedSources.length, addedSources.length);
      input.omitted.items++;
      if (item.priority === "high") input.omitted.highPriority++;
      break;
    }
  }
  if (input.omitted.items || input.coverage.omitted) input.conclusion = "incomplete";
  return briefingInputSchema.parse(input);
}

export function serializeBriefingInput(input: BriefingInput): string {
  return JSON.stringify(briefingInputSchema.parse(input));
}

export function renderDeterministicBriefing(value: BriefingInput): string {
  const input = briefingInputSchema.parse(value);
  const lines = [`School review: ${input.generatedAt}`, `Conclusion: ${input.conclusion}.`,
    "Coverage is limited to the configured sources and stated collection windows; this is not an unqualified all-clear."];
  if (input.coverage.problems) lines.push(`Collection coverage has ${input.coverage.problems} problem scope(s).`);
  if (input.coverage.limited) lines.push("Some sources are lookback-limited or unread-only.");
  for (const scope of input.coverage.details) if (scope.status === "auth-required") {
    lines.push(`Authentication required for ${scope.portal} ${scope.section}; renew the authorized session locally.`);
  }
  for (const item of input.items) {
    lines.push(`[${item.priority}] ${item.childRef ?? "account/unmapped"}: ${item.title}`,
      `  Reasons: ${item.reasons.join(", ")}. Delivery eligibility: ${item.delivery}.`);
    if (item.dueAt || item.dueDate) lines.push(`  Due: ${item.dueAt ?? `${item.dueDate} (date only, ${item.dueTimeZone})`}.`);
    if (item.facts?.grade !== null && item.facts?.grade !== undefined) lines.push(`  Observed grade: ${item.facts.grade}.`);
    if (item.lastKnownMissing?.value === true) lines.push("  Previously marked missing; current missing status could not be verified.");
    if (item.uncertainty.length) lines.push(`  Caution: ${item.uncertainty.join(", ")}.`);
    if (item.changes.length) lines.push(`  Changes: ${item.changes.map(change => change.kind).join(", ")}.`);
    if (item.sourceRefs.length) lines.push(`  Evidence: ${item.sourceRefs.join(", ")}.`);
    if (item.textTruncated || item.omittedChanges) lines.push("  Detail is shortened; inspect the saved local review.");
  }
  if (input.omitted.items || input.coverage.omitted) {
    lines.push(`Omitted for size: ${input.omitted.items} item(s), including ${input.omitted.highPriority} high-priority; ${input.coverage.omitted} health detail(s).`);
  }
  return lines.join("\n");
}
