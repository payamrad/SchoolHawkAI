import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createAzureFoundryAgentFromEnv } from "@schoolhawk/agent/azure-foundry";
import { SNAPSHOT_MAX_BYTES, studentSnapshotSchema, type StudentSnapshot } from "@schoolhawk/core/student-snapshot";
import { diagnosticErrorCode, reportDiagnostic } from "@schoolhawk/core/diagnostics";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { withReviewStore } from "@schoolhawk/storage/review-sqlite";
import { readReviewConfig } from "./review";

const HELP = `Opt-in Azure Foundry agent integration

  Agent test
  Agent analyze --config <private-review-json>
  Agent analyze --report <private-student-snapshot-json>
  Agent --help

test sends synthetic connection text only; it needs no school database or portal.
analyze sends a full student snapshot to the configured Azure Foundry agent and
prints its response as JSON. This is an explicit external transmission of private
educational data. Approve the provider and its data handling before using real data.
--config generates the normal 60-day assignment / 14-day message snapshot first.
--report sends an existing validated snapshot, including any custom report windows.

Set AZURE_FOUNDRY_AGENT_ENDPOINT and AZURE_FOUNDRY_API_KEY in the process environment.
Optional: AZURE_FOUNDRY_API_VERSION, AZURE_FOUNDRY_TIMEOUT_MS, AZURE_FOUNDRY_MAX_REQUEST_BYTES.
Never pass credentials as command-line options or put them in the review/report JSON.
The existing agent system prompt is not replaced. Calls are stateless and execute
no client tools. No automatic retries, delivery, or AI-report persistence occur.
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

export function parseAgentArgs(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { command: "help" as const };
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true,
      options: { config: { type: "string" }, report: { type: "string" } } });
    const command = positionals[0];
    if (positionals.length !== 1 || command !== "test" && command !== "analyze") throw new Error();
    for (const key of Object.keys(values)) {
      if (args.filter(arg => arg === `--${key}` || arg.startsWith(`--${key}=`)).length !== 1) throw new Error();
    }
    if (command === "test") {
      if (Object.keys(values).length) throw new Error();
      return { command };
    }
    if (!!values.config === !!values.report) throw new Error();
    return { command, config: values.config, report: values.report };
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
  const agent = createAzureFoundryAgentFromEnv(environment);
  if (input.command === "test") {
    console.error("AGENT: Testing communication with synthetic text only; no student records are sent.");
    console.log(JSON.stringify(await agent.testConnection(), null, 2));
    return;
  }
  let report: StudentSnapshot;
  if (input.config) {
    const config = readReviewConfig(path.resolve(root, input.config));
    report = await withReviewStore(root, store => store.createStudentSnapshot(config));
  } else if (input.report) {
    report = readStudentReport(path.resolve(root, input.report));
  } else {
    throw new AgentUsageError("Provide a private review configuration or student snapshot. No agent request was sent.");
  }
  console.error("AGENT: Sending private educational data to the configured Azure Foundry agent. No portal credentials or storage key are included.");
  console.log(JSON.stringify(await agent.analyzeStudentReport(report), null, 2));
}
