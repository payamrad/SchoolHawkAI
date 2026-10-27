import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createAzureFoundryAgentFromEnv } from "@schoolhawk/agent/azure-foundry";
import { SNAPSHOT_MAX_BYTES, studentSnapshotOptionsSchema, studentSnapshotSchema, type StudentSnapshot, type StudentSnapshotOptions } from "@schoolhawk/core/student-snapshot";
import { DiagnosticLogError, diagnosticErrorCode, reportDiagnostic } from "@schoolhawk/core/diagnostics";
import { agentReportIdSchema, reportStudentSchema, type StoredAgentReport } from "@schoolhawk/core/agent-reports";
import { fingerprintReportInput } from "@schoolhawk/core/report-input";
import { AgentError } from "@schoolhawk/agent";
import { AgentReportStorageError } from "@schoolhawk/storage/agent-reports";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { withReviewStore } from "@schoolhawk/storage/review-sqlite";
import { readReviewConfig } from "./review";
import { deliverNoChangeNotice, deliverReport, prepareReportDelivery, ReportDeliveryError, type ReportDeliveryResult } from "./communication";

const HELP = `Opt-in Azure Foundry agent integration

  Agent test
  Agent analyze --config <private-review-json> [--assignment-days N --message-days N] [--per-student] [--notify] [--force]
  Agent analyze --report <private-student-snapshot-json> [--notify] [--force]
  Agent reports [--limit N --offset N]
  Agent report --id <saved-report-id>
  Agent --help

test sends synthetic connection text only; it needs no school database or portal.
analyze sends a full student snapshot to the configured Azure Foundry agent and
stores the completed response in encrypted SQLite before printing it as JSON.
This is an explicit external transmission of private
educational data. Approve the provider and its data handling before using real data.
--config generates the normal 60-day assignment / 14-day message snapshot first.
--report sends an existing validated snapshot, including any custom report windows.
--notify also sends the saved response through the configured Brevo recipient lists.
--per-student generates and saves one individually scoped AI report per named child.
It requires --config, preserves shared account context, and attempts children independently.
Before analyzing, a stable hash of school facts is compared with the last successfully
saved report batch. Run timestamps, evidence IDs and repeat-observation counts are
ignored. If every student's report input is unchanged, Azure is not called and
--notify sends one short no-new-data notice to each configured recipient instead.
Coverage limitations and unresolved missing work remain qualified; this is not an all-clear.
--force bypasses comparison, for example after updating the Azure system prompt.
--collection-incomplete adds a pipeline coverage warning, including preflight failures
that may not appear in stored collection health. It never clears existing warnings.
Both analyze modes require the local database and original encryption key before
contacting the agent. A storage failure fails the command; no saved result is printed.
reports lists saved response metadata (limit: 1-1000, default 100).
report returns one full saved response. Neither command calls Azure or requires an API key.

Set AZURE_FOUNDRY_AGENT_ENDPOINT and AZURE_FOUNDRY_API_KEY in the process environment.
Optional: AZURE_FOUNDRY_API_VERSION, AZURE_FOUNDRY_TIMEOUT_MS, AZURE_FOUNDRY_MAX_REQUEST_BYTES.
Never pass credentials as command-line options or put them in the review/report JSON.
The existing agent system prompt is not replaced. Calls are stateless and execute
no client tools. No automatic retries occur. Delivery requires --notify.
Connection tests are not saved.
AI text is not fact-checked; deterministic priorities and collection warnings remain
the source of truth. On failure, use the existing local Review briefing --text.
`;

export class AgentUsageError extends Error {
  readonly code: ReturnType<typeof diagnosticErrorCode>;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.code = diagnosticErrorCode(cause);
  }
}

export function parseAgentArgs(args: string[]):
  { command: "help" } |
  { command: "test" } |
  { command: "analyze"; config?: string; report?: string; notify: boolean; perStudent: boolean; force: boolean; collectionIncomplete: boolean; snapshotOptions: StudentSnapshotOptions } |
  { command: "reports"; limit: number; offset: number } |
  { command: "report"; id: string } {
  if (args.length === 1 && args[0] === "--help") return { command: "help" as const };
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true,
      options: { config: { type: "string" }, report: { type: "string" }, id: { type: "string" },
        limit: { type: "string" }, offset: { type: "string" }, notify: { type: "boolean" }, force: { type: "boolean" },
        "collection-incomplete": { type: "boolean" }, "per-student": { type: "boolean" },
        "assignment-days": { type: "string" }, "message-days": { type: "string" } } });
    const command = positionals[0];
    const allowed: Record<string, string[]> = { test: [],
      analyze: ["config", "report", "notify", "per-student", "force", "collection-incomplete", "assignment-days", "message-days"],
      reports: ["limit", "offset"], report: ["id"] };
    if (positionals.length !== 1 || !Object.hasOwn(allowed, command)) throw new Error();
    for (const key of Object.keys(values)) {
      if (!allowed[command].includes(key) ||
          args.filter(arg => arg === `--${key}` || arg.startsWith(`--${key}=`)).length !== 1) throw new Error();
    }
    if (command === "test") {
      if (Object.keys(values).length) throw new Error();
      return { command };
    }
    if (command === "report") {
      return { command, id: agentReportIdSchema.parse(values.id) };
    }
    if (command === "reports") {
      const limit = Number(values.limit ?? "100");
      const offset = Number(values.offset ?? "0");
      if (!/^\d+$/.test(values.limit ?? "100") || !Number.isInteger(limit) || limit < 1 || limit > 1000 ||
          !/^\d+$/.test(values.offset ?? "0") || !Number.isSafeInteger(offset)) throw new Error();
      return { command, limit, offset };
    }
    if (!!values.config === !!values.report) throw new Error();
    if (values["per-student"] && !values.config) throw new Error();
    if (values.report && (values["assignment-days"] !== undefined || values["message-days"] !== undefined)) throw new Error();
    for (const option of ["assignment-days", "message-days"] as const) {
      if (values[option] !== undefined && !/^\d{1,3}$/.test(values[option])) throw new Error();
    }
    const snapshotOptions = studentSnapshotOptionsSchema.parse({
      assignmentDays: values["assignment-days"] === undefined ? undefined : Number(values["assignment-days"]),
      messageDays: values["message-days"] === undefined ? undefined : Number(values["message-days"]),
    });
    return { command: "analyze", config: values.config, report: values.report, notify: values.notify ?? false,
      perStudent: values["per-student"] ?? false, force: values.force ?? false,
      collectionIncomplete: values["collection-incomplete"] ?? false, snapshotOptions };
  } catch { throw new AgentUsageError("Invalid Agent arguments. Use npm run cli -- Agent --help. No agent request was sent."); }
}

function readStudentReport(file: string): StudentSnapshot {
  try {
    checkPrivatePath(file);
    if (lstatSync(file).size > SNAPSHOT_MAX_BYTES) throw new AgentUsageError("The student report exceeds 50 MiB. No agent request was sent.");
    return studentSnapshotSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof AgentUsageError) throw error;
    reportDiagnostic({ level: "error", code: "SCHEMA_INVALID", stage: "CONFIGURATION", errorType: "validation" });
    throw new AgentUsageError("Cannot read a valid student snapshot. Check JSON, completeness, file ownership, and private permissions (0600); symlinks are not accepted. No agent request was sent.", error);
  }
}

export async function runAgentCli(args: string[], root: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const input = parseAgentArgs(args);
  if (input.command === "help") { console.log(HELP); return; }
  if (input.command === "reports" || input.command === "report") {
    await withReviewStore(root, store => {
      if (input.command === "reports") {
        console.log(JSON.stringify({ limit: input.limit, offset: input.offset,
          reports: store.listAgentReports({ limit: input.limit, offset: input.offset }) }, null, 2));
      } else {
        const report = store.getAgentReport(input.id);
        if (!report) throw new AgentUsageError("No saved AI report matches this ID. Use Agent reports to list saved reports.");
        console.log(JSON.stringify(report, null, 2));
      }
    });
    return;
  }
  if (input.command === "test") {
    const agent = createAzureFoundryAgentFromEnv(environment);
    console.error("AGENT: Testing communication with synthetic text only; no student records are sent.");
    console.log(JSON.stringify(await agent.testConnection(), null, 2));
    return;
  }
  const delivery = input.notify ? prepareReportDelivery(environment) : undefined;
  const config = input.config ? readReviewConfig(path.resolve(root, input.config)) : undefined;
  const supplied = input.report ? readStudentReport(path.resolve(root, input.report)) : undefined;
  await withReviewStore(root, async store => {
    const now = new Date();
    const report = supplied ?? (config ? store.createStudentSnapshot(config, now, input.snapshotOptions) : undefined);
    if (!report) throw new AgentUsageError("Provide a private review configuration or student snapshot. No agent request was sent.");
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "AGENT_COMPARE" });
    const fingerprint = fingerprintReportInput(report, input.perStudent);
    const previous = store.getReportCheckpoint(fingerprint.scopeHash);
    if (!input.force && previous?.inputHash === fingerprint.inputHash) {
      const limited = input.collectionIncomplete || report.status !== "complete-for-retained-scope" || report.notices.length > 0 ||
        report.collectionHealth.some(scope => scope.issues.length > 0);
      console.error("AGENT: School report input is unchanged. Azure analysis was skipped; existing concerns may still need attention.");
      const communication = delivery ? await deliverNoChangeNotice({
        reportId: previous.reportIds[0], checkedAt: now.toISOString(), limited,
        previousDeliveryIncomplete: previous.deliveryIncomplete,
      }, delivery) : undefined;
      reportDiagnostic({ level: "info", code: "AGENT_REPORT_UNCHANGED", stage: "AGENT_COMPARE",
        status: limited ? "partial" : "success", counts: { students: report.students.length, requests: 0 } });
      console.log(JSON.stringify({
        kind: "student-report-unchanged", skipped: true, reason: "unchanged-input", checkedAt: now.toISOString(),
        previousReportIds: previous.reportIds, sourceStatus: limited ? "limited" : "complete-for-retained-scope",
        ...(communication ? { communication } : {}),
      }, null, 2));
      if (communication && communication.status !== "accepted") throw new ReportDeliveryError(communication);
      return;
    }
    const agent = createAzureFoundryAgentFromEnv(environment);
    type CompletedReport = StoredAgentReport & { communication?: ReportDeliveryResult };
    const checkpoint = (reports: CompletedReport[]) => store.saveReportCheckpoint({
      version: 1, ...fingerprint, reportIds: reports.map(result => result.reportId), savedAt: now.toISOString(),
      deliveryIncomplete: reports.some(result => result.communication?.status !== "accepted"),
    });
    const analyze = async (snapshot: StudentSnapshot): Promise<CompletedReport> => {
      if (input.collectionIncomplete) {
        snapshot.status = "incomplete-source-coverage";
        if (!snapshot.notices.includes("collection-incomplete")) snapshot.notices.push("collection-incomplete");
        snapshot.instructions.push("The pipeline reported an incomplete login or collection step. Saved collection health may not include preflight failures; do not present an all-clear.");
      }
      console.error("AGENT: Sending private educational data to the configured Azure Foundry agent. The completed response will be saved locally.");
      const analysis = await agent.analyzeStudentReport(snapshot);
      const saved = store.saveAgentReport(analysis);
      return delivery ? { ...saved, communication: await deliverReport(saved, delivery) } : saved;
    };
    if (!input.perStudent) {
      const result = await analyze(report);
      checkpoint([result]);
      console.log(JSON.stringify(result, null, 2));
      if (result.communication && result.communication.status !== "accepted") throw new ReportDeliveryError(result.communication);
      return;
    }
    if (!config || !report.students.length || report.students.some(student => !student.configuredIdentity ||
        !reportStudentSchema.safeParse({ ref: student.id, name: student.label }).success)) {
      throw new AgentUsageError("Per-student analysis requires configured student names, not unmapped or numbered placeholders. No agent request was sent.");
    }
    const snapshots = report.students.map(student => store.createStudentSnapshot(config, now,
      { ...input.snapshotOptions, studentRef: student.id }));
    const reports: CompletedReport[] = [];
    const failures: { studentRef: string; name: string; code: string }[] = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const student = snapshot.students[0];
      try {
        const result = await analyze(snapshot);
        reports.push(result);
        if (result.communication && result.communication.status !== "accepted") {
          failures.push({ studentRef: student.id, name: student.label, code: "DELIVERY_INCOMPLETE" });
        }
      } catch (error) {
        if (error instanceof DiagnosticLogError) throw error;
        reportDiagnostic({ level: "error", code: "REQUEST_FAILED", stage: "CLI_COMMAND", student: index + 1, status: "failed" });
        failures.push({ studentRef: student.id, name: student.label,
          code: error instanceof AgentError ? error.code : error instanceof AgentReportStorageError ? "STORAGE_FAILED" : "REPORT_FAILED" });
      }
    }
    if (reports.length === snapshots.length) checkpoint(reports);
    console.log(JSON.stringify({
      kind: "student-report-batch", status: failures.length ? reports.length ? "partial" : "failed" : "complete",
      reports, failures,
    }, null, 2));
    if (failures.length) throw new AgentUsageError("One or more student reports or deliveries failed. Successful reports remain saved; inspect the batch before retrying to avoid duplicate emails.");
  });
}
