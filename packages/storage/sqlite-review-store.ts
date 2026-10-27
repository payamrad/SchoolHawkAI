import { z } from "zod";
import {
  ReviewError, changeEventSchema, reviewConfigSchema, reviewIdSchema, reviewResultSchema, reviewStateSchema,
  reviewTimestamp, rulesFor, supportedReviewSection,
  type ReviewConfig, type ReviewIdFactory, type ReviewObservation, type ReviewResult, type ReviewPortal, type ReviewSection,
} from "@schoolhawk/core/review";
import { detectReviewChanges } from "@schoolhawk/core/change-detection";
import { normalizeReviewObservation, reviewRecordId, reviewStreamId, type ReviewSourceRun } from "@schoolhawk/core/review-observations";
import { prioritizeReview, type ConfirmedReviewLink } from "@schoolhawk/core/prioritization";
import { resolveReviewStudents } from "@schoolhawk/core/student-identity";
import { buildStudentSnapshot, studentSnapshotOptionsSchema,
  type SnapshotHistoryRun, type SnapshotLinks, type StudentSnapshot, type StudentSnapshotOptions } from "@schoolhawk/core/student-snapshot";
import { DiagnosticLogError, diagnosticErrorCode, diagnosticErrorType, reportDiagnostic } from "@schoolhawk/core/diagnostics";
import {
  agentReportIdSchema, agentReportSummarySchema, storedAgentReportSchema, studentReportAnalysisSchema,
  reportCheckpointSchema, reportInputHashSchema, type AgentReportSummary, type ReportCheckpoint, type StoredAgentReport,
} from "@schoolhawk/core/agent-reports";
import { SqliteCanvasStore, withWorkspaceDatabase } from "./sqlite-canvas-store";
import { checkAccount, checkLimit } from "./sqlite-message-store";
import type { ReviewStore } from "./review";
import { AgentReportStorageError, type AgentReportStore } from "./agent-reports";

const storedPayload = z.object({ payload: z.instanceof(Buffer) });
const runReference = z.object({
  run_id: z.uuid(), captured_at: reviewTimestamp, content_hash: z.string(),
});

export async function withReviewStore<Result>(root: string, operation: (store: SqliteReviewStore) => Result | Promise<Result>): Promise<Result> {
  return withWorkspaceDatabase(root, async (file, key) => {
    const store = new SqliteReviewStore(file, key);
    try { return await operation(store); }
    finally { store.close(); }
  });
}

export class SqliteReviewStore extends SqliteCanvasStore implements ReviewStore, AgentReportStore {
  getReportCheckpoint(scopeHash: string): ReportCheckpoint | undefined {
    try {
      reportInputHashSchema.parse(scopeHash);
      const row = this.database.prepare("SELECT payload FROM report_checkpoints WHERE scope_hash = ?").get(scopeHash);
      if (!row) return undefined;
      const checkpoint = reportCheckpointSchema.parse(this.unseal(storedPayload.parse(row).payload,
        JSON.stringify(["report-checkpoint", scopeHash])));
      if (checkpoint.scopeHash !== scopeHash || checkpoint.reportIds.some(id => !this.getAgentReport(id))) {
        throw new AgentReportStorageError("The report comparison checkpoint does not match saved AI reports.");
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      reportDiagnostic({ level: "error", code: "STORAGE_OPEN_FAILED", section: "storage", stage: "DATABASE_OPEN",
        errorType: diagnosticErrorType(error), errorCode: diagnosticErrorCode(error) });
      throw new AgentReportStorageError("Cannot read the saved report comparison. Check database integrity and the original key; no AI request was sent.", error);
    }
  }

  saveReportCheckpoint(input: ReportCheckpoint): void {
    try {
      const checkpoint = reportCheckpointSchema.parse(input);
      this.database.transaction(() => {
        if (checkpoint.reportIds.some(id => !this.getAgentReport(id))) {
          throw new AgentReportStorageError("A comparison checkpoint requires successfully saved AI reports.");
        }
        this.database.prepare(`INSERT INTO report_checkpoints VALUES (?, ?)
          ON CONFLICT(scope_hash) DO UPDATE SET payload = excluded.payload`).run(checkpoint.scopeHash,
          this.seal(checkpoint, JSON.stringify(["report-checkpoint", checkpoint.scopeHash])));
      }).immediate();
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      reportDiagnostic({ level: "error", code: "STORAGE_WRITE_FAILED", section: "storage", stage: "DATABASE_WRITE",
        errorType: diagnosticErrorType(error), errorCode: diagnosticErrorCode(error) });
      throw new AgentReportStorageError("Cannot save the report comparison checkpoint. AI responses remain saved; inspect them before retrying.", error);
    }
  }

  saveAgentReport(input: unknown, now = new Date()): StoredAgentReport {
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "DATABASE_WRITE", section: "storage" });
    const parsed = studentReportAnalysisSchema.safeParse(input);
    if (!parsed.success) {
      reportDiagnostic({ level: "error", code: "SCHEMA_INVALID", stage: "DATABASE_WRITE", section: "storage", errorType: "validation" });
      throw new AgentReportStorageError("The AI analysis is not a valid report response. Nothing was saved.");
    }
    const analysis = parsed.data;
    const reportId = `report_${this.hash(JSON.stringify(["agent-report-v1", analysis.provider, analysis.responseId]))}`;
    try {
      const report = this.database.transaction(() => {
        const existing = this.getAgentReport(reportId);
        if (existing) {
          const { version: _version, reportId: _reportId, savedAt: _savedAt, ...previous } = existing;
          if (JSON.stringify(previous) !== JSON.stringify(analysis)) {
            throw new AgentReportStorageError("An AI response with this provider/response ID was already saved with different contents. The existing report was preserved.");
          }
          return existing;
        }
        const saved = storedAgentReportSchema.parse({ ...analysis, version: 1, reportId, savedAt: now.toISOString() });
        this.database.prepare("INSERT INTO agent_reports VALUES (?, ?, ?, ?, ?, ?)").run(
          saved.reportId, saved.provider, saved.receivedAt, saved.savedAt, saved.studentRefs.length,
          this.seal(saved, JSON.stringify(["agent-report", saved.reportId])),
        );
        const persisted = this.getAgentReport(saved.reportId);
        if (!persisted) throw new AgentReportStorageError("The AI report was not available after its database insert.");
        return persisted;
      }).immediate();
      reportDiagnostic({ level: "info", code: "AGENT_REPORT_SAVED", stage: "DATABASE_WRITE", section: "storage",
        status: "success", counts: { accepted: 1, students: report.studentRefs.length } });
      return report;
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      reportDiagnostic({ level: "error", code: "STORAGE_WRITE_FAILED", stage: "DATABASE_WRITE", section: "storage",
        errorType: diagnosticErrorType(error), errorCode: diagnosticErrorCode(error) });
      if (error instanceof AgentReportStorageError) throw error;
      throw new AgentReportStorageError("The AI response could not be saved locally. Check the database, original key, permissions, and disk space. No saved-report result was returned.", error);
    }
  }

  getAgentReport(reportId: string): StoredAgentReport | undefined {
    if (!agentReportIdSchema.safeParse(reportId).success) throw new AgentReportStorageError("Invalid saved AI report ID.");
    const row = this.database.prepare(`SELECT report_id AS reportId, provider, received_at AS receivedAt,
      saved_at AS savedAt, student_count AS studentCount, payload FROM agent_reports WHERE report_id = ?`).get(reportId);
    if (!row) return undefined;
    const value = agentReportSummarySchema.extend({ payload: z.instanceof(Buffer) }).parse(row);
    const report = storedAgentReportSchema.parse(this.unseal(value.payload, JSON.stringify(["agent-report", reportId])));
    const expectedId = `report_${this.hash(JSON.stringify(["agent-report-v1", report.provider, report.responseId]))}`;
    if (report.reportId !== reportId || expectedId !== reportId || report.provider !== value.provider ||
        report.receivedAt !== value.receivedAt || report.savedAt !== value.savedAt || report.studentRefs.length !== value.studentCount) {
      throw new AgentReportStorageError("Saved AI report metadata does not match its protected contents.");
    }
    return report;
  }

  listAgentReports(options: { limit?: number; offset?: number } = {}): AgentReportSummary[] {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    checkLimit(limit);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentReportStorageError("Invalid AI report query offset.");
    return this.database.prepare(`SELECT report_id AS reportId, provider, received_at AS receivedAt,
      saved_at AS savedAt, student_count AS studentCount FROM agent_reports
      ORDER BY received_at DESC, report_id DESC LIMIT ? OFFSET ?`).all(limit, offset)
      .map(row => agentReportSummarySchema.parse(row));
  }

  private reviewIds(config: ReviewConfig): ReviewIdFactory {
    return (kind, parts) => `${kind}_${this.hash(JSON.stringify(["review-v1", config.profileId, kind, parts]))}`;
  }

  private *sourceReferences(config: ReviewConfig) {
    let count = 0;
    for (const source of config.sources) for (const section of source.sections) {
      if (!supportedReviewSection(source.portal, section)) continue;
      const table = source.portal === "canvas" ? "canvas_assignment_runs" : section === "assignments" ? "assignment_runs" :
        section === "grades" ? "grade_runs" : "collection_runs";
      const references = this.database.prepare(`SELECT run_id, captured_at, content_hash FROM ${table}
        WHERE account_id = ? ORDER BY captured_at, run_id LIMIT 20001`).all(source.accountId);
      count += references.length;
      if (count > 20000) throw new ReviewError("Review source history exceeds 20,000 runs. Archive or narrow the configured sources.");
      for (const row of references) yield { portal: source.portal, accountId: source.accountId, section, reference: runReference.parse(row) };
    }
  }

  private readSourceRun(portal: ReviewPortal, section: ReviewSection, accountId: string, runId: string): ReviewSourceRun {
    if (!supportedReviewSection(portal, section)) throw new ReviewError("Unsupported review source section.");
    if (portal === "canvas") {
      const run = this.getCanvasAssignmentRun(accountId, runId);
      if (!run) throw new ReviewError("A Canvas source run is unavailable.");
      return { portal: "canvas", section: "assignments", run };
    }
    if (section === "assignments") {
      const run = this.getAssignmentRun(accountId, runId);
      if (!run) throw new ReviewError("A Skyward assignment source run is unavailable.");
      return { portal: "skyward", section: "assignments", run };
    }
    if (section === "grades") {
      const run = this.getGradeRun(accountId, runId);
      if (!run) throw new ReviewError("A Skyward grade source run is unavailable.");
      return { portal: "skyward", section: "grades", run };
    }
    const run = this.getRun(accountId, runId);
    if (!run) throw new ReviewError("A Skyward message source run is unavailable.");
    return { portal: "skyward", section: "messages", run };
  }

  private *sourceHistory(config: ReviewConfig): Iterable<SnapshotHistoryRun> {
    for (const source of this.sourceReferences(config)) {
      yield { accountId: source.accountId,
        ...this.readSourceRun(source.portal, source.section, source.accountId, source.reference.run_id) };
    }
  }

  createStudentSnapshot(input: ReviewConfig, now = new Date(), inputOptions: StudentSnapshotOptions = {}): StudentSnapshot {
    const config = reviewConfigSchema.parse(input);
    const options = studentSnapshotOptionsSchema.parse(inputOptions);
    return this.database.transaction(() => {
      const review = this.processReview(config, now);
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "STUDENT_SNAPSHOT" });
      const links: SnapshotLinks = { courses: [], assignments: [] };
      for (const source of config.sources) if (source.portal === "canvas" && source.sections.includes("assignments")) {
        links.courses.push(...this.listCanvasCourseMappings(source.accountId).map(mapping => ({ accountId: source.accountId, mapping })));
        links.assignments.push(...this.listCanvasAssignmentLinks(source.accountId).map(link => ({ accountId: source.accountId, link })));
      }
      const result = buildStudentSnapshot(this.sourceHistory(config), config, review, links, this.reviewIds(config), options);
      const accepted = result.totals.assignmentSourceRecords + result.totals.gradeRecords +
        result.totals.earlierAssignmentGradeRecords + result.totals.messages;
      const available = result.availableRecords.assignments + result.availableRecords.grades + result.availableRecords.messages;
      reportDiagnostic({ level: "info", code: "SNAPSHOT_SUMMARY", stage: "STUDENT_SNAPSHOT",
        status: result.status === "incomplete-source-coverage" ? "partial" : "complete",
        counts: { scanned: available, accepted, skipped: available - accepted,
          students: result.totals.students, courses: result.totals.courses } });
      return result;
    }).immediate();
  }

  processReview(input: ReviewConfig, now = new Date()): ReviewResult {
    const requested = reviewConfigSchema.parse(input);
    const evaluatedAt = reviewTimestamp.parse(now.toISOString());
    const ids = this.reviewIds(requested);
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "REVIEW_PROCESS" });
    return this.database.transaction(() => {
      const resolution = resolveReviewStudents(requested, this.sourceHistory(requested));
      const config = resolution.config;
      const saved = this.database.prepare("SELECT payload FROM review_profiles WHERE profile_id = ?").get(config.profileId);
      const previous = saved ? reviewStateSchema.parse(this.unseal(storedPayload.parse(saved).payload,
        JSON.stringify(["review-state", config.profileId]))) : undefined;
      const observations: ReviewObservation[] = [];
      let scannedRecords = 0;
      let observationBytes = 0;
      let scannedRuns = 0;
      for (const source of this.sourceReferences(config)) {
          scannedRuns++;
          const reference = source.reference;
          const streamId = reviewStreamId(ids, source.portal, source.accountId, source.section);
          const knownHash = previous?.processed[`${streamId}:${reference.run_id}`];
          if (knownHash === reference.content_hash) continue;
          if (knownHash) throw new ReviewError("Previously reviewed source history changed. Use a new profileId to rebuild from retained records.");
          const sourceRun = this.readSourceRun(source.portal, source.section, source.accountId, reference.run_id);
          const observation = normalizeReviewObservation(sourceRun, source.accountId, reference.content_hash, ids);
          scannedRecords += observation.scopes.reduce((sum, scope) => sum + scope.records.length, 0);
          observationBytes += Buffer.byteLength(JSON.stringify(observation), "utf8");
          if (scannedRecords > 200000) throw new ReviewError("A review batch exceeds 200,000 observations. Archive or narrow source history.");
          if (observationBytes > 50 * 1024 * 1024) throw new ReviewError("A review batch exceeds 50 MiB of normalized input. Archive or narrow source history.");
          observations.push(observation);
      }
      const detected = detectReviewChanges(previous, observations, config, evaluatedAt, ids, requested);
      detected.notices = [...new Set([...detected.notices, ...resolution.notices])];
      this.database.prepare(`INSERT INTO review_profiles VALUES (?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`)
        .run(config.profileId, evaluatedAt, this.seal(detected.state, JSON.stringify(["review-state", config.profileId])));
      const insertEvent = this.database.prepare("INSERT INTO review_events VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING");
      for (const change of detected.changes) {
        insertEvent.run(config.profileId, change.id, change.detectedAt, change.observedAt,
          this.seal(change, JSON.stringify(["review-event", config.profileId, change.id])));
      }
      const recentSince = new Date(now.getTime() - config.briefing.recentHours * 3_600_000).toISOString();
      const rows = this.database.prepare(`SELECT event_id, payload FROM review_events WHERE profile_id = ?
        AND detected_at >= ? AND detected_at <= ? ORDER BY detected_at, event_id LIMIT 100001`)
        .all(config.profileId, recentSince, evaluatedAt);
      if (rows.length > 100000) throw new ReviewError("Too many review changes in the requested briefing window.");
      const changes = rows.map(row => {
        const value = storedPayload.extend({ event_id: reviewIdSchema }).parse(row);
        return changeEventSchema.parse(this.unseal(value.payload, JSON.stringify(["review-event", config.profileId, value.event_id])));
      });
      const links: ConfirmedReviewLink[] = [];
      for (const source of config.sources) if (source.portal === "canvas" && source.sections.includes("assignments")) {
        for (const link of this.listCanvasAssignmentLinks(source.accountId)) {
          if (!config.sources.some(source => source.portal === "skyward" &&
            source.accountId === link.skywardAccountId && source.sections.includes("assignments"))) continue;
          links.push({
            id: link.id,
            skywardRecordId: reviewRecordId(ids, "skyward", link.skywardAccountId, "assignments",
              link.skywardStudentId, null, link.skywardAssignmentId),
            canvasRecordId: reviewRecordId(ids, "canvas", source.accountId, "assignments",
              link.canvasStudentId, link.canvasCourseId, link.canvasAssignmentId),
          });
        }
      }
      const prioritized = prioritizeReview(detected.state, changes, links, config, now, ids);
      const result = reviewResultSchema.parse({
        version: 1, engineVersion: 1,
        id: ids("review", [evaluatedAt, config, detected.state, changes.map(change => change.id), links]),
        profileId: config.profileId, evaluatedAt, recentSince, timeZone: config.timeZone,
        rules: config.rules, childRules: config.children.map(child => ({ childId: child.id, rules: rulesFor(config, child.id) })),
        ...(config.studentMatching === "unique-full-name" ? { resolvedChildren: config.children } : {}),
        briefingOptions: config.briefing, bootstrap: detected.bootstrap, changes, ...prioritized, notices: detected.notices,
      });
      const existing = this.getReview(config.profileId, result.id);
      if (existing) return existing;
      this.database.prepare("INSERT INTO review_evaluations VALUES (?, ?, ?, ?)").run(config.profileId, result.id, evaluatedAt,
        this.seal(result, JSON.stringify(["review-evaluation", config.profileId, result.id])));
      reportDiagnostic({ level: "info", code: "REVIEW_SUMMARY", stage: "REVIEW_PROCESS",
        status: result.health.some(entry => entry.issues.some(issue => !["lookback-limited", "unread-only"].includes(issue))) ||
          result.notices.length ? "partial" : "complete",
        counts: { scanned: scannedRuns, accepted: detected.changes.length, courses: result.health.length } });
      return result;
    }).immediate();
  }

  getReview(profileId: string, evaluationId?: string): ReviewResult | undefined {
    checkAccount(profileId);
    if (evaluationId) reviewIdSchema.parse(evaluationId);
    const row = evaluationId
      ? this.database.prepare("SELECT evaluation_id, payload FROM review_evaluations WHERE profile_id = ? AND evaluation_id = ?").get(profileId, evaluationId)
      : this.database.prepare(`SELECT evaluation_id, payload FROM review_evaluations WHERE profile_id = ?
        ORDER BY evaluated_at DESC, evaluation_id DESC LIMIT 1`).get(profileId);
    if (!row) return undefined;
    const value = storedPayload.extend({ evaluation_id: reviewIdSchema }).parse(row);
    return reviewResultSchema.parse(this.unseal(value.payload, JSON.stringify(["review-evaluation", profileId, value.evaluation_id])));
  }

  listReviewChanges(profileId: string, options: { since?: string; limit?: number; offset?: number } = {}) {
    checkAccount(profileId);
    const since = options.since === undefined ? "0000-01-01T00:00:00.000Z" : reviewTimestamp.parse(options.since);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    checkLimit(limit);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ReviewError("Invalid review query offset.");
    return this.database.prepare(`SELECT event_id, payload FROM review_events WHERE profile_id = ? AND detected_at >= ?
      ORDER BY detected_at DESC, event_id LIMIT ? OFFSET ?`).all(profileId, since, limit, offset).map(row => {
      const value = storedPayload.extend({ event_id: reviewIdSchema }).parse(row);
      return changeEventSchema.parse(this.unseal(value.payload, JSON.stringify(["review-event", profileId, value.event_id])));
    });
  }

  explainReviewSource(profileId: string, evaluationId: string, sourceId: string) {
    reviewIdSchema.parse(sourceId);
    const result = this.getReview(profileId, evaluationId);
    const evidence = result?.evidence.find(source => source.id === sourceId);
    if (!evidence) throw new ReviewError("The source reference is not part of this saved review.");
    return evidence;
  }
}
