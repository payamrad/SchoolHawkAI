import {
  ReviewError, REVIEW_VERSION, childFor, rulesFor, reviewStateSchema, semanticText,
  type HealthIssue, type ReviewChange, type ReviewConfig, type ReviewCoverage, type ReviewEvidence, type ReviewField,
  type ReviewFields, type ReviewIdFactory, type ReviewObservation, type ReviewScopeState, type ReviewState, type TrackedReviewRecord,
} from "./review";

export function reviewIdentityHash(config: ReviewConfig, ids: ReviewIdFactory): string {
  const sources = config.sources.map(source => [source.portal, source.accountId, source.sections.slice().sort()]).sort();
  const children = config.children.map(child => [child.id,
    child.bindings.map(binding => [binding.portal, binding.accountId, binding.studentId]).sort()]).sort();
  return ids("identity", [sources, children]);
}

export function compareReviewFields(before: ReviewFields, after: ReviewFields): ReviewChange["fields"] {
  const changes: ReviewChange["fields"] = [];
  for (const field of Object.keys(before) as ReviewField[]) {
    const left = before[field];
    const right = after[field];
    if ((typeof left === "string" ? semanticText(left) : left) !== (typeof right === "string" ? semanticText(right) : right)) {
      changes.push({ field, before: left, after: right });
    }
  }
  return changes;
}

function covers(coverage: ReviewCoverage | null, record: TrackedReviewRecord | { fields: ReviewFields; entity: string }): boolean {
  if (!coverage || coverage.kind === "discovery") return false;
  if (coverage.kind === "full") return true;
  const date = record.entity === "message" ? record.fields.sentDate : record.fields.dueDate;
  return date !== null && (!coverage.startDate || date >= coverage.startDate) &&
    (record.entity === "message" || !coverage.endDate || date <= coverage.endDate);
}

export interface ChangeDetectionResult {
  state: ReviewState;
  changes: ReviewChange[];
  notices: HealthIssue[];
  bootstrap: boolean;
}

export function detectReviewChanges(previous: ReviewState | undefined, observations: ReviewObservation[],
  config: ReviewConfig, evaluatedAt: string, ids: ReviewIdFactory): ChangeDetectionResult {
  const identityHash = reviewIdentityHash(config, ids);
  if (previous && previous.identityHash !== identityHash) {
    throw new ReviewError("Review sources or child bindings changed. Use a new profileId to establish a new baseline; existing history was preserved.");
  }
  const state: ReviewState = previous ? structuredClone(previous) : {
    version: REVIEW_VERSION, identityHash, initializedAt: evaluatedAt, streams: [], processed: {}, scopes: [], records: [],
  };
  if (state.streams.some(stream => stream.latestAt > evaluatedAt) || state.records.some(record => record.lastSeenAt > evaluatedAt)) {
    throw new ReviewError("Cannot evaluate a review before its retained observations. Correct the clock or use the saved historical evaluation.");
  }
  const records = new Map(state.records.map(record => [record.id, record]));
  const scopes = new Map(state.scopes.map(scope => [scope.id, scope]));
  const streams = new Map(state.streams.map(stream => [stream.id, stream]));
  const changes: ReviewChange[] = [];
  let processedCount = Object.keys(state.processed).length;
  const notices = new Set<HealthIssue>();
  const event = (record: { id: string; entity: ReviewChange["entity"] }, kind: ReviewChange["kind"], before: ReviewEvidence | null,
    after: ReviewEvidence, fields: ReviewChange["fields"] = []) => {
    changes.push({
      id: ids("event", [record.id, kind, before?.id ?? null, after.id, fields]),
      recordId: record.id, entity: record.entity, kind, detectedAt: evaluatedAt, observedAt: after.capturedAt, fields, before, after,
    });
  };
  const ordered = observations.slice().sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt) || left.runId.localeCompare(right.runId) || left.streamId.localeCompare(right.streamId));
  for (const observation of ordered) {
    if (!config.sources.some(source => source.portal === observation.evidence.portal &&
        source.accountId === observation.evidence.accountId && source.sections.includes(observation.evidence.section))) {
      throw new ReviewError("An observation is outside the configured review sources.");
    }
    if (observation.capturedAt > evaluatedAt) throw new ReviewError("A collection is dated in the future. Correct the clock before processing review data.");
    const processKey = `${observation.streamId}:${observation.runId}`;
    const known = state.processed[processKey];
    if (known) {
      if (known !== observation.fingerprint) throw new ReviewError("Previously reviewed source history changed. Use a new profileId to rebuild from the retained records.");
      continue;
    }
    const stream = streams.get(observation.streamId);
    state.processed[processKey] = observation.fingerprint;
    processedCount++;
    if (processedCount > 20000) throw new ReviewError("Review checkpoints exceed the 20,000-run safety limit.");
    if (stream && observation.capturedAt <= stream.latestAt) {
      notices.add("late-observations-ignored");
      continue;
    }
    streams.set(observation.streamId, {
      id: observation.streamId, evidence: observation.evidence,
      status: observation.status === "complete" && !observation.discoveryComplete ? "partial" : observation.status,
      latestAt: observation.capturedAt, latestRunId: observation.runId,
      lastCompleteAt: observation.status === "complete" && observation.discoveryComplete ?
        observation.capturedAt : stream?.lastCompleteAt ?? null,
      failureCount: observation.status === "complete" && observation.discoveryComplete ? 0 : (stream?.failureCount ?? 0) + 1,
    });
    const currentStream = streams.get(observation.streamId)!;
    if (previous && (stream ? stream.status !== currentStream.status : currentStream.status !== "complete")) {
      event({ id: observation.streamId, entity: "collection" }, "updated", stream?.evidence ?? null, currentStream.evidence,
        [{ field: "status", before: stream?.status ?? null, after: currentStream.status }]);
    }
    for (const [id, scope] of scopes) if (scope.streamId === observation.streamId && scope.part === "expected-student" &&
      observation.scopes.some(current => current.studentId === scope.studentId)) scopes.delete(id);
    const priorScopes = new Map([...scopes].filter(([, scope]) => scope.streamId === observation.streamId));
    const currentIds = new Set(observation.scopes.map(scope => scope.id));
    for (const old of priorScopes.values()) if (!currentIds.has(old.id)) {
      scopes.set(old.id, { ...old, status: observation.status === "auth-required" ? "auth-required" : "not-observed",
        failureCount: old.failureCount + 1, recordIds: [],
        evidence: { ...observation.evidence, studentId: old.studentId, courseId: old.courseId,
          id: ids("source", [observation.evidence.id, old.id]) } });
    }
    if (observation.evidence.section !== "messages") for (const child of config.children) for (const binding of child.bindings) {
      if (binding.portal !== observation.evidence.portal || binding.accountId !== observation.evidence.accountId ||
          observation.scopes.some(scope => scope.studentId === binding.studentId)) continue;
      const id = ids("scope", [observation.streamId, binding.studentId, "expected"]);
      if (scopes.has(id)) continue;
      scopes.set(id, {
        id, streamId: observation.streamId, studentId: binding.studentId, courseId: null, part: "expected-student",
        status: "not-observed", lastCompleteAt: null, failureCount: 1, recordIds: [],
        coverage: { kind: "discovery", startDate: null, endDate: null, marker: "expected-student" }, baselineCoverage: null,
        evidence: { ...observation.evidence, studentId: binding.studentId, id: ids("source", [observation.evidence.id, id]) },
      });
    }
    const trusted = new Map<string, { record: TrackedReviewRecord; scopeIds: string[] }>();
    const conflicts = new Set<string>();
    for (const scope of observation.scopes) {
      const old = scopes.get(scope.id);
      scopes.set(scope.id, {
        id: scope.id, streamId: scope.streamId, studentId: scope.studentId, courseId: scope.courseId, part: scope.part,
        status: scope.status, evidence: scope.evidence, coverage: scope.coverage,
        lastCompleteAt: scope.status === "complete" ? observation.capturedAt : old?.lastCompleteAt ?? null,
        failureCount: scope.status === "complete" ? 0 : (old?.failureCount ?? 0) + 1,
        baselineCoverage: scope.status === "complete" ? scope.coverage : old?.baselineCoverage ?? null,
        recordIds: scope.status === "complete" ? scope.records.map(record => record.id) : [],
      });
      if (scope.status !== "complete") continue;
      for (const input of scope.records) {
        if (input.evidence.capturedAt > evaluatedAt) throw new ReviewError("A source observation is dated in the future. Correct the clock before review.");
        const candidate = trusted.get(input.id);
        if (candidate) {
          candidate.scopeIds.push(scope.id);
          if (compareReviewFields(candidate.record.fields, input.fields).length) conflicts.add(input.id);
          continue;
        }
        trusted.set(input.id, {
          record: { ...input, scopeIds: [scope.id], firstSeenAt: input.evidence.capturedAt,
            lastSeenAt: input.evidence.capturedAt, active: true, absences: 0, coverageMarkers: { [scope.id]: scope.coverage.marker },
            lastKnownMissing: null },
          scopeIds: [scope.id],
        });
      }
    }
    for (const id of conflicts) {
      notices.add("source-conflict");
      for (const scopeId of trusted.get(id)!.scopeIds) {
        const scope = scopes.get(scopeId)!;
        const old = priorScopes.get(scopeId);
        scope.status = "partial";
        scope.failureCount = (old?.failureCount ?? 0) + 1;
        scope.lastCompleteAt = old?.lastCompleteAt ?? null;
        scope.baselineCoverage = old?.baselineCoverage ?? null;
        scope.recordIds = [];
      }
    }
    for (const [id, { record, scopeIds }] of trusted) {
      if (conflicts.has(id) || scopeIds.some(scopeId => scopes.get(scopeId)!.status !== "complete")) continue;
      const before = records.get(id);
      if (before && record.lastSeenAt < before.lastSeenAt) {
        notices.add("late-observations-ignored");
        continue;
      }
      record.scopeIds = scopeIds;
      record.lastKnownMissing = record.fields.missing === null ? before?.lastKnownMissing ?? null :
        { value: record.fields.missing, evidence: record.evidence };
      record.coverageMarkers = Object.fromEntries(scopeIds.map(id => [id, scopes.get(id)!.coverage.marker]));
      record.firstSeenAt = before?.firstSeenAt ?? record.firstSeenAt;
      if (previous) {
        if (!before) {
          const covered = scopeIds.some(scopeId => covers(priorScopes.get(scopeId)?.baselineCoverage ?? null, record));
          event(record, covered ? "newly-observed" : "first-observed", null, record.evidence);
        } else if (!before.active) event(record, "reappeared", before.evidence, record.evidence);
        else {
          const fields = compareReviewFields(before.fields, record.fields);
          if (fields.length) event(record, "updated", before.evidence, record.evidence, fields);
        }
      }
      records.set(id, record);
    }
    for (const record of records.values()) {
      if (!record.active || record.entity === "message" || !record.scopeIds.some(id => priorScopes.has(id)) ||
          trusted.has(record.id)) continue;
      let current: ReviewScopeState[];
      let prior: ReviewScopeState[];
      if (record.evidence.portal === "skyward" && record.entity === "assignment") {
        current = [...scopes.values()].filter(scope => scope.streamId === observation.streamId &&
          scope.studentId === record.evidence.studentId);
        prior = [...priorScopes.values()].filter(scope => scope.studentId === record.evidence.studentId);
        // Skyward lists move records between Upcoming, Missing and a rolling Past window.
        if (current.length !== 3 || prior.length !== 3 || record.fields.dueDate === null ||
            !current.some(scope => scope.part === "past" && covers(scope.coverage, record)) ||
            !prior.some(scope => scope.part === "past" && covers(scope.baselineCoverage, record))) {
          record.absences = 0;
          continue;
        }
      } else {
        current = record.scopeIds.map(id => scopes.get(id)).filter((scope): scope is ReviewScopeState => !!scope);
        prior = record.scopeIds.map(id => priorScopes.get(id)).filter((scope): scope is ReviewScopeState => !!scope);
      }
      const comparable = current.length > 0 && current.length === prior.length &&
        current.every(scope => scope.status === "complete" && scope.coverage.kind !== "discovery" &&
          prior.some(old => old.id === scope.id && old.baselineCoverage?.marker === scope.coverage.marker)) &&
        (record.evidence.portal === "skyward" && record.entity === "assignment" ||
          current.every(scope => record.coverageMarkers[scope.id] === scope.coverage.marker));
      if (!comparable) { record.absences = 0; continue; }
      record.absences++;
      if (record.absences >= rulesFor(config, childFor(config, record.evidence)).removalConfirmations) {
        record.active = false;
        if (previous) event(record, "no-longer-observed", record.evidence, current[0].evidence);
      }
    }
    if (previous) for (const scope of scopes.values()) if (scope.streamId === observation.streamId) {
      const before = priorScopes.get(scope.id);
      if (before ? before.status !== scope.status : scope.status !== "complete") {
        event({ id: scope.id, entity: "collection" }, "updated", before?.evidence ?? null, scope.evidence,
          [{ field: "status", before: before?.status ?? null, after: scope.status }]);
      }
    }
    if (records.size > 100000 || scopes.size > 10000 || processedCount > 20000) {
      throw new ReviewError("Review history exceeds the processing safety limit. Archive or narrow the configured sources before continuing.");
    }
  }
  if (!previous) for (const record of records.values()) if (record.active) event(record, "first-observed", null, record.evidence);
  state.records = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  state.scopes = [...scopes.values()].sort((a, b) => a.id.localeCompare(b.id));
  state.streams = [...streams.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { state: reviewStateSchema.parse(state), changes, notices: [...notices], bootstrap: !previous };
}
