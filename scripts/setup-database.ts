import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SqliteMessageStore } from "../packages/storage/sqlite-message-store";
import { checkPrivatePath } from "../packages/storage/private-files";
import { DiagnosticLogError, reportDiagnostic, withLocalDiagnostics } from "../packages/storage/diagnostics";

class SetupError extends Error {}

function present(filePath: string): boolean {
  try { lstatSync(filePath); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function setupDatabase(root: string): void {
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "PRIVATE_DATABASE_KEY" });
  const auth = path.join(root, "playwright/.auth");
  const data = path.join(root, "data");
  const keyPath = path.join(auth, "messages.key");
  if (present(data)) checkPrivatePath(data, true);
  mkdirSync(auth, { recursive: true, mode: 0o700 });
  checkPrivatePath(auth, true);
  if (!present(keyPath)) {
    if (present(data) && readdirSync(data).length > 0) {
      throw new SetupError("Existing data found without messages.key. Restore the original key before setup; a replacement cannot decrypt existing data.");
    }
    const generatedKey = randomBytes(32);
    try {
      const descriptor = openSync(keyPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, generatedKey);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
    } finally { generatedKey.fill(0); }
  }
  checkPrivatePath(keyPath);
  const key = readFileSync(keyPath);
  try {
    if (key.length !== 32) throw new SetupError("messages.key must contain exactly 32 bytes. Restore the original key; setup will not replace it.");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    checkPrivatePath(data, true);
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", stage: "DATABASE_OPEN" });
    const store = new SqliteMessageStore(path.join(data, "database/schoolhawk.sqlite"), key);
    store.close();
  } finally { key.fill(0); }
}

if (require.main === module) {
  process.umask(0o077);
  const root = path.resolve(__dirname, "..");
  withLocalDiagnostics(root, "setup", () => {
    setupDatabase(root);
    console.log("Database ready: data/database/schoolhawk.sqlite");
    console.log("Keep a separately protected recovery copy of playwright/.auth/messages.key. No source files were imported or deleted.");
  }).catch((error: unknown) => {
    console.error(error instanceof SetupError || error instanceof DiagnosticLogError ? error.message :
      "Database setup failed. Check ownership/private permissions, dependencies, and the original encryption key. Existing files were not replaced; private error details withheld.");
    process.exitCode = 1;
  });
}