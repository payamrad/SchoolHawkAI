import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canvasAssignmentRunSchema, canvasAssignmentSchema, canvasAssignmentLinkSchema, canvasStudentIdentitySchema, canvasCourseIdentitySchema,
  canvasCourseMappingSchema, storedCanvasCourseMappingSchema, type CanvasAssignmentRun, type CanvasAssignmentLink, type CanvasCourseMapping,
  type StoredCanvasCourseMapping } from "@schoolhawk/core/canvas-assignments";
import { assessAssignmentLinks, assignmentMatchWindow, proposeAssignmentMatches } from "@schoolhawk/core/assignment-correlation";
import { SqliteMessageStore, checkAccount, checkLimit } from "./sqlite-message-store";
import { CanvasMappingError } from "./canvas-assignments";
import type { CanvasAssignmentStore, CanvasRunSummary, CanvasCorrelationProposal, StoredCanvasAssignment, EnrichedAssignment,
  CanvasMatchOptions, CanvasMatchRun, CanvasMatchItem } from "./canvas-assignments";
import type { CanvasMatchReason, StoredAssignment } from "./assignments";
import { checkPrivatePath } from "./private-files";
import { diagnosticStageSchema, reportDiagnostic } from "@schoolhawk/core/diagnostics";

const courseMetadataSchema = z.object({ student: canvasStudentIdentitySchema, course: canvasCourseIdentitySchema });

export async function withWorkspaceDatabase<Result>(root: string, operation: (file: string, key: Buffer) => Result | Promise<Result>,
  onStage: (stage: string) => void = stage => reportDiagnostic({
    level: "info", code: "STAGE_STARTED", section: "storage", stage: diagnosticStageSchema.parse(stage),
  })): Promise<Result> {
  process.umask(0o077);
  const auth = path.join(root, "playwright/.auth");
  const database = path.join(root, "data/database/schoolhawk.sqlite");
  onStage("DATABASE_OPEN");
  for (const directory of [auth, path.join(root, "data"), path.dirname(database)]) checkPrivatePath(directory, true);
  checkPrivatePath(database);
  onStage("PRIVATE_DATABASE_KEY");
  const keyPath = path.join(auth, "messages.key");
  checkPrivatePath(keyPath);
  const key = readFileSync(keyPath);
  try {
    if (key.length !== 32) throw new Error("Invalid encryption key.");
    onStage("DATABASE_OPEN");
    return await operation(database, key);
  } finally { key.fill(0); }
}

export async function withWorkspaceStore<Result>(root: string, operation: (store: SqliteCanvasStore) => Result | Promise<Result>,
  onStage?: (stage: string) => void): Promise<Result> {
  return withWorkspaceDatabase(root, async (file, key) => {
    const store = new SqliteCanvasStore(file, key);
    try { return await operation(store); }
    finally { store.close(); }
  }, onStage);
}

export class SqliteCanvasStore extends SqliteMessageStore implements CanvasAssignmentStore {
  private canvasScope(accountId: string, studentId: string, courseId: string): string {
    return this.hash(JSON.stringify(["canvas-scope", accountId, studentId, courseId]));
  }

  private canvasIdentity(accountId: string, studentId: string, courseId: string, assignmentId: string): string {
    return this.hash(JSON.stringify(["canvas-assignment", accountId, studentId, courseId, assignmentId]));
  }

  private skywardIdentity(accountId: string, studentId: string, assignmentId: string): string {
    return this.hash(JSON.stringify(["assignment", accountId, studentId, assignmentId]));
  }

  private audit(accountId: string, action: string, referenceId: string): void {
    this.database.prepare("INSERT INTO canvas_audit_events(account_id, occurred_at, action, reference_id) VALUES (?, ?, ?, ?)")
      .run(accountId, new Date().toISOString(), action, referenceId);
  }

  importCanvasAssignmentRun(accountId: string, input: unknown): "imported" | "already-imported" {
    checkAccount(accountId);
    const run = canvasAssignmentRunSchema.parse(input);
    const hash = this.hash(JSON.stringify(run));
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT content_hash FROM canvas_assignment_runs WHERE account_id = ? AND run_id = ?")
        .get(accountId, run.runId) as { content_hash: string } | undefined;
      if (existing) {
        if (existing.content_hash !== hash) throw new Error("Conflicting Canvas run contents.");
        return "already-imported" as const;
      }
      this.database.prepare("INSERT INTO canvas_assignment_runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(accountId, run.runId, run.capturedAt,
        run.status, run.students.length, hash, this.seal(run, JSON.stringify(["canvas-run", accountId, run.runId])));
      const insertCourse = this.database.prepare("INSERT INTO canvas_assignment_courses VALUES (?, ?, ?, ?, ?, ?)");
      const insertAssignment = this.database.prepare("INSERT INTO canvas_assignment_observations VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const student of run.students) {
        const studentKey = this.hash(JSON.stringify(["canvas-student", accountId, student.id]));
        for (const course of student.courses) {
          const courseKey = this.canvasScope(accountId, student.id, course.id);
          const metadata = courseMetadataSchema.parse({ student, course });
          insertCourse.run(accountId, run.runId, studentKey, courseKey, course.status,
            this.seal(metadata, JSON.stringify(["canvas-course", accountId, run.runId, studentKey, courseKey])));
          for (const assignment of course.assignments) {
            const assignmentKey = this.canvasIdentity(accountId, student.id, course.id, assignment.id);
            insertAssignment.run(accountId, run.runId, studentKey, courseKey, assignmentKey, assignment.source.capturedAt,
              this.seal(assignment, JSON.stringify(["canvas-assignment", accountId, run.runId, studentKey, courseKey, assignmentKey])));
          }
        }
      }
      this.audit(accountId, "import-run", run.runId);
      return "imported" as const;
    }).immediate();
  }

  getCanvasAssignmentRun(accountId: string, runId: string): CanvasAssignmentRun | undefined {
    checkAccount(accountId);
    const row = this.database.prepare("SELECT payload FROM canvas_assignment_runs WHERE account_id = ? AND run_id = ?")
      .get(accountId, runId) as { payload: Buffer } | undefined;
    return row ? canvasAssignmentRunSchema.parse(this.unseal(row.payload, JSON.stringify(["canvas-run", accountId, runId]))) : undefined;
  }

  listCanvasAssignmentRuns(accountId: string, limit = 100): CanvasRunSummary[] {
    checkAccount(accountId); checkLimit(limit);
    return this.database.prepare(`SELECT run_id AS runId, captured_at AS capturedAt, status, student_count AS studentCount
      FROM canvas_assignment_runs WHERE account_id = ? ORDER BY captured_at DESC, run_id DESC LIMIT ?`).all(accountId, limit) as CanvasRunSummary[];
  }

  listCanvasScopes(accountId: string) {
    checkAccount(accountId);
    const rows = this.database.prepare(`WITH ranked AS (
      SELECT courses.*, runs.captured_at, ROW_NUMBER() OVER (PARTITION BY student_key, course_key ORDER BY runs.captured_at DESC, courses.run_id DESC) AS rank
      FROM canvas_assignment_courses courses JOIN canvas_assignment_runs runs USING(account_id, run_id) WHERE account_id = ?
    ) SELECT * FROM ranked WHERE rank = 1 ORDER BY student_key, course_key LIMIT 1001`).all(accountId) as {
      run_id: string; student_key: string; course_key: string; captured_at: string; status: CanvasAssignmentRun["status"]; payload: Buffer;
    }[];
    if (rows.length > 1000) throw new Error("Canvas scope query limit exceeded.");
    return rows.map(row => ({ ...courseMetadataSchema.parse(this.unseal(row.payload,
      JSON.stringify(["canvas-course", accountId, row.run_id, row.student_key, row.course_key]))),
      status: row.status, capturedAt: row.captured_at, runId: row.run_id }));
  }

  listSkywardAssignmentScopes(accountId: string) {
    const scopes = new Map<string, { student: StoredAssignment["student"]; course: string; section: string | null }>();
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const records = this.listAssignments(accountId, { limit: 1000, offset });
      for (const record of records) scopes.set(JSON.stringify([record.student.id, record.assignment.course, record.assignment.section]), {
        student: record.student, course: record.assignment.course, section: record.assignment.section,
      });
      if (records.length < 1000) return [...scopes.values()];
    }
    throw new Error("Skyward scope query limit exceeded.");
  }

  listCanvasAssignments(accountId: string, options: { studentId?: string; courseId?: string; limit?: number; offset?: number } = {}): StoredCanvasAssignment[] {
    checkAccount(accountId);
    const limit = options.limit ?? 100;
    checkLimit(limit);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (options.courseId && !options.studentId)) throw new Error("Invalid Canvas query scope or offset.");
    const studentKey = options.studentId === undefined ? null : this.hash(JSON.stringify(["canvas-student", accountId, options.studentId]));
    const courseKey = options.courseId === undefined ? null : this.canvasScope(accountId, options.studentId!, options.courseId);
    const rows = this.database.prepare(`WITH ranked AS (
      SELECT observations.*, courses.payload AS course_payload, ROW_NUMBER() OVER (
        PARTITION BY observations.student_key, observations.course_key, observations.assignment_key
        ORDER BY observations.observed_at DESC, runs.captured_at DESC, observations.run_id DESC
      ) AS rank,
      MIN(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.course_key, observations.assignment_key) AS first_seen,
      MAX(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.course_key, observations.assignment_key) AS last_seen
      FROM canvas_assignment_observations observations JOIN canvas_assignment_courses courses USING(account_id, run_id, student_key, course_key)
      JOIN canvas_assignment_runs runs USING(account_id, run_id)
      WHERE observations.account_id = ? AND courses.status = 'complete'
        AND (? IS NULL OR observations.student_key = ?) AND (? IS NULL OR observations.course_key = ?)
    ) SELECT * FROM ranked WHERE rank = 1 ORDER BY student_key, course_key, assignment_key LIMIT ? OFFSET ?`)
      .all(accountId, studentKey, studentKey, courseKey, courseKey, limit, offset) as {
        run_id: string; student_key: string; course_key: string; assignment_key: string; payload: Buffer; course_payload: Buffer; first_seen: string; last_seen: string;
      }[];
    return rows.map(row => ({
      ...courseMetadataSchema.parse(this.unseal(row.course_payload, JSON.stringify(["canvas-course", accountId, row.run_id, row.student_key, row.course_key]))),
      assignment: canvasAssignmentSchema.parse(this.unseal(row.payload, JSON.stringify(["canvas-assignment", accountId, row.run_id, row.student_key, row.course_key, row.assignment_key]))),
      runId: row.run_id, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen,
    }));
  }

  private completeCanvasCourse(accountId: string, studentId: string, courseId: string) {
    const key = this.canvasScope(accountId, studentId, courseId);
    const row = this.database.prepare(`SELECT courses.run_id FROM canvas_assignment_courses courses JOIN canvas_assignment_runs runs USING(account_id, run_id)
      WHERE courses.account_id = ? AND courses.course_key = ? AND courses.status = 'complete'
      ORDER BY runs.captured_at DESC, courses.run_id DESC LIMIT 1`).get(accountId, key) as { run_id: string } | undefined;
    if (!row) throw new Error("No complete Canvas course snapshot. Collect Canvas assignments first.");
    const run = this.getCanvasAssignmentRun(accountId, row.run_id)!;
    const student = run.students.find(student => student.id === studentId)!;
    return { run, student, course: student.courses.find(course => course.id === courseId)! };
  }

  private skywardScope(mapping: CanvasCourseMapping): StoredAssignment[] {
    const result: StoredAssignment[] = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const records = this.listAssignments(mapping.skywardAccountId, { studentId: mapping.skywardStudentId, limit: 1000, offset });
      result.push(...records.filter(record => record.assignment.course === mapping.skywardCourse && record.assignment.section === mapping.skywardSection));
      if (records.length < 1000) return result;
    }
    throw new Error("Skyward correlation scope exceeds the safety limit.");
  }

  saveCanvasCourseMapping(accountId: string, input: CanvasCourseMapping): StoredCanvasCourseMapping {
    checkAccount(accountId);
    const mapping = canvasCourseMappingSchema.parse(input);
    return this.database.transaction(() => {
      const existing = this.listCanvasCourseMappings(accountId);
      for (const previous of existing) {
        if (previous.canvasStudentId === mapping.canvasStudentId && previous.canvasCourseId === mapping.canvasCourseId) {
          if (JSON.stringify(canvasCourseMappingSchema.parse(previous)) !== JSON.stringify(mapping)) throw new Error("Conflicting course mapping; existing mapping was preserved.");
          return previous;
        }
        if ((previous.canvasStudentId === mapping.canvasStudentId && (previous.skywardStudentId !== mapping.skywardStudentId || previous.skywardAccountId !== mapping.skywardAccountId)) ||
            (previous.skywardAccountId === mapping.skywardAccountId && previous.skywardStudentId === mapping.skywardStudentId && previous.canvasStudentId !== mapping.canvasStudentId)) {
          throw new Error("Conflicting student mapping; no records were merged.");
        }
      }
      this.completeCanvasCourse(accountId, mapping.canvasStudentId, mapping.canvasCourseId);
      if (!this.skywardScope(mapping).length) throw new Error("No complete Skyward assignments in that exact student/course/section scope.");
      const stored = { ...mapping, id: randomUUID(), confirmedAt: new Date().toISOString() };
      this.database.prepare("INSERT INTO canvas_course_mappings VALUES (?, ?, ?, ?)").run(accountId, stored.id,
        this.canvasScope(accountId, mapping.canvasStudentId, mapping.canvasCourseId), this.seal(stored, JSON.stringify(["canvas-mapping", accountId, stored.id])));
      this.audit(accountId, "confirm-course", stored.id);
      return stored;
    }).immediate();
  }

  listCanvasCourseMappings(accountId: string): StoredCanvasCourseMapping[] {
    checkAccount(accountId);
    const rows = this.database.prepare("SELECT mapping_id, payload FROM canvas_course_mappings WHERE account_id = ? ORDER BY mapping_id LIMIT 1001")
      .all(accountId) as { mapping_id: string; payload: Buffer }[];
    if (rows.length > 1000) throw new Error("Mapping query limit exceeded.");
    return rows.map(row => storedCanvasCourseMappingSchema.parse(this.unseal(row.payload, JSON.stringify(["canvas-mapping", accountId, row.mapping_id]))));
  }

  private mapping(accountId: string, mappingId: string): StoredCanvasCourseMapping {
    const mapping = this.listCanvasCourseMappings(accountId).find(mapping => mapping.id === mappingId);
    if (!mapping) throw new Error("No course mapping for this account.");
    return mapping;
  }

  proposeCanvasAssignmentLinks(accountId: string, mappingId: string): CanvasCorrelationProposal[] {
    checkAccount(accountId);
    const mapping = this.mapping(accountId, mappingId);
    const current = this.completeCanvasCourse(accountId, mapping.canvasStudentId, mapping.canvasCourseId);
    const skyward = this.skywardScope(mapping);
    const matches = proposeAssignmentMatches(skyward.map(record => record.assignment), current.course.assignments);
    const links = this.listCanvasAssignmentLinks(accountId);
    return matches.map(match => {
      const assignment = current.course.assignments.find(assignment => assignment.id === match.canvasAssignmentId)!;
      const linked = links.find(link => link.mappingId === mappingId && link.canvasAssignmentId === assignment.id);
      const candidates = match.candidates.map(candidate => {
        const source = skyward.find(record => record.assignment.id === candidate.skywardAssignmentId)!;
        const alreadyLinked = this.database.prepare("SELECT link_id FROM canvas_assignment_links WHERE skyward_account_id = ? AND skyward_key = ?")
          .get(mapping.skywardAccountId, this.skywardIdentity(mapping.skywardAccountId, mapping.skywardStudentId, source.assignment.id));
        return { ...candidate, title: source.assignment.title, dueDate: source.assignment.dueDate, skywardRunId: source.runId,
          confirmationKey: match.status === "candidate" && !alreadyLinked && !linked ? this.hash(JSON.stringify([
            "canvas-proposal", accountId, mappingId, assignment.id, source.assignment.id, current.run.runId, source.runId,
          ])) : undefined };
      });
      return { canvasAssignmentId: assignment.id, title: assignment.title, dueDate: assignment.dueDate, canvasRunId: current.run.runId,
        status: linked ? "linked" as const : match.status === "candidate" && !candidates[0]?.confirmationKey ? "ambiguous" as const : match.status,
        linkId: linked?.id, candidates };
    });
  }

  confirmCanvasAssignmentLink(accountId: string, mappingId: string, confirmationKey: string): CanvasAssignmentLink {
    checkAccount(accountId);
    if (!/^[a-f0-9]{64}$/.test(confirmationKey)) throw new Error("Invalid confirmation key.");
    return this.database.transaction(() => {
      const previous = this.listCanvasAssignmentLinks(accountId).find(link => link.mappingId === mappingId && link.confirmationKey === confirmationKey);
      if (previous) return previous;
      const mapping = this.mapping(accountId, mappingId);
      const proposal = this.proposeCanvasAssignmentLinks(accountId, mappingId).find(proposal => proposal.status === "candidate" &&
        proposal.candidates[0]?.confirmationKey === confirmationKey);
      if (!proposal) throw new Error("Proposal is stale, ambiguous, or already linked. Review current matches before confirming.");
      const candidate = proposal.candidates[0];
      const link = canvasAssignmentLinkSchema.parse({ id: randomUUID(), mappingId, canvasStudentId: mapping.canvasStudentId,
        canvasCourseId: mapping.canvasCourseId, canvasAssignmentId: proposal.canvasAssignmentId, skywardAccountId: mapping.skywardAccountId,
        skywardStudentId: mapping.skywardStudentId, skywardAssignmentId: candidate.skywardAssignmentId,
        confirmedAt: new Date().toISOString(), method: candidate.method, confirmationKey,
        evidence: { canvasRunId: proposal.canvasRunId, skywardRunId: candidate.skywardRunId, canvasTitle: proposal.title,
          skywardTitle: candidate.title, canvasDueDate: proposal.dueDate, skywardDueDate: candidate.dueDate } });
      this.database.prepare("INSERT INTO canvas_assignment_links VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(accountId, link.id, mappingId,
        this.canvasIdentity(accountId, link.canvasStudentId, link.canvasCourseId, link.canvasAssignmentId), link.skywardAccountId,
        this.skywardIdentity(link.skywardAccountId, link.skywardStudentId, link.skywardAssignmentId), proposal.canvasRunId, candidate.skywardRunId,
        this.seal(link, JSON.stringify(["canvas-link", accountId, link.id])));
      this.audit(accountId, "confirm-assignment", link.id);
      return link;
    }).immediate();
  }

  listCanvasAssignmentLinks(accountId: string): CanvasAssignmentLink[] {
    checkAccount(accountId);
    const rows = this.database.prepare("SELECT link_id, payload FROM canvas_assignment_links WHERE account_id = ? ORDER BY link_id LIMIT 10001")
      .all(accountId) as { link_id: string; payload: Buffer }[];
    if (rows.length > 10000) throw new Error("Link query limit exceeded.");
    return rows.map(row => canvasAssignmentLinkSchema.parse(this.unseal(row.payload, JSON.stringify(["canvas-link", accountId, row.link_id]))));
  }

  matchCanvasAssignments(accountId: string, options: CanvasMatchOptions): CanvasMatchRun {
    checkAccount(accountId);
    const now = options.now ?? new Date();
    const window = assignmentMatchWindow(options.lookbackDays, now);
    const maxSourceAgeHours = options.maxSourceAgeHours ?? 48;
    if (!Number.isInteger(maxSourceAgeHours) || maxSourceAgeHours < 1 || maxSourceAgeHours > 168 ||
        (options.dryRun !== undefined && typeof options.dryRun !== "boolean") ||
        (options.mappingId !== undefined && !z.uuid().safeParse(options.mappingId).success)) throw new Error("Invalid matching options.");
    return this.database.transaction(() => {
      const allMappings = this.listCanvasCourseMappings(accountId);
      const mappings = options.mappingId === undefined ? allMappings : allMappings.filter(mapping => mapping.id === options.mappingId);
      if (!mappings.length) throw new CanvasMappingError(options.mappingId === undefined ? "NO_COURSE_MAPPINGS" : "COURSE_MAPPING_NOT_FOUND");
      const result: CanvasMatchRun = { runId: randomUUID(), matcherVersion: 1, accountId, attemptedAt: now.toISOString(), window,
        dryRun: options.dryRun ?? false, maxSourceAgeHours, mappingCount: mappings.length,
        outsideWindow: 0, undated: 0, linked: 0, wouldLink: 0, alreadyLinked: 0, unmatched: 0, reviewRequired: 0, items: [] };
      const latestCanvasSummary = this.listCanvasAssignmentRuns(accountId, 1)[0];
      const latestCanvas = latestCanvasSummary ? this.getCanvasAssignmentRun(accountId, latestCanvasSummary.runId) : undefined;
      const latestSkyward = new Map<string, ReturnType<SqliteMessageStore["getAssignmentRun"]>>();
      const stale = (capturedAt: string) => {
        const age = now.getTime() - Date.parse(capturedAt);
        return !Number.isFinite(age) || age > maxSourceAgeHours * 3_600_000 || age < -300_000;
      };
      for (const mapping of mappings) {
        if (!latestSkyward.has(mapping.skywardAccountId)) {
          const summary = this.listAssignmentRuns(mapping.skywardAccountId, 1)[0];
          latestSkyward.set(mapping.skywardAccountId, summary ? this.getAssignmentRun(mapping.skywardAccountId, summary.runId) : undefined);
        }
        const skywardRun = latestSkyward.get(mapping.skywardAccountId);
        const skywardStudent = skywardRun?.students.find(student => student.id === mapping.skywardStudentId);
        const canvasStudent = latestCanvas?.students.find(student => student.id === mapping.canvasStudentId);
        const canvasCourse = canvasStudent?.courses.find(course => course.id === mapping.canvasCourseId);
        const skyward = this.skywardScope(mapping);
        const assessments = new Map(assessAssignmentLinks(skyward.map(record => record.assignment), canvasCourse?.assignments ?? [])
          .map(assessment => [assessment.skywardAssignmentId, assessment]));
        const scopeConflict = allMappings.some(other => other.id !== mapping.id && other.skywardAccountId === mapping.skywardAccountId &&
          other.skywardStudentId === mapping.skywardStudentId && other.skywardCourse === mapping.skywardCourse && other.skywardSection === mapping.skywardSection);
        let scopeReason: CanvasMatchReason | null = scopeConflict ? "scope-conflict" : null;
        if (!scopeReason && (!latestCanvas?.discoveryComplete || !canvasStudent?.discoveryComplete || canvasCourse?.status !== "complete" ||
            !skywardRun?.discoveryComplete || !skywardStudent || skywardStudent.sections.some(section => section.status !== "complete"))) {
          scopeReason = "source-incomplete";
        }
        if (!scopeReason && (stale(latestCanvas!.capturedAt) || stale(skywardRun!.capturedAt))) scopeReason = "source-stale";
        const proposals = scopeReason ? [] : this.proposeCanvasAssignmentLinks(accountId, mapping.id);
        for (const record of skyward) {
          const dueDate = record.assignment.dueDate;
          if (!dueDate) { result.undated++; continue; }
          if (dueDate < window.startDate || dueDate > window.endDate) { result.outsideWindow++; continue; }
          if (result.items.length >= 100_000) throw new Error("Matching exceeds the bounded assignment limit.");
          const assessment = assessments.get(record.assignment.id)!;
          const item: CanvasMatchItem = { mappingId: mapping.id, skywardAccountId: mapping.skywardAccountId,
            skywardStudentId: mapping.skywardStudentId, skywardAssignmentId: record.assignment.id, dueDate,
            skywardObservationRunId: record.runId, latestSkywardRunId: skywardRun?.runId ?? null, latestCanvasRunId: latestCanvas?.runId ?? null,
            status: "unmatched", reason: null, candidateIds: assessment.candidates.map(candidate => candidate.canvasAssignmentId) };
          result.items.push(item);
          if (record.canvasStatus === "linked") {
            item.status = "already-linked"; item.linkId = record.canvasLinkId!; result.alreadyLinked++;
            continue;
          }
          const observed = skywardStudent?.sections.some(section => section.status === "complete" &&
            section.assignments.some(assignment => assignment.id === record.assignment.id));
          const reason = scopeReason ?? (record.runId !== skywardRun?.runId || !observed ? "not-observed" : assessment.reason);
          if (reason) {
            item.status = "review-required"; item.reason = reason;
          } else if (assessment.status === "candidate") {
            const candidate = assessment.candidates[0];
            const proposal = proposals.find(proposal => proposal.canvasAssignmentId === candidate.canvasAssignmentId);
            const token = proposal?.status === "candidate" ? proposal.candidates.find(candidate => candidate.skywardAssignmentId === record.assignment.id)?.confirmationKey : undefined;
            if (!token) {
              item.status = "review-required"; item.reason = "already-linked";
            } else {
              item.canvasAssignmentId = candidate.canvasAssignmentId;
              if (result.dryRun) { item.status = "would-link"; result.wouldLink++; }
              else {
                const link = this.confirmCanvasAssignmentLink(accountId, mapping.id, token);
                item.status = "linked"; item.linkId = link.id; result.linked++;
              }
            }
          }
          if (item.status === "unmatched") result.unmatched++;
          if (item.status === "review-required") result.reviewRequired++;
          if (!result.dryRun) {
            const identity = this.skywardIdentity(mapping.skywardAccountId, mapping.skywardStudentId, record.assignment.id);
            if (item.status !== "linked") {
              this.database.prepare(`UPDATE skyward_assignments SET canvas_status = ?, match_reason = ?
                WHERE account_id = ? AND assignment_key = ? AND canvas_status <> 'linked'`)
                .run(item.status, item.reason, mapping.skywardAccountId, identity);
            }
            this.database.prepare(`UPDATE skyward_assignments SET last_match_at = ?, match_attempts = match_attempts + 1
              WHERE account_id = ? AND assignment_key = ?`).run(result.attemptedAt, mapping.skywardAccountId, identity);
          }
        }
      }
      if (!result.dryRun) {
        this.database.prepare("INSERT INTO canvas_match_runs VALUES (?, ?, ?, ?, ?)").run(accountId, result.runId,
          result.attemptedAt, window.days, this.seal(result, JSON.stringify(["canvas-match-run", accountId, result.runId])));
      }
      return result;
    }).immediate();
  }

  getCanvasMatchRun(accountId: string, runId: string): CanvasMatchRun | undefined {
    checkAccount(accountId);
    const row = this.database.prepare("SELECT payload FROM canvas_match_runs WHERE account_id = ? AND match_run_id = ?")
      .get(accountId, runId) as { payload: Buffer } | undefined;
    return row ? this.unseal(row.payload, JSON.stringify(["canvas-match-run", accountId, runId])) as CanvasMatchRun : undefined;
  }

  listEnrichedAssignments(accountId: string, options: { studentId?: string; limit?: number; offset?: number } = {}): EnrichedAssignment[] {
    const latestRuns = new Map<string, CanvasAssignmentRun | undefined>();
    const scopes = new Map<string, StoredCanvasAssignment[]>();
    const skywardSummary = this.listAssignmentRuns(accountId, 1)[0];
    const skywardRun = skywardSummary ? this.getAssignmentRun(accountId, skywardSummary.runId) : undefined;
    return this.listAssignments(accountId, options).map(record => {
      const section = skywardRun?.students.find(student => student.id === record.student.id)?.sections.find(section => section.kind === record.section);
      const skyward: EnrichedAssignment["skyward"] = { latestCollection: skywardSummary, scopeStatus: section?.status ?? "not-observed",
        observedInLatestCollection: record.runId === skywardRun?.runId && section?.status === "complete" &&
          section.assignments.some(assignment => assignment.id === record.assignment.id) };
      if (record.canvasStatus !== "linked") return { ...record, skyward, canvas: null };
      const row = this.database.prepare(`SELECT account_id, link_id, payload FROM canvas_assignment_links
        WHERE account_id = ? AND link_id = ? AND canvas_key = ? AND skyward_account_id = ? AND skyward_key = ?`)
        .get(record.canvasAccountId, record.canvasLinkId, record.canvasRecordId, accountId,
          this.skywardIdentity(accountId, record.student.id, record.assignment.id)) as { account_id: string; link_id: string; payload: Buffer } | undefined;
      if (!row) throw new Error("Confirmed assignment foreign key is unavailable.");
      const link = canvasAssignmentLinkSchema.parse(this.unseal(row.payload, JSON.stringify(["canvas-link", row.account_id, row.link_id])));
      const scopeKey = this.canvasScope(row.account_id, link.canvasStudentId, link.canvasCourseId);
      if (!scopes.has(scopeKey)) {
        const collected: StoredCanvasAssignment[] = [];
        for (let offset = 0; offset < 100_000; offset += 1000) {
          const records = this.listCanvasAssignments(row.account_id, { studentId: link.canvasStudentId, courseId: link.canvasCourseId, limit: 1000, offset });
          collected.push(...records);
          if (records.length < 1000) break;
          if (offset === 99_000) throw new Error("Canvas enrichment query limit exceeded.");
        }
        scopes.set(scopeKey, collected);
      }
      const canvasRecord = scopes.get(scopeKey)!.find(candidate => candidate.assignment.id === link.canvasAssignmentId);
      if (!canvasRecord) throw new Error("Confirmed Canvas observation is unavailable.");
      if (!latestRuns.has(row.account_id)) {
        const summary = this.listCanvasAssignmentRuns(row.account_id, 1)[0];
        latestRuns.set(row.account_id, summary ? this.getCanvasAssignmentRun(row.account_id, summary.runId) : undefined);
      }
      const latest = latestRuns.get(row.account_id);
      const course = latest?.students.find(student => student.id === link.canvasStudentId)?.courses.find(course => course.id === link.canvasCourseId);
      const conflicts: NonNullable<EnrichedAssignment["canvas"]>["conflicts"] = [];
      if (record.assignment.dueDate && canvasRecord.assignment.dueDate && record.assignment.dueDate !== canvasRecord.assignment.dueDate) conflicts.push("due-date");
      const maxScore = record.assignment.maxScore?.trim();
      if (maxScore && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(maxScore) && Number.isFinite(Number(maxScore)) &&
          canvasRecord.assignment.pointsPossible !== null && Number(maxScore) !== canvasRecord.assignment.pointsPossible) conflicts.push("possible-points");
      return { ...record, skyward, canvas: { record: canvasRecord, link, conflicts,
        latestCollection: latest ? { runId: latest.runId, capturedAt: latest.capturedAt, status: latest.status, studentCount: latest.students.length } : undefined,
        scopeStatus: course?.status ?? "not-observed", observedInLatestCollection: canvasRecord.runId === latest?.runId &&
          course?.status === "complete" && course.assignments.some(assignment => assignment.id === link.canvasAssignmentId) } };
    });
  }
}