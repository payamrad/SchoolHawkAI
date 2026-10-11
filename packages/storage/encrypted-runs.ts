import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { messageRunSchema, type MessageRun } from "@schoolhawk/core/messages";
import type { MessageStore } from "./messages";
import { checkPrivatePath } from "./private-files";
import { DiagnosticLogError, diagnosticErrorType, reportDiagnostic } from "@schoolhawk/core/diagnostics";

export function encryptRun(run: MessageRun, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(run), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptRun(envelope: ReturnType<typeof encryptRun>, key: Buffer): MessageRun {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted result.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return messageRunSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")));
}

export async function importEncryptedRuns(directory: string, accountId: string, key: Buffer, store: MessageStore) {
  checkPrivatePath(directory, true);
  const files = (await readdir(directory)).filter(name => name.endsWith(".json.enc")).sort();
  const summary = { files: files.length, imported: 0, alreadyImported: 0, verified: 0, rejected: 0 };
  for (const [index, name] of files.entries()) {
    try {
      const filePath = path.join(directory, name);
      checkPrivatePath(filePath);
      if ((await lstat(filePath)).size > 50 * 1024 * 1024) throw new Error("Input exceeds size limit.");
      const run = decryptRun(JSON.parse(await readFile(filePath, "utf8")), key);
      run.selection ??= "all";
      const outcome = store.importRun(accountId, run);
      if (outcome === "imported") summary.imported++;
      else summary.alreadyImported++;
      if (!isDeepStrictEqual(store.getRun(accountId, run.runId), run)) throw new Error("Stored run differs from source.");
      summary.verified++;
    } catch (error) {
      if (error instanceof DiagnosticLogError) throw error;
      summary.rejected++;
      reportDiagnostic({ code: "IMPORT_REJECTED", section: "storage", record: index + 1, errorType: diagnosticErrorType(error) });
    }
  }
  reportDiagnostic({ level: summary.rejected ? "warn" : "info", code: "IMPORT_SUMMARY", section: "storage",
    status: summary.rejected ? summary.verified ? "partial" : "failed" : "complete",
    counts: { scanned: summary.files, accepted: summary.verified, skipped: summary.rejected } });
  return summary;
}