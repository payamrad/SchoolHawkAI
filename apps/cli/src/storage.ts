import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { importEncryptedRuns } from "@schoolhawk/storage/encrypted-runs";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { DiagnosticLogError, reportDiagnostic, withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";

const ROOT = path.resolve(__dirname, "../../..");
let stage = "ARGUMENTS";

async function main() {
  process.umask(0o077);
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "CONFIGURATION" });
  const { values, positionals } = parseArgs({ options: { account: { type: "string" } }, allowPositionals: true });
  const command = positionals[0];
  if (positionals.length !== 1 || !["import", "status", "backup"].includes(command) ||
      !values.account || !/^[a-zA-Z0-9_-]{1,100}$/.test(values.account)) throw new Error();
  stage = "PRIVATE_KEY";
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "PRIVATE_DATABASE_KEY" });
  const auth = path.join(ROOT, "playwright/.auth");
  const keyPath = path.join(auth, "messages.key");
  checkPrivatePath(auth, true);
  checkPrivatePath(keyPath);
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error();
  stage = "DATABASE_OPEN";
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "DATABASE_OPEN" });
  const data = path.join(ROOT, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  checkPrivatePath(data, true);
  const databasePath = path.join(data, "database/schoolhawk.sqlite");
  const store = new SqliteMessageStore(databasePath, key);
  try {
    stage = "IMPORT";
    if (command === "import") {
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "IMPORT" });
      const summary = await importEncryptedRuns(path.join(data, "messages"), values.account, key, store);
      console.log(JSON.stringify({ ...summary, sourceFilesDeleted: 0, database: path.relative(ROOT, databasePath) }, null, 2));
      if (summary.rejected) process.exitCode = 1;
    } else if (command === "backup") {
      stage = "BACKUP";
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "BACKUP" });
      const destination = path.join(data, "backups", `${randomUUID()}.sqlite`);
      await store.backup(destination);
      console.log(JSON.stringify({ backup: path.relative(ROOT, destination), includesAllAccounts: true }));
    } else {
      stage = "STATUS";
      reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "STATUS" });
      console.log(JSON.stringify({ recentRuns: store.listRuns(values.account), limit: 100 }, null, 2));
    }
  } finally {
    store.close();
    key.fill(0);
  }
}

withLocalDiagnostics(ROOT, "data", main).catch((error: unknown) => {
  console.error(error instanceof DiagnosticLogError ? `LOCAL_LOG: ${error.message}` :
    `STORAGE: Failed at ${stage}. Usage from the repository root: npm run data -- import|status|backup --account lkwash-parent. Check private paths and the existing messages.key; do not replace a lost key. Private error details withheld.`);
  process.exitCode = 1;
});