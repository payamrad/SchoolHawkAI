import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ReviewError, reviewConfigSchema, reviewIdSchema, reviewTimestamp, type ReviewConfig } from "@schoolhawk/core/review";
import { diagnosticErrorCode, reportDiagnostic } from "@schoolhawk/core/diagnostics";
import { buildBriefingInput, renderDeterministicBriefing, serializeBriefingInput } from "@schoolhawk/briefing";
import { renderStudentSnapshot, serializeStudentSnapshot } from "@schoolhawk/briefing/student-snapshot";
import { studentSnapshotOptionsSchema } from "@schoolhawk/core/student-snapshot";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { withReviewStore } from "@schoolhawk/storage/review-sqlite";

const HELP = `Local deterministic review (no portal access, model calls, or delivery)

  Review run --config <private-json>
  Review briefing --config <private-json> [--text]
  Review snapshot --config <private-json> [--assignment-days N] [--message-days N] [--text]
  Review changes --profile <id> [--since <ISO timestamp>] [--limit N] [--offset N]
  Review priorities --profile <id> [--review <id>] [--limit N --offset N]
  Review status --profile <id> [--review <id>] [--limit N --offset N]
  Review source --profile <id> --review <id> --source <source-id>
  Review --help

run processes new stored observations and saves an encrypted review evaluation.
briefing also evaluates current time-based rules, then prints bounded provider-neutral
JSON, or a deterministic local text summary with --text.
snapshot returns past assignments (60 days by default) and all retained grades by
student/course, including histories, priorities, and collection health.
Upcoming, missing, undated, and confirmed-linked assignment details are retained.
Older assignment grades/scores remain as compact histories without full details.
Messages are recent (14 days by default), newly observed, or recently changed beyond
read state. Both read/unread messages can qualify; full content is retained.
The database defines the school year for grades; no start date or reset is needed.
The small briefing's item/byte limits do not truncate snapshots; oversized snapshots
fail explicitly. Output contains private school text; nothing is sent externally.
Inspection commands read saved results; check evaluatedAt before treating them as current.
Configuration must be a private regular file owned by the current user (0600).
First-time setup, from the repository root (only when the local file is missing):
  install -m 600 config/review.example.json config/review.local.json
Then edit its account aliases and student bindings before running review.
Explicit inspection can print private data; protect terminal output. Nothing is sent.
Use a new profileId when changing source accounts/sections or child bindings.
`;

export class ReviewUsageError extends Error {
  readonly code: ReturnType<typeof diagnosticErrorCode>;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.code = diagnosticErrorCode(cause);
  }
}

export function readReviewConfig(file: string): ReviewConfig {
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "CONFIGURATION" });
  let contents: string;
  try {
    checkPrivatePath(file);
    if (lstatSync(file).size > 100000) throw new ReviewUsageError("Review configuration exceeds 100 KB. No database was opened.");
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof ReviewUsageError) throw error;
    if (diagnosticErrorCode(error) === "ENOENT") {
      throw new ReviewUsageError(
        "Review configuration file not found at the --config path. Create a private copy of config/review.example.json, " +
        "then edit its account aliases and student bindings. For the default path, run from the repository root: " +
        "install -m 600 config/review.example.json config/review.local.json. No database was opened.", error);
    }
    throw new ReviewUsageError(
      "Cannot read the review configuration at the --config path. It must be a private, readable regular file " +
      "(not a symlink), owned by the current user with mode 0600. Check the configuration path and its permissions; " +
      "do not replace the database key. No database was opened.", error);
  }
  try { return reviewConfigSchema.parse(JSON.parse(contents)); }
  catch (error) {
    reportDiagnostic({ level: "error", code: "SCHEMA_INVALID", stage: "CONFIGURATION", errorType: "validation" });
    throw new ReviewUsageError(
      "Invalid review configuration. Check its JSON syntax, schema, unique sources/child bindings, and rule limits. " +
      "Values were withheld. No database was opened.", error);
  }
}

export function parseReviewArgs(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { command: "help" as const };
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, options: {
        config: { type: "string" }, profile: { type: "string" }, review: { type: "string" },
        source: { type: "string" }, since: { type: "string" }, limit: { type: "string" },
        offset: { type: "string" }, text: { type: "boolean" },
        "assignment-days": { type: "string" }, "message-days": { type: "string" },
      },
    });
    if (positionals.length !== 1) throw new Error();
    const command = positionals[0];
    const allowed: Record<string, string[]> = {
      run: ["config"], briefing: ["config", "text"], snapshot: ["config", "text", "assignment-days", "message-days"],
      changes: ["profile", "since", "limit", "offset"],
      priorities: ["profile", "review", "limit", "offset"], status: ["profile", "review", "limit", "offset"],
      source: ["profile", "review", "source"],
    };
    if (!Object.hasOwn(allowed, command)) throw new Error();
    for (const key of Object.keys(values)) {
      if (!allowed[command].includes(key) || args.filter(arg => arg === `--${key}` || arg.startsWith(`--${key}=`)).length !== 1) throw new Error();
    }
    if (command === "run" || command === "briefing" || command === "snapshot") {
      if (!values.config) throw new Error();
    } else if (!values.profile || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.profile)) throw new Error();
    if (values.review) reviewIdSchema.parse(values.review);
    if (values.source) reviewIdSchema.parse(values.source);
    if (command === "source" && (!values.review || !values.source)) throw new Error();
    if (values.since) reviewTimestamp.parse(values.since);
    const limit = Number(values.limit ?? "100");
    const offset = Number(values.offset ?? "0");
    if (!/^\d+$/.test(values.limit ?? "100") || !Number.isInteger(limit) || limit < 1 || limit > 1000 ||
        !/^\d+$/.test(values.offset ?? "0") || !Number.isSafeInteger(offset)) throw new Error();
    for (const key of ["assignment-days", "message-days"] as const) {
      if (values[key] !== undefined && !/^\d{1,3}$/.test(values[key])) throw new Error();
    }
    const snapshotOptions = studentSnapshotOptionsSchema.parse({
      assignmentDays: values["assignment-days"] === undefined ? undefined : Number(values["assignment-days"]),
      messageDays: values["message-days"] === undefined ? undefined : Number(values["message-days"]),
    });
    return { command, values, limit, offset, snapshotOptions };
  } catch { throw new ReviewUsageError("Invalid Review arguments. Use npm run cli -- Review --help. No collection or model call was attempted."); }
}

export async function runReviewCli(args: string[], root: string): Promise<void> {
  const input = parseReviewArgs(args);
  if (input.command === "help") { console.log(HELP); return; }
  const { values } = input;
  if (!values) throw new ReviewUsageError("Invalid Review command.");
  const config = values.config ? readReviewConfig(path.resolve(root, values.config)) : undefined;
  await withReviewStore(root, store => {
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "CLI_COMMAND" });
    if (input.command === "snapshot") {
      if (!config) throw new ReviewUsageError("A private review configuration is required.");
      const snapshot = store.createStudentSnapshot(config, new Date(), input.snapshotOptions);
      console.log(values.text ? renderStudentSnapshot(snapshot) : serializeStudentSnapshot(snapshot));
      return;
    }
    if (input.command === "run" || input.command === "briefing") {
      if (!config) throw new ReviewUsageError("A private review configuration is required.");
      const review = store.processReview(config);
      if (input.command === "briefing") {
        reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "BRIEFING_INPUT" });
        const briefing = buildBriefingInput(review);
        console.log(values.text ? renderDeterministicBriefing(briefing) : serializeBriefingInput(briefing));
        reportDiagnostic({ level: "info", code: "BRIEFING_SUMMARY", stage: "BRIEFING_INPUT",
          status: briefing.conclusion === "incomplete" ? "partial" : "complete",
          counts: { accepted: briefing.items.length, skipped: briefing.omitted.items } });
      } else {
        console.log(JSON.stringify({
          id: review.id, evaluatedAt: review.evaluatedAt, bootstrap: review.bootstrap,
          changesInWindow: review.changes.length, actions: review.actions.length,
          highPriority: review.actions.filter(action => action.priority === "high").length,
          healthScopes: review.health.length, problemScopes: review.health.filter(entry =>
            entry.issues.some(issue => !["lookback-limited", "unread-only"].includes(issue))).length, notices: review.notices,
        }, null, 2));
      }
      return;
    }
    const profile = values.profile!;
    if (input.command === "changes") {
      if (!store.getReview(profile)) throw new ReviewError("No saved review for this profile. Run Review run with its private configuration first.");
      console.log(JSON.stringify(store.listReviewChanges(profile, { since: values.since, limit: input.limit, offset: input.offset }), null, 2));
    } else if (input.command === "source") {
      console.log(JSON.stringify(store.explainReviewSource(profile, values.review!, values.source!), null, 2));
    } else {
      const review = store.getReview(profile, values.review);
      if (!review) throw new ReviewError("No saved review for this profile. Run Review run with its private configuration first.");
      console.log(JSON.stringify(input.command === "priorities" ? {
        id: review.id, evaluatedAt: review.evaluatedAt, rules: review.rules, childRules: review.childRules,
        total: review.actions.length, offset: input.offset, actions: review.actions.slice(input.offset, input.offset! + input.limit!),
      } : { id: review.id, evaluatedAt: review.evaluatedAt, total: review.health.length, offset: input.offset,
        health: review.health.slice(input.offset, input.offset! + input.limit!), notices: review.notices }, null, 2));
    }
  });
}
