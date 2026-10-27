import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PipelineEnvironmentError, readPipelineEnvironment } from "../../../scripts/pipeline-env";

function fixture(contents: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-dotenv-"));
  const file = path.join(directory, "private.env");
  writeFileSync(file, contents, { mode: 0o600 });
  return { directory, file, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("dotenv loading preserves quoted whitespace, multiline values and literal shell syntax", () => {
  const input = fixture([
    "# Synthetic settings only",
    "export SKYWARD_USERNAME=fixture-user",
    "SKYWARD_PASSWORD='  PRIVATE $HOME $(not-executed) `literal` # \"quoted\" \\path  '",
    'CANVAS_PASSWORD="first\nsecond\n"',
    "CANVAS_USERNAME=fixture-canvas # comment",
    "AZURE_FOUNDRY_API_KEY=PRIVATE_KEY",
  ].join("\n"));
  try {
    const original = readFileSync(input.file, "utf8");
    const result = readPipelineEnvironment(input.file, {}, true);
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.values, {
      SKYWARD_USERNAME: "fixture-user",
      SKYWARD_PASSWORD: '  PRIVATE $HOME $(not-executed) `literal` # "quoted" \\path  ',
      CANVAS_PASSWORD: "first\nsecond\n",
      CANVAS_USERNAME: "fixture-canvas",
      AZURE_FOUNDRY_API_KEY: "PRIVATE_KEY",
    });
    assert.equal(readFileSync(input.file, "utf8"), original);
  } finally { input.close(); }
});

test("exported values, including empty values, override dotenv without mutating the caller", () => {
  const input = fixture("SKYWARD_USERNAME=file-user\nSKYWARD_PASSWORD=file-password\nCANVAS_USERNAME=file-canvas\n");
  const existing = { SKYWARD_USERNAME: "exported-user", SKYWARD_PASSWORD: "" };
  try {
    assert.deepEqual(readPipelineEnvironment(input.file, existing, true).values, { CANVAS_USERNAME: "file-canvas" });
    assert.deepEqual(existing, { SKYWARD_USERNAME: "exported-user", SKYWARD_PASSWORD: "" });
  } finally { input.close(); }
});

test("Brevo credentials, sender settings and recipient lists are supported without evaluating their contents", () => {
  const input = fixture([
    "BREVO_KEY=PRIVATE_KEY",
    "BREVIO_KEY=PRIVATE_ALIAS",
    "BREVO_SENDER_EMAIL=sender@example.test",
    "BREVO_SENDER_NAME=SchoolHawkAI",
    "BREVO_SMS_SENDER=SchoolHawk",
    "REPORT_EMAIL_RECIPIENTS=parent@example.test,other@example.test",
    "REPORT_SMS_RECIPIENTS=+12025550123",
  ].join("\n"));
  try {
    const result = readPipelineEnvironment(input.file, {}, true);
    assert.equal(result.values.BREVO_KEY, "PRIVATE_KEY");
    assert.equal(result.values.BREVIO_KEY, "PRIVATE_ALIAS");
    assert.equal(result.values.REPORT_EMAIL_RECIPIENTS, "parent@example.test,other@example.test");
    assert.equal(result.values.REPORT_SMS_RECIPIENTS, "+12025550123");
  } finally { input.close(); }
});
test("only the missing optional default is tolerated; unsafe, required, oversized and invalid files fail explicitly", () => {
  const input = fixture("SKYWARD_PASSWORD=PRIVATE");
  try {
    const missing = path.join(input.directory, "missing.env");
    assert.deepEqual(readPipelineEnvironment(missing, {}, false), { status: "missing", values: {} });
    assert.throws(() => readPipelineEnvironment(missing, {}, true), PipelineEnvironmentError);
    chmodSync(input.file, 0o644);
    assert.throws(() => readPipelineEnvironment(input.file, {}), PipelineEnvironmentError);
    chmodSync(input.file, 0o600);
    const link = path.join(input.directory, "link.env");
    symlinkSync(input.file, link);
    assert.throws(() => readPipelineEnvironment(link, {}), PipelineEnvironmentError);
    assert.throws(() => readPipelineEnvironment(input.directory, {}), PipelineEnvironmentError);
    writeFileSync(input.file, "SKYWARD_PASSWORD=" + "x".repeat(100000));
    assert.throws(() => readPipelineEnvironment(input.file, {}), /100 KB/);
    writeFileSync(input.file, "SKYWARD_PASSWORD='PRIVATE\0VALUE'");
    assert.throws(() => readPipelineEnvironment(input.file, {}), PipelineEnvironmentError);
  } finally { input.close(); }
});

test("shell and runtime startup settings are rejected without emitting partially loaded credentials", () => {
  const input = fixture("");
  const root = path.resolve(__dirname, "../../..");
  try {
    for (const name of ["PATH", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD", "UNKNOWN_SETTING"]) {
      writeFileSync(input.file, `SKYWARD_PASSWORD=PRIVATE_PASSWORD\n${name}=PRIVATE_VALUE\n`);
      assert.throws(() => readPipelineEnvironment(input.file, {}), error =>
        error instanceof PipelineEnvironmentError && !error.message.includes("PRIVATE"));
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/pipeline-env.ts", input.file, "required"], {
      cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /PRIVATE_PASSWORD|PRIVATE_VALUE/);
  } finally { input.close(); }
});
