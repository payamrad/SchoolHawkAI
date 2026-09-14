import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

export function checkPrivatePath(filePath: string, directory = false): void {
  const info = lstatSync(filePath);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Storage path must be private and owned by the current user.");
}

export function prepareDatabaseFile(filePath: string): void {
  const directory = path.dirname(path.resolve(filePath));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkPrivatePath(directory, true);
  try { closeSync(openSync(filePath, "wx", 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkPrivatePath(filePath);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${filePath}${suffix}`)) checkPrivatePath(`${filePath}${suffix}`);
  }
}