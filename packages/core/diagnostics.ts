import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const diagnosticStageSchema = z.enum([
  "CONFIGURATION", "PRIVATE_SESSION_FILE", "SAVED_ENTRY_URL", "PRIVATE_DATABASE_KEY", "DATABASE_OPEN",
  "BROWSER_LAUNCH", "SESSION_RESUME", "COLLECT", "DATABASE_WRITE", "BROWSER_CLOSE",
  "AUTH_DIRECTORY", "LOGIN_NAVIGATION", "LOGIN_FORM", "LOGIN_VERIFY", "SESSION_SAVE",
  "DATE_WINDOW", "INBOX_NAVIGATION", "CLI_COMMAND", "IMPORT", "BACKUP", "STATUS", "CLEANUP", "REVIEW_PROCESS", "BRIEFING_INPUT", "STUDENT_SNAPSHOT",
  "AGENT_REQUEST", "AGENT_RESPONSE",
]);

export const diagnosticEventSchema = z.object({
  level: z.enum(["info", "warn", "error"]).default("warn"),
  code: z.enum([
    "COMMAND_STARTED", "COMMAND_COMPLETED", "COMMAND_FAILED", "STAGE_STARTED", "LOG_LIMIT_REACHED",
    "RUN_STARTED", "RUN_SUMMARY", "SECTION_SUMMARY", "STORAGE_WRITE_FAILED", "AUTH_REQUIRED",
    "STUDENT_DISCOVERY_UNVERIFIED", "STUDENT_RECORD_INVALID", "STUDENT_BINDING_MISSING",
    "STUDENT_BINDING_AMBIGUOUS", "STUDENT_BINDING_CONFLICT", "DUPLICATE_STUDENT", "DUPLICATE_SCOPE",
    "STUDENT_NAME_AMBIGUOUS", "STUDENT_NAME_UNVERIFIED",
    "SCOPE_MISSING", "SCOPE_FAILED", "BROWSE_HTTP_ERROR", "BROWSE_RESPONSE_INVALID",
    "BROWSE_REGISTRATION_INVALID", "LIST_LAYOUT_UNVERIFIED", "RECORD_INVALID", "DUPLICATE_RECORD",
    "FIELD_INVALID", "STATE_UNKNOWN", "PAGINATION_UNVERIFIED", "PAGINATION_INVALID", "COLLECTION_LIMIT",
    "RECORD_SKIPPED", "DATE_UNVERIFIED", "DATE_ORDER_UNVERIFIED", "MESSAGE_BODY_UNVERIFIED",
    "SCROLL_COMPLETENESS_UNVERIFIED", "SCHEMA_INVALID", "REQUEST_FAILED", "PERMISSION_DENIED",
    "RATE_LIMITED", "HTTP_ERROR", "RESPONSE_INVALID", "IMPORT_REJECTED", "IMPORT_SUMMARY",
    "STORAGE_KEY_INVALID", "STORAGE_SCHEMA_UNSUPPORTED", "STORAGE_OPEN_FAILED", "REVIEW_SUMMARY", "BRIEFING_SUMMARY", "SNAPSHOT_SUMMARY",
    "AGENT_TEST_SUMMARY", "AGENT_ANALYSIS_SUMMARY", "AGENT_REPORT_SAVED",
  ]),
  portal: z.enum(["skyward", "canvas"]).optional(),
  section: z.enum(["session", "students", "courses", "assignments", "grades", "messages", "upcoming",
    "missing", "past", "storage", "mapping"]).optional(),
  stage: diagnosticStageSchema.optional(),
  runId: z.uuid().optional(),
  parserVersion: count.optional(),
  durationMs: count.optional(),
  student: count.optional(),
  course: count.optional(),
  record: count.optional(),
  page: count.optional(),
  field: z.enum(["id", "student", "name", "title", "course", "dueDate", "dueAt", "unread", "attachments",
    "headers", "periods", "mark", "status", "source", "body", "sentDate", "scope", "pagination", "response",
    "metadata", "date"]).optional(),
  status: z.enum(["complete", "partial", "failed", "auth-required", "unsupported", "success", "cancelled"]).optional(),
  errorType: z.enum(["timeout", "permission", "missing-file", "disk-full", "database", "validation", "other"]).optional(),
  errorCode: z.enum(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EMFILE", "ENFILE", "ECONNREFUSED",
    "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "SQLITE_BUSY", "SQLITE_LOCKED",
    "SQLITE_FULL", "SQLITE_CORRUPT", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_NOTADB"]).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  expected: count.optional(),
  actual: count.optional(),
  counts: z.object({
    scanned: count.optional(), accepted: count.optional(), skipped: count.optional(), duplicates: count.optional(),
    students: count.optional(), requestStudents: count.optional(), rowStudents: count.optional(),
    rosterMatches: count.optional(), courses: count.optional(), periods: count.optional(), headers: count.optional(),
    cells: count.optional(), pages: count.optional(), requests: count.optional(), suppressed: count.optional(),
    identityCandidates: count.optional(), stateMarkers: count.optional(),
  }).optional(),
  flags: z.object({
    verifiedEmpty: z.boolean().optional(), headerMatch: z.boolean().optional(), capped: z.boolean().optional(),
    hasId: z.boolean().optional(), hasTitle: z.boolean().optional(), hasCourse: z.boolean().optional(),
    hasDate: z.boolean().optional(), hasMark: z.boolean().optional(), hasLink: z.boolean().optional(),
    hasStudent: z.boolean().optional(), discoveryComplete: z.boolean().optional(), matched: z.boolean().optional(),
    conflicted: z.boolean().optional(),
    hasReadState: z.boolean().optional(), hasUnreadState: z.boolean().optional(),
  }).optional(),
});

export type DiagnosticEvent = z.input<typeof diagnosticEventSchema>;
export type DiagnosticSink = (event: z.output<typeof diagnosticEventSchema>) => void;
const sinks = new AsyncLocalStorage<DiagnosticSink>();

export class DiagnosticLogError extends Error {}

export function withDiagnosticSink<Result>(sink: DiagnosticSink, operation: () => Result): Result {
  return sinks.run(sink, operation);
}

export function bindDiagnosticContext<Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  const sink = sinks.getStore();
  // Browser transport events do not inherit the context in which listeners were registered.
  return (...args) => sink ? sinks.run(sink, () => operation(...args)) : sinks.exit(() => operation(...args));
}

export function hasDiagnosticSink(): boolean {
  return sinks.getStore() !== undefined;
}

export function reportDiagnostic(event: DiagnosticEvent): void {
  const safe = diagnosticEventSchema.parse(event);
  const sink = sinks.getStore();
  if (sink) sink(safe);
  else if (safe.level !== "info") console.error(JSON.stringify(safe));
}

export function diagnosticErrorType(error: unknown): DiagnosticEvent["errorType"] {
  if (error instanceof z.ZodError) return "validation";
  if (!(error instanceof Error)) return "other";
  if (error.name === "TimeoutError") return "timeout";
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "missing-file";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOSPC") return "disk-full";
  if (typeof code === "string" && code.startsWith("SQLITE_")) return "database";
  return "other";
}

export function diagnosticErrorCode(error: unknown): DiagnosticEvent["errorCode"] {
  const parsed = diagnosticEventSchema.shape.errorCode.safeParse(
    error instanceof Error && "code" in error ? error.code : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}
