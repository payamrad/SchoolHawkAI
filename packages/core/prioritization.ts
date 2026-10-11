import {
  childFor, rulesFor, reviewDate, supportedReviewSection, ReviewError,
  type ActionCandidate, type HealthIssue, type ReviewChange, type ReviewConfig, type ReviewEvidence,
  type ReviewHealth, type ReviewIdFactory, type ReviewState, type TrackedReviewRecord,
} from "./review";
import { reviewStreamId } from "./review-observations";

export interface ConfirmedReviewLink { id: string; skywardRecordId: string; canvasRecordId: string }
const HOUR = 3_600_000;

function ageHours(now: Date, capturedAt: string | null): number {
  return capturedAt === null ? Infinity : (now.getTime() - Date.parse(capturedAt)) / HOUR;
}

export function reviewHealth(state: ReviewState, config: ReviewConfig, now: Date, ids: ReviewIdFactory): ReviewHealth[] {
  const result: ReviewHealth[] = [];
  for (const source of config.sources) for (const section of source.sections) {
    const streamId = reviewStreamId(ids, source.portal, source.accountId, section);
    const stream = state.streams.find(stream => stream.id === streamId);
    const supported = supportedReviewSection(source.portal, section);
    const issues: HealthIssue[] = [];
    if (!supported) issues.push("unsupported-section");
    else if (!stream) issues.push("never-collected");
    else {
      if (stream.status !== "complete") issues.push("collection-incomplete");
      if (ageHours(now, stream.lastCompleteAt) > config.rules.staleAfterHours) issues.push("collection-stale");
    }
    result.push({
      id: streamId, portal: source.portal, section, childId: null, part: "account",
      status: !supported ? "unsupported" : stream?.status ?? "not-observed",
      lastAttemptAt: stream?.latestAt ?? null, lastCompleteAt: stream?.lastCompleteAt ?? null,
      failureCount: stream?.failureCount ?? 0, issues, coverage: null, evidenceId: stream?.evidence.id ?? null,
    });
    const scopes = state.scopes.filter(scope => scope.streamId === streamId);
    for (const scope of scopes) {
      const childId = childFor(config, scope.evidence);
      const rules = rulesFor(config, childId);
      const issues: HealthIssue[] = [];
      if (scope.status !== "complete") issues.push(scope.status === "not-observed" ? "scope-not-observed" : "collection-incomplete");
      if (ageHours(now, scope.lastCompleteAt) > rules.staleAfterHours) issues.push("collection-stale");
      if (scope.studentId !== null && childId === null) issues.push("unmapped-student");
      if (scope.coverage.kind === "window") issues.push("lookback-limited");
      if (scope.coverage.kind === "unread") issues.push("unread-only", "lookback-limited");
      result.push({
        id: scope.id, portal: source.portal, section, childId, part: scope.part, status: scope.status,
        lastAttemptAt: scope.evidence.capturedAt, lastCompleteAt: scope.lastCompleteAt, failureCount: scope.failureCount,
        issues, coverage: scope.coverage, evidenceId: scope.evidence.id,
      });
    }
    if (section === "messages" || !supported) continue;
    for (const child of config.children) for (const binding of child.bindings) {
      if (binding.portal !== source.portal || binding.accountId !== source.accountId ||
          scopes.some(scope => scope.studentId === binding.studentId)) continue;
      result.push({
        id: ids("scope", [streamId, binding.studentId, "expected"]), portal: source.portal, section,
        childId: child.id, part: "expected-student", status: "not-observed",
        lastAttemptAt: stream?.latestAt ?? null, lastCompleteAt: null, failureCount: stream ? Math.max(1, stream.failureCount) : 0,
        issues: ["scope-not-observed"], coverage: null, evidenceId: stream?.evidence.id ?? null,
      });
    }
  }
  return result;
}

export function prioritizeReview(state: ReviewState, changes: ReviewChange[], links: ConfirmedReviewLink[],
  config: ReviewConfig, now: Date, ids: ReviewIdFactory): {
    actions: ActionCandidate[]; health: ReviewHealth[]; evidence: ReviewEvidence[];
  } {
  const health = reviewHealth(state, config, now, ids);
  const healthById = new Map(health.map(entry => [entry.id, entry]));
  const scopeById = new Map(state.scopes.map(scope => [scope.id, scope]));
  const records = new Map(state.records.map(record => [record.id, record]));
  const events = new Map<string, ReviewChange[]>();
  for (const change of changes) events.set(change.recordId, [...(events.get(change.recordId) ?? []), change]);
  const evidence = new Map<string, ReviewEvidence>();
  const remember = (source: ReviewEvidence) => { evidence.set(source.id, source); };
  for (const stream of state.streams) remember(stream.evidence);
  for (const scope of state.scopes) remember(scope.evidence);
  const grouped = new Set<string>();
  const groups: { primary: TrackedReviewRecord; secondary?: TrackedReviewRecord; conflict: boolean }[] = [];
  const linked = new Set<string>();
  for (const link of links) {
    if (linked.has(link.skywardRecordId) || linked.has(link.canvasRecordId)) throw new ReviewError("Conflicting confirmed review links.");
    linked.add(link.skywardRecordId); linked.add(link.canvasRecordId);
    const skyward = records.get(link.skywardRecordId);
    const canvas = records.get(link.canvasRecordId);
    if (!skyward || !canvas) continue;
    if (childFor(config, skyward.evidence) !== childFor(config, canvas.evidence)) {
      groups.push({ primary: skyward, conflict: true }, { primary: canvas, conflict: true });
    } else {
      const numericPoints = (value: string | null) => value !== null && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()) ? Number(value) : null;
      const skywardPoints = numericPoints(skyward.fields.maxScore);
      const canvasPoints = numericPoints(canvas.fields.maxScore);
      const conflict = !!(skyward.fields.dueDate && canvas.fields.dueDate && skyward.fields.dueDate !== canvas.fields.dueDate) ||
        skywardPoints !== null && canvasPoints !== null && skywardPoints !== canvasPoints;
      groups.push(skyward.active || !canvas.active ? { primary: skyward, secondary: canvas, conflict } :
        { primary: canvas, secondary: skyward, conflict });
    }
    grouped.add(skyward.id); grouped.add(canvas.id);
  }
  for (const record of state.records) if (!grouped.has(record.id)) groups.push({ primary: record, conflict: false });
  const actions: ActionCandidate[] = [];
  for (const { primary, secondary, conflict } of groups) {
    const members = secondary ? [primary, secondary] : [primary];
    const relevant = members.flatMap(record => events.get(record.id) ?? []).sort((a, b) =>
      a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
    const childId = childFor(config, primary.evidence);
    const rules = rulesFor(config, childId);
    const reasons = new Set<ActionCandidate["reasons"][number]>();
    const uncertainty = new Set<HealthIssue>();
    for (const record of members) {
      if (ageHours(now, record.lastSeenAt) > rules.staleAfterHours) uncertainty.add("collection-stale");
      if (!record.scopeIds.some(id => {
        const scope = scopeById.get(id);
        return scope?.status === "complete" && scope.recordIds.includes(record.id);
      })) uncertainty.add("record-not-observed");
      if (record.evidence.studentId !== null && childFor(config, record.evidence) === null) uncertainty.add("unmapped-student");
      for (const scopeId of record.scopeIds) {
        const scopeHealth = healthById.get(scopeId);
        if (scopeHealth?.status !== "complete") uncertainty.add("collection-incomplete");
      }
    }
    if (conflict) { uncertainty.add("source-conflict"); reasons.add("source-conflict"); }
    let priority: ActionCandidate["priority"] = conflict ? "high" : "low";
    let delivery: ActionCandidate["delivery"] = "daily";
    const dueDate = primary.fields.dueDate;
    const dueAt = primary.fields.dueAt ?? (secondary && !conflict && dueDate !== null &&
      dueDate === secondary.fields.dueDate ? secondary.fields.dueAt : null);
    const dateZone = "America/Los_Angeles";
    if (primary.active && primary.entity === "assignment") {
      if (primary.fields.missing === true) { reasons.add("missing-work"); priority = "high"; }
      if (primary.fields.missing === null && primary.lastKnownMissing?.value === true) {
        reasons.add("missing-status-unverified"); uncertainty.add("collection-incomplete"); priority = "high";
      }
      const graded = primary.fields.missing === false && (primary.fields.grade !== null || primary.fields.score !== null);
      if (!graded && dueAt) {
        const hours = (Date.parse(dueAt) - now.getTime()) / HOUR;
        if (hours >= 0 && hours <= rules.dueSoonHours) {
          reasons.add("due-soon"); priority = "high";
          const newlyDiscovered = relevant.some(change =>
            ["first-observed", "newly-observed", "reappeared"].includes(change.kind) &&
            Date.parse(change.observedAt) <= Date.parse(dueAt) &&
            Date.parse(dueAt) - Date.parse(change.observedAt) <= rules.dueSoonHours * HOUR);
          if (newlyDiscovered && !uncertainty.size && rules.immediateDeadlineAlerts) delivery = "immediate-eligible";
        } else if (hours > 0 && hours <= rules.upcomingDays * 24) {
          reasons.add("upcoming"); if (priority !== "high") priority = "normal";
        } else if (hours < 0 && hours >= -24 && primary.fields.missing === null) {
          reasons.add("overdue-status-unknown"); if (priority !== "high") priority = "normal";
        }
      } else if (!graded && dueDate) {
        const today = reviewDate(now, dateZone);
        const days = (Date.parse(dueDate) - Date.parse(today)) / 86_400_000;
        if (days === 0 || days === 1) {
          reasons.add(days === 0 ? "due-today" : "due-tomorrow"); priority = "high";
        } else if (days > 1 && days <= rules.upcomingDays) {
          reasons.add("upcoming"); if (priority !== "high") priority = "normal";
        }
      }
    }
    for (const change of relevant) {
      if (change.kind === "first-observed") reasons.add("first-observed");
      else if (change.kind === "newly-observed") {
        reasons.add(primary.entity === "message" && primary.fields.unread === true ? "new-unread-message" : "new-record");
      } else if (change.kind === "updated") {
        reasons.add(change.entity === "grade" ? "grade-changed" : "record-changed");
        if (change.fields.some(field => field.field === "missing" && field.after === true)) priority = "high";
      } else reasons.add(change.kind);
      if (change.kind !== "first-observed" && priority === "low") priority = "normal";
    }
    if (!reasons.size) continue;
    const evidenceIds = new Set<string>();
    for (const record of members) { remember(record.evidence); evidenceIds.add(record.evidence.id); }
    if (primary.lastKnownMissing && primary.fields.missing === null) {
      remember(primary.lastKnownMissing.evidence); evidenceIds.add(primary.lastKnownMissing.evidence.id);
    }
    for (const change of relevant) {
      remember(change.after); evidenceIds.add(change.after.id);
      if (change.before) { remember(change.before); evidenceIds.add(change.before.id); }
    }
    actions.push({
      id: ids("action", [members.map(record => record.id).sort()]), recordIds: members.map(record => record.id),
      entity: primary.entity, childId, title: primary.fields.title, course: primary.fields.course, priority, delivery,
      facts: primary.fields, relatedFacts: secondary ? [{ sourceId: secondary.evidence.id, fields: secondary.fields }] : [],
      lastKnownMissing: primary.fields.missing === null ? primary.lastKnownMissing : null,
      reasons: [...reasons], dueDate, dueAt, dueTimeZone: dateZone, changes: relevant,
      evidenceIds: [...evidenceIds], uncertainty: [...uncertainty],
      extractionConfidence: uncertainty.size ? "last-known" : "verified-observation", interpretation: "deterministic",
    });
  }
  for (const entry of health) {
    const problems = entry.issues.filter(issue => !["lookback-limited", "unread-only"].includes(issue));
    const transitions = events.get(entry.id) ?? [];
    if (!problems.length && !transitions.length) continue;
    const rules = rulesFor(config, entry.childId);
    const sourceIds = new Set(entry.evidenceId ? [entry.evidenceId] : []);
    for (const transition of transitions) {
      remember(transition.after); sourceIds.add(transition.after.id);
      if (transition.before) { remember(transition.before); sourceIds.add(transition.before.id); }
    }
    actions.push({
      id: ids("action", [entry.id, "health"]), recordIds: [], entity: "collection", childId: entry.childId,
      title: `${entry.portal} ${entry.section}: ${entry.part}`, course: null, priority: problems.length ? "high" : "normal",
      facts: null, relatedFacts: [],
      lastKnownMissing: null,
      delivery: problems.length && rules.immediateOperationalAlerts && entry.failureCount >= rules.failureThreshold ? "immediate-eligible" : "daily",
      reasons: [problems.length ? "collection-health" : "collection-recovered"],
      dueDate: null, dueAt: null, dueTimeZone: config.timeZone, changes: transitions,
      evidenceIds: [...sourceIds], uncertainty: problems,
      extractionConfidence: problems.length ? "last-known" : "verified-observation", interpretation: "deterministic",
    });
  }
  const rank = { high: 0, normal: 1, low: 2 };
  actions.sort((left, right) => rank[left.priority] - rank[right.priority] ||
    (left.entity === "collection" ? 0 : 1) - (right.entity === "collection" ? 0 : 1) ||
    (left.dueAt ?? left.dueDate ?? "9999").localeCompare(right.dueAt ?? right.dueDate ?? "9999") ||
    left.id.localeCompare(right.id));
  return { actions, health, evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
