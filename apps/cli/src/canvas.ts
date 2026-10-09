import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { withWorkspaceStore, type SqliteCanvasStore } from "@schoolhawk/storage/canvas-sqlite";

const HELP = `Canvas assignment data and correlation (local database only)

npm run cli -- Canvas status --account <canvas-alias>
npm run cli -- Canvas assignments --account <canvas-alias> [--student <id> --course <id>] [--limit N --offset N]
npm run cli -- Canvas scopes --account <canvas-alias> [--skyward-account <alias>]
npm run cli -- Canvas map --account <canvas-alias> --student <canvas-id> --course <canvas-course-id>
  --skyward-account <alias> --skyward-student <id> --skyward-course <name> [--skyward-section <section>] [--yes]
npm run cli -- Canvas mappings --account <canvas-alias>
npm run cli -- Canvas matches --account <canvas-alias> --mapping <mapping-id>
npm run cli -- Canvas confirm --account <canvas-alias> --mapping <mapping-id> --proposal <confirmation-key> [--yes]
npm run canvas:match -- --account <canvas-alias> --lookback N [--mapping <id>] [--dry-run | --yes]
  [--max-source-age-hours N]
npm run cli -- Canvas links --account <canvas-alias>
npm run cli -- Assignments --account <skyward-alias> [--student <id>] [--limit N --offset N]

canvas:match works from the repository root or apps/collector; Canvas match through the CLI remains supported.
Map requires explicit student/course identity confirmation; omit --skyward-section only for a null source section.
Matches proposes links only. Confirm accepts one current, unambiguous proposal; --yes skips interactive confirmation.
Match retries unlinked Skyward assignments due today or in the preceding N-1 Pacific calendar days (N: 1-366).
It uses confirmed course mappings only. Defaults to a 48-hour source freshness limit (configurable 1-168).
--dry-run previews without changing links/status; --yes authorizes unattended matching. Opening storage may apply migrations.
Confirmed links retain source IDs even when titles/dates change. Skyward grades and missing status are never replaced.
Query output contains private plaintext. Protect terminal output. Limits are 1-1000, default 100.`;

export class CanvasCliUsageError extends Error {}
const allowed: Record<string, string[]> = {
  status: [], assignments: ["student", "course", "limit", "offset"], scopes: ["skyward-account"], mappings: [],
  map: ["student", "course", "skyward-account", "skyward-student", "skyward-course", "skyward-section", "yes"],
  matches: ["mapping"], confirm: ["mapping", "proposal", "yes"], links: [], enriched: ["student", "limit", "offset"],
  match: ["mapping", "lookback", "max-source-age-hours", "dry-run", "yes"],
};

export function parseCanvasCliArgs(args: string[]) {
  if ((args.length === 1 && args[0] === "--help") ||
      (args.length === 2 && args[0] === "match" && args[1] === "--help")) return { action: "help" as const, values: {}, limit: 100, offset: 0 };
  try {
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      account: { type: "string" }, student: { type: "string" }, course: { type: "string" }, limit: { type: "string" }, offset: { type: "string" },
      "skyward-account": { type: "string" }, "skyward-student": { type: "string" }, "skyward-course": { type: "string" },
      "skyward-section": { type: "string" }, mapping: { type: "string" }, proposal: { type: "string" }, yes: { type: "boolean" },
      lookback: { type: "string" }, "max-source-age-hours": { type: "string" }, "dry-run": { type: "boolean" },
    } });
    const action = positionals[0];
    if (positionals.length !== 1 || !Object.hasOwn(allowed, action) || !values.account || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.account)) throw new Error();
    const optionNames = tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(optionNames).size !== optionNames.length || optionNames.some(name => !["account", ...allowed[action]].includes(name))) throw new Error();
    const required = action === "map" ? ["student", "course", "skyward-account", "skyward-student", "skyward-course"] :
      action === "confirm" ? ["mapping", "proposal"] : action === "matches" ? ["mapping"] : action === "match" ? ["lookback"] : [];
    for (const name of required) if (!values[name as keyof typeof values]) throw new Error();
    if (values["skyward-account"] && !/^[a-zA-Z0-9_-]{1,100}$/.test(values["skyward-account"])) throw new Error();
    if (values.student && (values.student.length > 300 || (action !== "enriched" && !/^\d+$/.test(values.student)))) throw new Error();
    if (values.course && (!values.student || !/^\d+$/.test(values.course))) throw new Error();
    if (values["skyward-student"] && values["skyward-student"].length > 300) throw new Error();
    if (values.mapping && !/^[a-f0-9-]{36}$/i.test(values.mapping)) throw new Error();
    if (values.proposal && !/^[a-f0-9]{64}$/.test(values.proposal)) throw new Error();
    if (action === "match") {
      const days = Number(values.lookback);
      const age = Number(values["max-source-age-hours"] ?? 48);
      if (!/^\d+$/.test(values.lookback!) || !Number.isInteger(days) || days < 1 || days > 366 ||
          (values["max-source-age-hours"] !== undefined && !/^\d+$/.test(values["max-source-age-hours"])) ||
          !Number.isInteger(age) || age < 1 || age > 168 || (values["dry-run"] && values.yes)) throw new Error();
    }
    const limit = Number(values.limit ?? 100);
    const offset = Number(values.offset ?? 0);
    if ((values.limit && !/^\d+$/.test(values.limit)) || (values.offset && !/^\d+$/.test(values.offset)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error();
    return { action, values, limit, offset };
  } catch { throw new CanvasCliUsageError("Invalid Canvas command, scope, or option. Run npm run cli -- Canvas --help."); }
}

export async function executeCanvasCommand(store: SqliteCanvasStore, input: ReturnType<typeof parseCanvasCliArgs>,
  confirm: (prompt: string) => Promise<boolean>) {
  const { action, values, limit, offset } = input;
  const account = values.account!;
  if (action === "match") {
    const options = { lookbackDays: Number(values.lookback), mappingId: values.mapping,
      maxSourceAgeHours: Number(values["max-source-age-hours"] ?? 48) };
    if (values["dry-run"]) return store.matchCanvasAssignments(account, { ...options, dryRun: true });
    if (!values.yes) {
      const preview = store.matchCanvasAssignments(account, { ...options, dryRun: true });
      console.log(JSON.stringify(preview, null, 2));
      if (!await confirm("Type CONFIRM to link unique matches and record retry statuses: ")) return { cancelled: true };
    }
    return store.matchCanvasAssignments(account, options);
  }
  if (action === "map") {
    const mapping = { canvasStudentId: values.student!, canvasCourseId: values.course!, skywardAccountId: values["skyward-account"]!,
      skywardStudentId: values["skyward-student"]!, skywardCourse: values["skyward-course"]!, skywardSection: values["skyward-section"] ?? null };
    console.log(JSON.stringify({ mapping }, null, 2));
    if (!values.yes && !await confirm("Type CONFIRM to map these student/course identities: ")) return { cancelled: true };
    return store.saveCanvasCourseMapping(account, mapping);
  }
  if (action === "confirm") {
    const proposal = store.proposeCanvasAssignmentLinks(account, values.mapping!).find(proposal =>
      proposal.candidates.some(candidate => candidate.confirmationKey === values.proposal));
    const existing = store.listCanvasAssignmentLinks(account).find(link => link.mappingId === values.mapping && link.confirmationKey === values.proposal);
    if (!proposal && !existing) throw new CanvasCliUsageError("Proposal is stale or ambiguous. Run Canvas matches again before confirming.");
    console.log(JSON.stringify({ proposal: proposal ?? existing }, null, 2));
    if (!values.yes && !await confirm("Type CONFIRM to link these assignment IDs: ")) return { cancelled: true };
    return store.confirmCanvasAssignmentLink(account, values.mapping!, values.proposal!);
  }
  if (action === "mappings") return store.listCanvasCourseMappings(account);
  if (action === "links") return store.listCanvasAssignmentLinks(account);
  if (action === "status") return store.listCanvasAssignmentRuns(account);
  if (action === "matches") return store.proposeCanvasAssignmentLinks(account, values.mapping!);
  if (action === "scopes") return { latestCanvasCollection: store.listCanvasAssignmentRuns(account, 1)[0] ?? null,
    canvas: store.listCanvasScopes(account), skyward: values["skyward-account"] ? store.listSkywardAssignmentScopes(values["skyward-account"]) : undefined };
  if (action === "enriched") return { latestSkywardCollection: store.listAssignmentRuns(account, 1)[0] ?? null, limit, offset,
    assignments: store.listEnrichedAssignments(account, { studentId: values.student, limit, offset }) };
  return { latestCanvasCollection: store.listCanvasAssignmentRuns(account, 1)[0] ?? null, limit, offset,
    assignments: store.listCanvasAssignments(account, { studentId: values.student, courseId: values.course, limit, offset }) };
}

export async function runCanvasCli(args: string[], root = path.resolve(__dirname, "../../..")): Promise<void> {
  const input = parseCanvasCliArgs(args);
  if (input.action === "help") { console.log(HELP); return; }
  if (["map", "confirm", "match"].includes(input.action) && !input.values["dry-run"] && !input.values.yes && !process.stdin.isTTY) {
    throw new CanvasCliUsageError("Confirmation needs an interactive terminal or explicit --yes. Review scopes and matches first.");
  }
  await withWorkspaceStore(root, async store => {
    const result = await executeCanvasCommand(store, input, async prompt => {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await terminal.question(prompt)).trim() === "CONFIRM"; }
      finally { terminal.close(); }
    });
    console.log(JSON.stringify(result, null, 2));
  });
}