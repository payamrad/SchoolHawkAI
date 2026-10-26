import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import {
  DiagnosticLogError, diagnosticErrorCode, diagnosticErrorType, diagnosticEventSchema, hasDiagnosticSink, withDiagnosticSink,
  type DiagnosticEvent, type DiagnosticSink,
} from "@schoolhawk/core/diagnostics";
import { checkPrivatePath } from "./private-files";

export { DiagnosticLogError, diagnosticErrorType, reportDiagnostic } from "@schoolhawk/core/diagnostics";

const commands = ["skyward:login", "canvas:login", "skyward:messages", "skyward:assignments", "skyward:grades",
  "canvas:assignments", "cli", "data", "setup"] as const;
export type DiagnosticCommand = typeof commands[number];
const LOG_NAME = /^\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 100;
const MAX_EVENTS = 2000;

function pruneLogs(directory: string, now: Date): void {
  const files = readdirSync(directory).filter(name => LOG_NAME.test(name)).map(name => {
    const file = path.join(directory, name);
    checkPrivatePath(file);
    return { file, modified: lstatSync(file).mtimeMs };
  }).sort((left, right) => left.modified - right.modified);
  for (const [index, file] of files.entries()) {
    if (now.getTime() - file.modified > RETENTION_MS ||
        (index < files.length - MAX_FILES + 1 && now.getTime() - file.modified > 60 * 60 * 1000)) {
      unlinkSync(file.file);
    }
  }
}

export function createDiagnosticLog(root: string, command: DiagnosticCommand, now = new Date()) {
  if (!commands.includes(command) || !Number.isFinite(now.getTime())) throw new DiagnosticLogError("Invalid diagnostic log configuration.");
  const directory = path.join(root, "logs");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  checkPrivatePath(directory, true);
  pruneLogs(directory, now);
  const operationId = randomUUID();
  const file = path.join(directory, `${now.toISOString().slice(0, 10)}-${operationId}.jsonl`);
  const descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  let count = 0;
  let suppressed = 0;
  let stage: DiagnosticEvent["stage"];
  let failureStage: DiagnosticEvent["stage"];
  let status: DiagnosticEvent["status"];
  const logger = pino({
    base: { logVersion: 1, operationId, command, nodeVersion: process.version },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, {
    write(message: string) {
      if (closed) throw new DiagnosticLogError("The private diagnostic log is closed.");
      try {
        const bytes = Buffer.from(message);
        let written = 0;
        while (written < bytes.length) {
          const size = writeSync(descriptor, bytes, written, bytes.length - written);
          if (size === 0) throw new DiagnosticLogError("The private diagnostic log could not be written.");
          written += size;
        }
      } catch { throw new DiagnosticLogError("Cannot write the private diagnostic log. Check permissions and disk space."); }
    },
  });
  const write = (event: DiagnosticEvent) => {
    const { level, ...safe } = diagnosticEventSchema.parse(event);
    logger[level](safe);
    try {
      if (level === "error" || level === "warn") fsyncSync(descriptor);
    } catch { throw new DiagnosticLogError("Cannot flush the private diagnostic log. Check disk space."); }
  };
  const sink: DiagnosticSink = event => {
    if (closed) throw new DiagnosticLogError("The private diagnostic log is closed.");
    if (event.stage) stage = event.stage;
    if (event.level === "error") failureStage ??= event.stage ?? stage;
    if (["RUN_SUMMARY", "IMPORT_SUMMARY", "REVIEW_SUMMARY", "BRIEFING_SUMMARY", "SNAPSHOT_SUMMARY", "AGENT_TEST_SUMMARY", "AGENT_ANALYSIS_SUMMARY", "AGENT_REPORT_SAVED"].includes(event.code) && event.status) status = event.status;
    else if (event.code === "COMMAND_FAILED") status = "failed";
    if (count >= MAX_EVENTS && !["RUN_SUMMARY", "REVIEW_SUMMARY", "BRIEFING_SUMMARY", "SNAPSHOT_SUMMARY", "AGENT_TEST_SUMMARY", "AGENT_ANALYSIS_SUMMARY", "AGENT_REPORT_SAVED", "COMMAND_COMPLETED", "COMMAND_FAILED"].includes(event.code)) {
      suppressed++;
      return;
    }
    count++;
    write(event);
  };
  return {
    file,
    operationId,
    sink,
    outcome: () => ({ stage: failureStage ?? stage, status }),
    close() {
      if (closed) return;
      try {
        if (suppressed) write({ code: "LOG_LIMIT_REACHED", counts: { suppressed } });
        fsyncSync(descriptor);
      } catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        throw new DiagnosticLogError("Cannot finish flushing the private diagnostic log. Check disk space.");
      } finally {
        closed = true;
        closeSync(descriptor);
      }
    },
  };
}

export async function withLocalDiagnostics<Result>(root: string, command: DiagnosticCommand,
  operation: () => Result | Promise<Result>): Promise<Result> {
  if (hasDiagnosticSink()) return operation();
  let log: ReturnType<typeof createDiagnosticLog>;
  try { log = createDiagnosticLog(root, command); }
  catch (error) {
    throw new DiagnosticLogError(`Cannot initialize private diagnostic logs (${diagnosticErrorType(error)}). Check logs/ ownership, permissions, and disk space.`);
  }
  const started = Date.now();
  console.error(`Local diagnostic log: ${log.file}`);
  try {
    return await withDiagnosticSink(log.sink, async () => {
      log.sink({ level: "info", code: "COMMAND_STARTED" });
      try {
        const result = await operation();
        log.sink({ level: "info", code: "COMMAND_COMPLETED", status: log.outcome().status ?? "success",
          durationMs: Math.max(0, Date.now() - started) });
        return result;
      } catch (error) {
        log.sink({ level: "error", code: "COMMAND_FAILED", status: "failed", stage: log.outcome().stage,
          errorType: diagnosticErrorType(error), errorCode: diagnosticErrorCode(error), durationMs: Math.max(0, Date.now() - started) });
        throw error;
      }
    });
  } finally { log.close(); }
}
