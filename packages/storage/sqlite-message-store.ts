import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectedMessageSchema, messageRunSchema, type MessageRun } from "@schoolhawk/core/messages";
import { assignmentRunSchema, assignmentSchema, assignmentStudentIdentitySchema, type AssignmentRun } from "@schoolhawk/core/assignments";
import { gradeRecordSchema, gradeRunSchema, type GradeRun } from "@schoolhawk/core/grades";
import type { GradeRunSummary, GradeStore, StoredGrade } from "./grades";
import type { AssignmentRunSummary, AssignmentStore, StoredAssignment } from "./assignments";
import type { MessageStore, RunSummary, StoredMessage, TruncateOptions, TruncateResult } from "./messages";
import { prepareDatabaseFile } from "./private-files";

export function checkAccount(accountId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)) throw new Error("Use a non-sensitive account alias containing letters, digits, underscores, or hyphens.");
}

export function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Query limit must be between 1 and 1000.");
}

export class SqliteMessageStore implements MessageStore, AssignmentStore, GradeStore {
  protected readonly database: Database.Database;
  private readonly key: Buffer;

  constructor(filePath: string, key: Buffer) {
    if (key.length !== 32) throw new Error("Storage requires a 32-byte key.");
    this.key = Buffer.from(key);
    if (filePath !== ":memory:") prepareDatabaseFile(filePath);
    this.database = new Database(filePath);
    try {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.database.transaction(() => {
        const version = this.database.pragma("user_version", { simple: true });
        if (typeof version !== "number" || ![0, 1, 2, 3, 4, 5, 6].includes(version)) throw new Error("Unsupported database schema version.");
        if (version === 0) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/001-messages.sql"), "utf8"));
          this.database.prepare("INSERT INTO storage_settings VALUES ('key-check', ?)").run(this.hash("schoolhawk-message-storage-v1"));
          this.database.pragma("user_version = 1");
        }
        const setting = this.database.prepare("SELECT value FROM storage_settings WHERE name = 'key-check'").get() as { value: string } | undefined;
        if (setting?.value !== this.hash("schoolhawk-message-storage-v1")) throw new Error("Incorrect storage key.");
        if (version < 2) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/002-truncate.sql"), "utf8"));
          this.database.pragma("user_version = 2");
        }
        if (version < 3) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/003-assignments.sql"), "utf8"));
          this.database.pragma("user_version = 3");
        }
        if (version < 4) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/004-grades.sql"), "utf8"));
          this.database.pragma("user_version = 4");
        }
        if (version < 5) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/005-canvas-assignments.sql"), "utf8"));
          this.database.pragma("user_version = 5");
        }
        if (version < 6) {
          this.database.exec(readFileSync(path.join(__dirname, "migrations/006-assignment-link-status.sql"), "utf8"));
          this.database.pragma("user_version = 6");
        }
      }).immediate();
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
    } catch (error) {
      this.database.close();
      this.key.fill(0);
      throw error;
    }
  }

  protected hash(text: string): string {
    return createHmac("sha256", this.key).update(text).digest("hex");
  }

  protected seal(value: unknown, identity: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(identity));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  protected unseal(payload: Buffer, identity: string): unknown {
    const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"));
  }

  importRun(accountId: string, input: unknown): "imported" | "already-imported" {
    checkAccount(accountId);
    const run = messageRunSchema.parse(input);
    run.selection ??= "all";
    const hash = this.hash(JSON.stringify(run));
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT content_hash FROM collection_runs WHERE account_id = ? AND run_id = ?").get(accountId, run.runId) as { content_hash: string } | undefined;
      if (existing) {
        if (existing.content_hash !== hash) throw new Error("Conflicting contents for an existing run ID.");
        return "already-imported" as const;
      }
      const { messages, ...metadata } = run;
      this.database.prepare(`INSERT INTO collection_runs
        (account_id, run_id, portal_id, captured_at, status, selection, start_date, end_date, message_count, scanned_count, content_hash, payload)
        VALUES (?, ?, 'skyward', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        accountId, run.runId, run.capturedAt, run.status, run.selection, run.window.startDate, run.window.endDate,
        messages.length, run.scannedCount, hash, this.seal(metadata, JSON.stringify([accountId, run.runId])),
      );
      const insert = this.database.prepare("INSERT INTO message_observations VALUES (?, ?, ?, ?, ?, ?, ?)");
      messages.forEach((message, ordinal) => insert.run(accountId, run.runId, message.id, ordinal, message.sentDate,
        message.source.capturedAt, this.seal(message, JSON.stringify([accountId, run.runId, message.id]))));
      this.database.prepare("INSERT INTO audit_events(account_id, run_id, imported_at, action) VALUES (?, ?, ?, 'import-run')")
        .run(accountId, run.runId, new Date().toISOString());
      return "imported" as const;
    }).immediate();
  }

  getRun(accountId: string, runId: string): MessageRun | undefined {
    checkAccount(accountId);
    const row = this.database.prepare("SELECT payload FROM collection_runs WHERE account_id = ? AND run_id = ?").get(accountId, runId) as { payload: Buffer } | undefined;
    if (!row) return undefined;
    const metadata = this.unseal(row.payload, JSON.stringify([accountId, runId])) as object;
    const observations = this.database.prepare("SELECT message_id, payload FROM message_observations WHERE account_id = ? AND run_id = ? ORDER BY ordinal")
      .all(accountId, runId) as { message_id: string; payload: Buffer }[];
    return messageRunSchema.parse({ ...metadata, messages: observations.map(message =>
      this.unseal(message.payload, JSON.stringify([accountId, runId, message.message_id]))) });
  }

  listRuns(accountId: string, limit = 100): RunSummary[] {
    checkAccount(accountId);
    checkLimit(limit);
    return this.database.prepare(`SELECT run_id AS runId, captured_at AS capturedAt, status, selection,
      start_date AS startDate, end_date AS endDate, message_count AS messageCount,
      removed_message_count AS removedMessageCount, scanned_count AS scannedCount
      FROM collection_runs WHERE account_id = ? ORDER BY captured_at DESC, run_id DESC LIMIT ?`)
      .all(accountId, limit) as RunSummary[];
  }

  listMessages(accountId: string, options: { since?: string; limit?: number } = {}): StoredMessage[] {
    checkAccount(accountId);
    const since = options.since ?? "0000-01-01";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since) throw new Error("Invalid query date.");
    const limit = options.limit ?? 100;
    checkLimit(limit);
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT observations.*, ROW_NUMBER() OVER (
          PARTITION BY observations.message_id ORDER BY observations.observed_at DESC, runs.captured_at DESC, observations.run_id DESC
        ) AS rank,
        MIN(observations.observed_at) OVER (PARTITION BY observations.message_id) AS first_seen,
        MAX(observations.observed_at) OVER (PARTITION BY observations.message_id) AS last_seen
        FROM message_observations observations JOIN collection_runs runs
          ON observations.account_id = runs.account_id AND observations.run_id = runs.run_id
        WHERE observations.account_id = ? AND runs.status = 'complete'
      )
      SELECT * FROM ranked WHERE rank = 1 AND sent_date >= ? ORDER BY sent_date DESC, message_id LIMIT ?
    `).all(accountId, since, limit) as { run_id: string; message_id: string; payload: Buffer; first_seen: string; last_seen: string }[];
    return rows.map(row => ({
      message: collectedMessageSchema.parse(this.unseal(row.payload, JSON.stringify([accountId, row.run_id, row.message_id]))),
      runId: row.run_id, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen,
    }));
  }

  truncateMessages(accountId: string, options: TruncateOptions): TruncateResult {
    checkAccount(accountId);
    if (options.target !== "LoginNotification" ||
        (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) throw new Error("Unsupported truncation options.");
    return this.database.transaction(() => {
      const identities = new Set<string>();
      const select = this.database.prepare("SELECT run_id, message_id, payload FROM message_observations WHERE account_id = ?");
      for (const row of select.iterate(accountId) as Iterable<{ run_id: string; message_id: string; payload: Buffer }>) {
        const message = collectedMessageSchema.parse(this.unseal(row.payload, JSON.stringify([accountId, row.run_id, row.message_id])));
        if (message.subject.includes("New Login Device Detected") &&
          message.sender === "LAKE WASHINGTON SCHOOL DIST (No Reply)") identities.add(row.message_id);
      }
      const affectedRuns = new Map<string, number>();
      const findRuns = this.database.prepare("SELECT run_id FROM message_observations WHERE account_id = ? AND message_id = ?");
      for (const messageId of identities) {
        for (const row of findRuns.all(accountId, messageId) as { run_id: string }[]) {
          affectedRuns.set(row.run_id, (affectedRuns.get(row.run_id) ?? 0) + 1);
        }
      }
      const result: TruncateResult = {
        target: options.target, dryRun: options.dryRun ?? false, messages: identities.size,
        observations: [...affectedRuns.values()].reduce((total, count) => total + count, 0), runs: affectedRuns.size,
      };
      if (result.dryRun || result.messages === 0) return result;
      const remove = this.database.prepare("DELETE FROM message_observations WHERE account_id = ? AND message_id = ?");
      for (const messageId of identities) remove.run(accountId, messageId);
      const update = this.database.prepare(`UPDATE collection_runs SET message_count = ?,
        removed_message_count = removed_message_count + ?, content_hash = ? WHERE account_id = ? AND run_id = ?`);
      for (const [runId, removed] of affectedRuns) {
        const retained = this.getRun(accountId, runId)!;
        update.run(retained.messages.length, removed, this.hash(JSON.stringify(retained)), accountId, runId);
      }
      this.database.prepare(`INSERT INTO cleanup_events
        (account_id, occurred_at, target, message_count, observation_count, run_count) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(accountId, new Date().toISOString(), result.target, result.messages, result.observations, result.runs);
      return result;
    }).immediate();
  }

  importAssignmentRun(accountId: string, input: unknown): "imported" | "already-imported" {
    checkAccount(accountId);
    const run = assignmentRunSchema.parse(input);
    const hash = this.hash(JSON.stringify(run));
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT content_hash FROM assignment_runs WHERE account_id = ? AND run_id = ?")
        .get(accountId, run.runId) as { content_hash: string } | undefined;
      if (existing) {
        if (existing.content_hash !== hash) throw new Error("Conflicting contents for an existing assignment run ID.");
        return "already-imported" as const;
      }
      this.database.prepare("INSERT INTO assignment_runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        accountId, run.runId, run.capturedAt, run.status, run.students.length, hash,
        this.seal(run, JSON.stringify(["assignment-run", accountId, run.runId])),
      );
      const insertSection = this.database.prepare("INSERT INTO assignment_sections VALUES (?, ?, ?, ?, ?)");
      const insertObservation = this.database.prepare("INSERT INTO assignment_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const student of run.students) {
        const studentKey = this.hash(JSON.stringify(["student", accountId, student.id]));
        const studentIdentity = assignmentStudentIdentitySchema.parse(student);
        for (const section of student.sections) {
          insertSection.run(accountId, run.runId, studentKey, section.kind, section.status);
          for (const assignment of section.assignments) {
            const assignmentKey = this.hash(JSON.stringify(["assignment", accountId, student.id, assignment.id]));
            insertObservation.run(accountId, run.runId, studentKey, section.kind, assignmentKey,
              assignment.source.capturedAt, assignment.dueDate,
              this.seal({ student: studentIdentity, assignment },
                JSON.stringify(["assignment", accountId, run.runId, studentKey, section.kind, assignmentKey])));
          }
        }
      }
      this.database.prepare("INSERT INTO assignment_import_events(account_id, run_id, imported_at) VALUES (?, ?, ?)")
        .run(accountId, run.runId, new Date().toISOString());
      return "imported" as const;
    }).immediate();
  }

  getAssignmentRun(accountId: string, runId: string): AssignmentRun | undefined {
    checkAccount(accountId);
    const row = this.database.prepare("SELECT payload FROM assignment_runs WHERE account_id = ? AND run_id = ?")
      .get(accountId, runId) as { payload: Buffer } | undefined;
    return row ? assignmentRunSchema.parse(this.unseal(row.payload, JSON.stringify(["assignment-run", accountId, runId]))) : undefined;
  }

  listAssignmentRuns(accountId: string, limit = 100): AssignmentRunSummary[] {
    checkAccount(accountId);
    checkLimit(limit);
    return this.database.prepare(`SELECT run_id AS runId, captured_at AS capturedAt, status, student_count AS studentCount
      FROM assignment_runs WHERE account_id = ? ORDER BY captured_at DESC, run_id DESC LIMIT ?`)
      .all(accountId, limit) as AssignmentRunSummary[];
  }

  listAssignments(accountId: string, options: { studentId?: string; limit?: number; offset?: number } = {}): StoredAssignment[] {
    checkAccount(accountId);
    const limit = options.limit ?? 100;
    checkLimit(limit);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid assignment query offset.");
    const studentKey = options.studentId === undefined ? null : this.hash(JSON.stringify(["student", accountId, options.studentId]));
    const rows = this.database.prepare(`WITH ranked AS (
      SELECT observations.*, ROW_NUMBER() OVER (
        PARTITION BY observations.student_key, observations.assignment_key
        ORDER BY observations.observed_at DESC, runs.captured_at DESC, observations.run_id DESC,
          CASE observations.kind WHEN 'missing' THEN 0 WHEN 'past' THEN 1 ELSE 2 END
      ) AS rank,
      MIN(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.assignment_key) AS first_seen,
      MAX(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.assignment_key) AS last_seen
      FROM assignment_observations observations JOIN assignment_sections sections
        USING(account_id, run_id, student_key, kind)
      JOIN assignment_runs runs USING(account_id, run_id)
      WHERE observations.account_id = ? AND sections.status = 'complete' AND (? IS NULL OR observations.student_key = ?)
    ) SELECT ranked.*, identities.canvas_status, identities.canvas_account_id, identities.canvas_record_id,
      identities.canvas_link_id, identities.match_reason, identities.last_match_at, identities.match_attempts
      FROM ranked JOIN skyward_assignments identities USING(account_id, assignment_key)
      WHERE rank = 1 ORDER BY due_date, ranked.student_key, assignment_key LIMIT ? OFFSET ?`)
      .all(accountId, studentKey, studentKey, limit, offset) as {
        run_id: string; student_key: string; assignment_key: string; kind: StoredAssignment["section"];
        payload: Buffer; first_seen: string; last_seen: string;
        canvas_status: StoredAssignment["canvasStatus"]; canvas_account_id: string | null; canvas_record_id: string | null;
        canvas_link_id: string | null; match_reason: StoredAssignment["canvasMatchReason"]; last_match_at: string | null; match_attempts: number;
      }[];
    return rows.map(row => {
      const value = this.unseal(row.payload, JSON.stringify(["assignment", accountId, row.run_id, row.student_key, row.kind, row.assignment_key])) as {
        student: StoredAssignment["student"]; assignment: unknown;
      };
      return { student: assignmentStudentIdentitySchema.parse(value.student), assignment: assignmentSchema.parse(value.assignment), section: row.kind,
        runId: row.run_id, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen,
        canvasStatus: row.canvas_status, canvasAccountId: row.canvas_account_id, canvasRecordId: row.canvas_record_id,
        canvasLinkId: row.canvas_link_id, canvasMatchReason: row.match_reason, lastMatchAttemptAt: row.last_match_at, matchAttempts: row.match_attempts };
    });
  }

  importGradeRun(accountId: string, input: unknown): "imported" | "already-imported" {
    checkAccount(accountId);
    const run = gradeRunSchema.parse(input);
    const hash = this.hash(JSON.stringify(run));
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT content_hash FROM grade_runs WHERE account_id = ? AND run_id = ?")
        .get(accountId, run.runId) as { content_hash: string } | undefined;
      if (existing) {
        if (existing.content_hash !== hash) throw new Error("Conflicting contents for an existing grade run ID.");
        return "already-imported" as const;
      }
      this.database.prepare("INSERT INTO grade_runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        accountId, run.runId, run.capturedAt, run.status, run.students.length, hash,
        this.seal(run, JSON.stringify(["grade-run", accountId, run.runId])),
      );
      const insertStudent = this.database.prepare("INSERT INTO grade_students VALUES (?, ?, ?, ?)");
      const insertObservation = this.database.prepare("INSERT INTO grade_observations VALUES (?, ?, ?, ?, ?, ?)");
      for (const student of run.students) {
        const studentKey = this.hash(JSON.stringify(["student", accountId, student.id]));
        const identity = assignmentStudentIdentitySchema.required({ firstName: true, lastName: true }).parse(student);
        insertStudent.run(accountId, run.runId, studentKey, student.status);
        for (const grade of student.grades) {
          const gradeKey = this.hash(JSON.stringify(["grade", accountId, student.id, grade.id]));
          insertObservation.run(accountId, run.runId, studentKey, gradeKey, grade.source.capturedAt,
            this.seal({ student: identity, grade }, JSON.stringify(["grade", accountId, run.runId, studentKey, gradeKey])));
        }
      }
      this.database.prepare("INSERT INTO grade_import_events(account_id, run_id, imported_at) VALUES (?, ?, ?)")
        .run(accountId, run.runId, new Date().toISOString());
      return "imported" as const;
    }).immediate();
  }

  getGradeRun(accountId: string, runId: string): GradeRun | undefined {
    checkAccount(accountId);
    const row = this.database.prepare("SELECT payload FROM grade_runs WHERE account_id = ? AND run_id = ?")
      .get(accountId, runId) as { payload: Buffer } | undefined;
    return row ? gradeRunSchema.parse(this.unseal(row.payload, JSON.stringify(["grade-run", accountId, runId]))) : undefined;
  }

  listGradeRuns(accountId: string, limit = 100): GradeRunSummary[] {
    checkAccount(accountId);
    checkLimit(limit);
    return this.database.prepare(`SELECT run_id AS runId, captured_at AS capturedAt, status, student_count AS studentCount
      FROM grade_runs WHERE account_id = ? ORDER BY captured_at DESC, run_id DESC LIMIT ?`)
      .all(accountId, limit) as GradeRunSummary[];
  }

  listGrades(accountId: string, options: { studentId?: string; limit?: number } = {}): StoredGrade[] {
    checkAccount(accountId);
    const limit = options.limit ?? 100;
    checkLimit(limit);
    const studentKey = options.studentId === undefined ? null : this.hash(JSON.stringify(["student", accountId, options.studentId]));
    const rows = this.database.prepare(`WITH ranked AS (
      SELECT observations.*, ROW_NUMBER() OVER (
        PARTITION BY observations.student_key, observations.grade_key
        ORDER BY observations.observed_at DESC, runs.captured_at DESC, observations.run_id DESC
      ) AS rank,
      MIN(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.grade_key) AS first_seen,
      MAX(observations.observed_at) OVER (PARTITION BY observations.student_key, observations.grade_key) AS last_seen
      FROM grade_observations observations JOIN grade_students students USING(account_id, run_id, student_key)
      JOIN grade_runs runs USING(account_id, run_id)
      WHERE observations.account_id = ? AND students.status = 'complete' AND (? IS NULL OR observations.student_key = ?)
    ) SELECT * FROM ranked WHERE rank = 1 ORDER BY student_key, grade_key LIMIT ?`)
      .all(accountId, studentKey, studentKey, limit) as {
        run_id: string; student_key: string; grade_key: string; payload: Buffer; first_seen: string; last_seen: string;
      }[];
    return rows.map(row => {
      const value = this.unseal(row.payload, JSON.stringify(["grade", accountId, row.run_id, row.student_key, row.grade_key])) as {
        student: unknown; grade: unknown;
      };
      return { student: assignmentStudentIdentitySchema.required({ firstName: true, lastName: true }).parse(value.student),
        grade: gradeRecordSchema.parse(value.grade), runId: row.run_id, firstSeenAt: row.first_seen, lastSeenAt: row.last_seen };
    });
  }

  async backup(destination: string): Promise<void> {
    if (existsSync(destination)) throw new Error("Backup destination already exists.");
    prepareDatabaseFile(destination);
    await this.database.backup(destination);
  }

  close(): void {
    this.database.close();
    this.key.fill(0);
  }
}