import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { diagnosticErrorCode } from "@schoolhawk/core/diagnostics";

const variables = new Set([
  "SKYWARD_USERNAME", "SKYWARD_PASSWORD", "SKYWARD_HEADED", "SKYWARD_SUCCESS_SELECTOR",
  "CANVAS_USERNAME", "CANVAS_PASSWORD", "CANVAS_HEADED", "CANVAS_SUCCESS_SELECTOR",
  "AZURE_FOUNDRY_AGENT_ENDPOINT", "AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_API_VERSION",
  "AZURE_FOUNDRY_TIMEOUT_MS", "AZURE_FOUNDRY_MAX_REQUEST_BYTES",
  "BREVO_KEY", "BREVIO_KEY", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME", "BREVO_SMS_SENDER",
  "REPORT_EMAIL_RECIPIENTS", "REPORT_SMS_RECIPIENTS",
]);

export class PipelineEnvironmentError extends Error {}

export function readPipelineEnvironment(file: string, existing: NodeJS.ProcessEnv = process.env, required = false): {
  status: "loaded" | "missing"; values: Record<string, string>;
} {
  let contents: string;
  try {
    checkPrivatePath(file);
    if (lstatSync(file).size > 100000) throw new PipelineEnvironmentError("The environment file exceeds 100 KB. No values were loaded.");
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof PipelineEnvironmentError) throw error;
    if (diagnosticErrorCode(error) === "ENOENT" && !required) return { status: "missing", values: {} };
    throw new PipelineEnvironmentError(
      "Cannot read the pipeline environment file. It must exist when explicitly selected and be a private regular file " +
      "owned by the app user (0600), not a symlink. No values were loaded.",
    );
  }
  if (Buffer.byteLength(contents, "utf8") > 100000 || contents.includes("\0")) {
    throw new PipelineEnvironmentError("Invalid or oversized environment file. No values were loaded.");
  }
  let parsed: NodeJS.Dict<string>;
  try { parsed = parseEnv(contents); }
  catch { throw new PipelineEnvironmentError("Cannot parse the environment file as Node-compatible dotenv data. No values were loaded."); }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!variables.has(name) || typeof value !== "string" || value.includes("\0")) {
      throw new PipelineEnvironmentError(
        "Unsupported environment variable or value. Only documented Skyward, Canvas, Azure Foundry, and Brevo settings are accepted; " +
        "shell/runtime startup variables are not allowed. No values were loaded.",
      );
    }
    if (existing[name] === undefined) values[name] = value;
  }
  return { status: "loaded", values };
}

if (require.main === module) {
  try {
    const [file, mode, ...extra] = process.argv.slice(2);
    if (!file || !["optional", "required"].includes(mode) || extra.length || process.stdout.isTTY) {
      throw new PipelineEnvironmentError("The environment loader is internal to the pipeline and requires a private output pipe.");
    }
    const result = readPipelineEnvironment(file, process.env, mode === "required");
    // NUL framing preserves literal shell characters and multiline passwords without evaluation.
    process.stdout.write(Buffer.concat(Object.entries(result.values).map(([name, value]) => Buffer.from(`${name}\0${value}\0`))));
    console.error(result.status === "loaded"
      ? "PIPELINE: Loaded private environment settings; existing exported variables take precedence."
      : "PIPELINE: Optional .env file not found; using existing environment settings or login prompts.");
  } catch (error) {
    console.error("PIPELINE: " + (error instanceof PipelineEnvironmentError ? error.message :
      "Environment loading failed. Private error details were withheld."));
    process.exitCode = 1;
  }
}
