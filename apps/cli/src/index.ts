import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { MessageStore } from "@schoolhawk/storage/messages";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";

const HELP = `SchoolHawkAI

Usage: npm run cli -- Truncate --LoginNotification --account <alias> [--dry-run | --yes]
  npm run cli -- Messages --account <alias> -- <N>

Messages prints up to N stored messages as JSON, newest sent date first (N: 1-1000).
Uses the latest complete observation per message ID. Output includes decrypted
sender, subject, and body; protect terminal output and redirected files.

Truncate deletes matching login notifications and all their historical observations
for the specified account. Other messages, backups, and saved files are unchanged.
--dry-run  Preview counts without deleting records.
--yes      Delete without the interactive confirmation.
--help     Show this help.

Without --yes, deletion requires interactive confirmation. Keep a protected backup
before deleting data. Future collections can collect these notifications again.`;

class CliUsageError extends Error {}

export interface TruncateInput {
  accountId: string;
  LoginNotification: true;
  dryRun: boolean;
  yes: boolean;
}

export interface MessagesInput {
  accountId: string;
  count: number;
}

export function parseCliArgs(args: string[]): { command: "help" } | { command: "Truncate"; options: TruncateInput } |
  { command: "Messages"; options: MessagesInput } {
  if ((args.length === 1 && args[0] === "--help") ||
      (args.length === 2 && ["Truncate", "Messages"].includes(args[0]) && args[1] === "--help")) return { command: "help" };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      LoginNotification: { type: "boolean" }, account: { type: "string" },
      "dry-run": { type: "boolean" }, yes: { type: "boolean" },
    } });
  } catch { throw new CliUsageError("Unknown option or missing option value. Use --help for usage."); }
  const { values, positionals } = parsed;
  if (!["Truncate", "Messages"].includes(positionals[0])) {
    throw new CliUsageError("Specify Messages or Truncate. Use --help for usage.");
  }
  if (!values.account || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.account)) {
    throw new CliUsageError("Provide --account with an alias containing letters, digits, underscores, or hyphens.");
  }
  if (args.filter(arg => arg === "--account" || arg.startsWith("--account=")).length !== 1) {
    throw new CliUsageError("Specify --account exactly once.");
  }
  if (positionals[0] === "Messages") {
    if (values.LoginNotification !== undefined || values["dry-run"] !== undefined || values.yes !== undefined) {
      throw new CliUsageError("Messages does not accept Truncate options. Use Messages --account <alias> -- <N>.");
    }
    const count = Number(positionals[1]);
    if (positionals.length !== 2 || !/^\d+$/.test(positionals[1]) || !Number.isInteger(count) || count < 1 || count > 1000) {
      throw new CliUsageError("Provide one message count N between 1 and 1000. Example: Messages --account lkwash-parent -- 10");
    }
    return { command: "Messages", options: { accountId: values.account, count } };
  }
  if (positionals.length !== 1 || !values.LoginNotification) {
    throw new CliUsageError("Specify Truncate --LoginNotification. No unrestricted deletion is supported.");
  }
  if (values["dry-run"] && values.yes) throw new CliUsageError("Use either --dry-run or --yes, not both.");
  return { command: "Truncate", options: {
    accountId: values.account, LoginNotification: true, dryRun: values["dry-run"] ?? false, yes: values.yes ?? false,
  } };
}

export function Messages(store: Pick<MessageStore, "listMessages">, options: MessagesInput) {
  const messages = store.listMessages(options.accountId, { limit: options.count });
  console.log(JSON.stringify(messages, null, 2));
  return messages;
}

export async function Truncate(store: Pick<MessageStore, "truncateMessages">, options: TruncateInput,
  confirm: () => Promise<boolean>) {
  if (options.LoginNotification !== true) throw new CliUsageError("Specify --LoginNotification.");
  const preview = store.truncateMessages(options.accountId, { target: "LoginNotification", dryRun: true });
  if (options.dryRun) {
    console.log(JSON.stringify(preview, null, 2));
    return preview;
  }
  if (!preview.messages) {
    console.log("No matching login notifications. Nothing deleted.");
    return preview;
  }
  console.log(`Delete ${preview.messages} login notifications (${preview.observations} historical observations in ${preview.runs} runs) for ${options.accountId}?`);
  if (!options.yes && !await confirm()) {
    console.log("Cancelled. Nothing deleted.");
    return undefined;
  }
  const result = store.truncateMessages(options.accountId, { target: "LoginNotification" });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function runCli(args: string[], root = path.resolve(__dirname, "../../..")): Promise<void> {
  process.umask(0o077);
  const command = parseCliArgs(args);
  if (command.command === "help") {
    console.log(HELP);
    return;
  }
  if (command.command === "Truncate" && !command.options.dryRun && !command.options.yes && !process.stdin.isTTY) {
    throw new CliUsageError("Deletion needs an interactive terminal. Use --dry-run to preview or --yes to explicitly authorize deletion.");
  }
  const auth = path.join(root, "playwright/.auth");
  const keyPath = path.join(auth, "messages.key");
  const data = path.join(root, "data");
  const databasePath = path.join(data, "database/schoolhawk.sqlite");
  for (const directory of [auth, data, path.dirname(databasePath)]) checkPrivatePath(directory, true);
  checkPrivatePath(keyPath);
  checkPrivatePath(databasePath);
  const key = readFileSync(keyPath);
  try {
    const store = new SqliteMessageStore(databasePath, key);
    try {
      if (command.command === "Messages") {
        Messages(store, command.options);
        return;
      }
      await Truncate(store, command.options, async () => {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try { return (await terminal.question("Type DELETE to confirm: ")).trim() === "DELETE"; }
        finally { terminal.close(); }
      });
    } finally { store.close(); }
  } finally { key.fill(0); }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof CliUsageError ? error.message :
      "CLI command failed. Check the existing database, original key, private permissions, and disk availability. Any failed deletion transaction was rolled back. Private error details withheld.");
    process.exitCode = 1;
  });
}