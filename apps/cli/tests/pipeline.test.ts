import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { config } from "../../../packages/core/tests/review-fixtures";
import type { ReviewConfig } from "@schoolhawk/core/review";

const root = path.resolve(__dirname, "../../..");
const script = path.join(root, "scripts/run-pipeline.sh");
const terminalDriver = path.join(__dirname, "fixtures/pipeline-pty.py");
const execution = { skip: process.getuid?.() === 0 ? "Live execution mode intentionally refuses root; dry-run tests still run." : false };
const fullConfig = () => config({
  sources: [
    { portal: "canvas", accountId: "canvas-fixture", sections: ["assignments"] },
    { portal: "skyward", accountId: "skyward-fixture", sections: ["messages", "grades", "assignments"] },
  ],
  children: [],
});
const callSchema = z.object({
  args: z.array(z.string()), cwd: z.string(),
  credentials: z.object({ skywardUsername: z.boolean(), skywardPassword: z.boolean(), canvasUsername: z.boolean(), canvasPassword: z.boolean() }),
  credentialMatches: z.object({ skywardUsername: z.boolean(), skywardPassword: z.boolean(), canvasUsername: z.boolean(), canvasPassword: z.boolean() }),
  headed: z.object({ skyward: z.boolean(), canvas: z.boolean() }),
});
const noCredentials = {
  SKYWARD_USERNAME: undefined, SKYWARD_PASSWORD: undefined, CANVAS_USERNAME: undefined, CANVAS_PASSWORD: undefined,
};
type TerminalResponse = { prompt: string; input: string; secret?: boolean };
const terminalResultSchema = z.object({
  status: z.number().int(), output: z.string(), responsesSent: z.number().int(),
  echoDuringInput: z.array(z.boolean()), echoRestored: z.boolean(), error: z.string().nullable(),
});

function harness(settings: ReviewConfig = fullConfig()) {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-pipeline-"));
  const bin = path.join(directory, "bin");
  const configuration = path.join(directory, "private review $(literal);config.json");
  const trace = path.join(directory, "commands.jsonl");
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(configuration, JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const credentials = {
  skywardUsername: process.env.SKYWARD_USERNAME !== undefined, skywardPassword: process.env.SKYWARD_PASSWORD !== undefined,
  canvasUsername: process.env.CANVAS_USERNAME !== undefined, canvasPassword: process.env.CANVAS_PASSWORD !== undefined
};
const expected = JSON.parse(process.env.PIPELINE_TEST_EXPECTED_CREDENTIALS || "{}");
const credentialMatches = {
  skywardUsername: process.env.SKYWARD_USERNAME === expected.SKYWARD_USERNAME,
  skywardPassword: process.env.SKYWARD_PASSWORD === expected.SKYWARD_PASSWORD,
  canvasUsername: process.env.CANVAS_USERNAME === expected.CANVAS_USERNAME,
  canvasPassword: process.env.CANVAS_PASSWORD === expected.CANVAS_PASSWORD
};
const headed = { skyward: process.env.SKYWARD_HEADED === "1", canvas: process.env.CANVAS_HEADED === "1" };
fs.appendFileSync(process.env.PIPELINE_TEST_TRACE, JSON.stringify({ args, cwd: process.cwd(), credentials, credentialMatches, headed }) + "\\n", { mode: 0o600 });
const key = args[1] === "cli" ? "Review:" + args[4] : args[1];
const failures = JSON.parse(process.env.PIPELINE_TEST_FAILURES || "{}");
console.log("Synthetic command output");
process.exit(failures[key] || 0);
`, { mode: 0o700 });
  const environmentFor = (failures: Record<string, number>, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...process.env,
    SKYWARD_USERNAME: "synthetic-skyward-user", SKYWARD_PASSWORD: "synthetic-skyward-password",
    CANVAS_USERNAME: "synthetic-canvas-user", CANVAS_PASSWORD: "synthetic-canvas-password",
    SKYWARD_HEADED: undefined, CANVAS_HEADED: undefined, PIPELINE_TEST_EXPECTED_CREDENTIALS: undefined,
    ...environment, PATH: `${bin}:${process.env.PATH ?? ""}`,
    PIPELINE_TEST_TRACE: trace, PIPELINE_TEST_FAILURES: JSON.stringify(failures),
  });
  const calls = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n")
    .map(line => callSchema.parse(JSON.parse(line))) : [];
  return {
    directory, configuration, trace,
    run(args: string[], failures: Record<string, number> = {}, environment: NodeJS.ProcessEnv = {}) {
      if (existsSync(trace)) rmSync(trace);
      const result = spawnSync("python3", [terminalDriver, "--no-terminal", script, "--config", configuration, ...args], {
        cwd: directory,
        env: environmentFor(failures, environment),
        encoding: "utf8", timeout: 20000,
      });
      assert.equal(result.error, undefined);
      return { ...result, calls: calls() };
    },
    terminal(args: string[], responses: TerminalResponse[], environment: NodeJS.ProcessEnv = {}, bashOptions: string[] = [], stdoutFile?: string) {
      if (existsSync(trace)) rmSync(trace);
      const result = spawnSync("python3", [terminalDriver], {
        cwd: directory, env: environmentFor({}, { ...noCredentials, ...environment }),
        input: JSON.stringify({ argv: ["bash", ...bashOptions, script, "--config", configuration, ...args], responses, stdoutFile }),
        encoding: "utf8", timeout: 25000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const terminal = terminalResultSchema.parse(JSON.parse(result.stdout));
      assert.equal(terminal.error, null, terminal.output);
      assert.equal(terminal.responsesSent, responses.length, terminal.output);
      return { ...terminal, calls: calls() };
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("pipeline help and argument validation need no configuration, database or portal access", () => {
  const fixture = harness();
  try {
    rmSync(fixture.configuration);
    const help = fixture.run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /login -> collection -> change-detection -> reporting/);
    assert.match(help.stdout, /all and collection always log in first/);
    assert.deepEqual(help.calls, []);
    for (const args of [
      ["--phase"], ["--phase", "unknown"], ["--phase", "collection,"], ["--phase", ",reporting"],
      ["--phase", "collection,,reporting"], ["--phase", "all,reporting"], ["--phase", ""],
      ["--phase", "reporting", "--phase", "collection"], ["--days", "0"], ["--days", "367"],
      ["--days", "1.5"], ["--days", "999999999999"], ["--messages", "invalid"], ["--format", "pdf"], ["--unknown"],
    ]) {
      const result = fixture.run(args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /PIPELINE:/);
      assert.deepEqual(result.calls, []);
    }
    assert.equal(existsSync(path.join(fixture.directory, "logs")), false);
    assert.equal(existsSync(path.join(fixture.directory, "data")), false);
  } finally { fixture.close(); }
});

test("pipeline dry run validates private configuration without executing npm or exposing child identities", () => {
  const settings = fullConfig();
  settings.children = [{ id: "PRIVATE_CHILD", bindings: [{ portal: "skyward", accountId: "skyward-fixture", studentId: "PRIVATE_STUDENT_ID" }] }];
  const fixture = harness(settings);
  try {
    const result = fixture.run(["--dry-run", "--days=030", "--messages=all", "--format=json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /npm run skyward:login/);
    assert.match(result.stderr, /npm run canvas:login/);
    assert.match(result.stderr, /skyward:assignments -- 30 --account skyward-fixture/);
    assert.match(result.stderr, /skyward:messages -- 30 --account skyward-fixture --all/);
    assert.match(result.stderr, /canvas:assignments -- --account canvas-fixture/);
    assert.match(result.stderr, /Review run --config/);
    assert.match(result.stderr, /Review briefing --config/);
    assert.doesNotMatch(result.stderr, /--text|PRIVATE_CHILD|PRIVATE_STUDENT_ID/);
    assert.match(result.stderr, /No npm commands, database operations, or portal requests/);
    assert.deepEqual(result.calls, []);
    chmodSync(fixture.configuration, 0o644);
    const insecure = fixture.run(["--dry-run"]);
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /private, readable regular file/);
    assert.deepEqual(insecure.calls, []);
    rmSync(fixture.configuration);
    const missing = fixture.run(["--dry-run"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /configuration file not found/);
    assert.deepEqual(missing.calls, []);
  } finally { fixture.close(); }
});

test("default and all runs require both portal logins before collecting without a login flag", execution, () => {
  const fixture = harness();
  try {
    for (const args of [[], ["--phase", "all"]]) {
      const result = fixture.run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls.map(call => call.args), [
        ["run", "skyward:login"],
        ["run", "canvas:login"],
        ["run", "skyward:assignments", "--", "7", "--account", "skyward-fixture"],
        ["run", "skyward:grades", "--", "--account", "skyward-fixture"],
        ["run", "skyward:messages", "--", "7", "--account", "skyward-fixture"],
        ["run", "canvas:assignments", "--", "--account", "canvas-fixture"],
        ["run", "cli", "--", "Review", "run", "--config", fixture.configuration],
        ["run", "cli", "--", "Review", "briefing", "--config", fixture.configuration, "--text"],
      ]);
      assert(result.calls.every(call => call.cwd === root));
      assert.match(result.stderr, /exit zero is not an all-clear/);
      assert(result.calls.every(call => !call.args.some(arg => /setup|match|truncate/i.test(arg))));
    }
    assert.equal(readFileSync(fixture.configuration, "utf8"), JSON.stringify(fullConfig()));
  } finally { fixture.close(); }
});

test("explicit login runs once per configured portal before any selected collectors", execution, () => {
  const fixture = harness();
  try {
    const login = fixture.run(["--phase", "login"]);
    assert.equal(login.status, 0, login.stderr);
    assert.deepEqual(login.calls.map(call => call.args), [
      ["run", "skyward:login"], ["run", "canvas:login"],
    ]);
    const all = fixture.run(["--phase", "all", "--login"]);
    assert.equal(all.status, 0, all.stderr);
    assert.equal(all.calls.length, 8);
    assert.deepEqual(all.calls.slice(0, 2).map(call => call.args), [
      ["run", "skyward:login"], ["run", "canvas:login"],
    ]);
    assert.deepEqual(all.calls.slice(2, 6).map(call => call.args[1]), [
      "skyward:assignments", "skyward:grades", "skyward:messages", "canvas:assignments",
    ]);
    assert.deepEqual(all.calls.slice(6).map(call => call.args[4]), ["run", "briefing"]);
    const reversed = fixture.run(["--phase", "collection,login", "--login"]);
    assert.equal(reversed.status, 0, reversed.stderr);
    assert.equal(reversed.calls.filter(call => call.args[1].endsWith(":login")).length, 2);
    assert(reversed.calls.slice(0, 2).every(call => call.args[1].endsWith(":login")));
    const local = fixture.run(["--phase", "reporting", "--login"]);
    assert.equal(local.status, 0, local.stderr);
    assert.deepEqual(local.calls.map(call => call.args), [
      ["run", "skyward:login"], ["run", "canvas:login"],
      ["run", "cli", "--", "Review", "briefing", "--config", fixture.configuration, "--text"],
    ]);
  } finally { fixture.close(); }
});

test("login credentials reach only the relevant login command and never appear in command output", execution, () => {
  const fixture = harness();
  try {
    const result = fixture.run(["--login"], {}, {
      SKYWARD_USERNAME: "PRIVATE_SKYWARD_USER", SKYWARD_PASSWORD: "PRIVATE_SKYWARD_PASSWORD",
      CANVAS_USERNAME: "PRIVATE_CANVAS_USER", CANVAS_PASSWORD: "PRIVATE_CANVAS_PASSWORD",
      SKYWARD_HEADED: "1", CANVAS_HEADED: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls[0].credentials, { skywardUsername: true, skywardPassword: true, canvasUsername: false, canvasPassword: false });
    assert.deepEqual(result.calls[1].credentials, { skywardUsername: false, skywardPassword: false, canvasUsername: true, canvasPassword: true });
    assert.equal(result.calls[0].headed.skyward, true);
    assert.equal(result.calls[1].headed.canvas, true);
    assert(result.calls.slice(2).every(call => Object.values(call.credentials).every(present => !present)));
    assert.doesNotMatch(result.stdout + result.stderr + readFileSync(fixture.trace, "utf8"), /PRIVATE_SKYWARD|PRIVATE_CANVAS/);
    const noLogin = fixture.run(["--phase", "reporting"], {}, { SKYWARD_PASSWORD: "PRIVATE_UNUSED_PASSWORD", CANVAS_PASSWORD: "PRIVATE_UNUSED_PASSWORD" });
    assert.equal(noLogin.status, 0);
    assert(noLogin.calls.every(call => Object.values(call.credentials).every(present => !present)));
  } finally { fixture.close(); }
});

test("terminal prompts export exact credentials once per portal without password echo or xtrace leaks", execution, () => {
  const fixture = harness();
  const credentials = {
    SKYWARD_USERNAME: "typed-skyward-user", SKYWARD_PASSWORD: "  PRIVATE_SKYWARD $pass\\word;'\"  ",
    CANVAS_USERNAME: "typed-canvas-user", CANVAS_PASSWORD: "PRIVATE_CANVAS $(literal) \\password",
  };
  try {
    const result = fixture.terminal([], [
      { prompt: "Skyward username: ", input: `${credentials.SKYWARD_USERNAME}\n` },
      { prompt: "Skyward password: ", input: `${credentials.SKYWARD_PASSWORD}\n`, secret: true },
      { prompt: "Canvas username: ", input: `${credentials.CANVAS_USERNAME}\n` },
      { prompt: "Canvas password: ", input: `${credentials.CANVAS_PASSWORD}\n`, secret: true },
    ], { PIPELINE_TEST_EXPECTED_CREDENTIALS: JSON.stringify(credentials) }, ["-x"]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.calls.length, 8);
    assert.deepEqual(result.echoDuringInput, [true, false, true, false]);
    assert.equal(result.echoRestored, true);
    assert.equal(result.calls[0].credentialMatches.skywardUsername, true);
    assert.equal(result.calls[0].credentialMatches.skywardPassword, true);
    assert.equal(result.calls[1].credentialMatches.canvasUsername, true);
    assert.equal(result.calls[1].credentialMatches.canvasPassword, true);
    assert.equal(result.calls[0].credentials.canvasUsername, false);
    assert.equal(result.calls[1].credentials.skywardUsername, false);
    assert(result.calls.slice(2).every(call => Object.values(call.credentials).every(present => !present)));
    assert.doesNotMatch(result.output + readFileSync(fixture.trace, "utf8"), /PRIVATE_SKYWARD|PRIVATE_CANVAS/);
  } finally { fixture.close(); }
});

test("terminal login asks only for the missing credential and preserves an existing counterpart", execution, () => {
  const fixture = harness(config({ sources: [{ portal: "skyward", accountId: "skyward-fixture", sections: ["assignments"] }], children: [] }));
  const credentials = { SKYWARD_USERNAME: "existing-user", SKYWARD_PASSWORD: "PRIVATE_EXISTING_PASSWORD" };
  try {
    for (const missing of ["username", "password"] as const) {
      const result = fixture.terminal(["--phase", "login"], [{
        prompt: `Skyward ${missing}: `,
        input: `${missing === "username" ? credentials.SKYWARD_USERNAME : credentials.SKYWARD_PASSWORD}\n`,
        secret: missing === "password",
      }], {
        ...credentials,
        [missing === "username" ? "SKYWARD_USERNAME" : "SKYWARD_PASSWORD"]: undefined,
        PIPELINE_TEST_EXPECTED_CREDENTIALS: JSON.stringify(credentials),
      });
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].credentialMatches.skywardUsername, true);
      assert.equal(result.calls[0].credentialMatches.skywardPassword, true);
      assert.doesNotMatch(result.output, missing === "username" ? /Skyward password: / : /Skyward username: /);
      assert.doesNotMatch(result.output, /PRIVATE_EXISTING_PASSWORD/);
      assert.equal(result.echoRestored, true);
    }
  } finally { fixture.close(); }
});

test("terminal prompts still work with stdout redirected and do not write credentials into the output file", execution, () => {
  const fixture = harness(config({ sources: [{ portal: "skyward", accountId: "skyward-fixture", sections: ["assignments"] }], children: [] }));
  const output = path.join(fixture.directory, "command-output.txt");
  try {
    const result = fixture.terminal(["--phase", "login"], [
      { prompt: "Skyward username: ", input: "typed-user\n" },
      { prompt: "Skyward password: ", input: "PRIVATE_REDIRECTED_PASSWORD\n", secret: true },
    ], {}, [], output);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.calls.length, 1);
    assert.equal(readFileSync(output, "utf8").trim(), "Synthetic command output");
    assert.doesNotMatch(result.output, /PRIVATE_REDIRECTED_PASSWORD/);
    assert.equal(result.echoRestored, true);
  } finally { fixture.close(); }
});

test("missing credentials without a terminal fail explicitly and skip login and collection for that portal", execution, () => {
  const fixture = harness();
  try {
    const result = fixture.run([], {}, { SKYWARD_USERNAME: undefined, SKYWARD_PASSWORD: undefined });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Skyward credentials are missing and no interactive terminal is available/);
    assert.match(result.stderr, /Export SKYWARD_USERNAME and SKYWARD_PASSWORD/);
    assert(result.calls.every(call => !call.args[1].startsWith("skyward:")));
    assert(result.calls.some(call => call.args[1] === "canvas:login"));
    assert(result.calls.some(call => call.args[1] === "canvas:assignments"));
    assert(result.calls.some(call => call.args[4] === "briefing"));
    assert.match(result.stderr, /Skipping skyward\/assignments because its login failed/);
    const preview = fixture.run(["--login", "--dry-run"], {}, noCredentials);
    assert.equal(preview.status, 0);
    assert.deepEqual(preview.calls, []);
    assert.doesNotMatch(preview.stderr, /username: |password: |no interactive terminal/);
  } finally { fixture.close(); }
});

test("empty input and terminal EOF do not invoke npm login or reuse an old session", execution, () => {
  const fixture = harness(config({ sources: [{ portal: "skyward", accountId: "skyward-fixture", sections: ["assignments"] }], children: [] }));
  try {
    for (const response of [
      { prompt: "Skyward username: ", input: "\n", secret: false },
      { prompt: "Skyward password: ", input: "\n", secret: true },
      { prompt: "Skyward password: ", input: "\x04", secret: true },
    ]) {
      const result = fixture.terminal(["--phase", "login,collection"], [response],
        response.secret ? { SKYWARD_USERNAME: "existing-user" } : {});
      assert.equal(result.status, 1, result.output);
      assert.deepEqual(result.calls, []);
      assert.match(result.output, /Empty or cancelled credential input for Skyward/);
      assert.match(result.output, /Skipping skyward\/assignments because its login failed/);
      assert.equal(result.echoRestored, true);
    }
  } finally { fixture.close(); }
});

test("Ctrl-C during password entry restores terminal echo and stops the pipeline", execution, () => {
  const fixture = harness();
  try {
    const result = fixture.terminal(["--login"], [
      { prompt: "Skyward password: ", input: "\x03", secret: true },
    ], { SKYWARD_USERNAME: "existing-user" });
    assert.equal(result.status, 130, result.output);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.echoDuringInput, [false]);
    assert.equal(result.echoRestored, true);
  } finally { fixture.close(); }
});

test("Canvas manual browser mode remains available without terminal prompts or credentials", execution, () => {
  const fixture = harness(config({ sources: [{ portal: "canvas", accountId: "canvas-fixture", sections: ["assignments"] }], children: [] }));
  try {
    const result = fixture.run(["--phase", "login"], {}, { ...noCredentials, CANVAS_HEADED: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.args), [["run", "canvas:login"]]);
    assert(result.calls.every(call => Object.values(call.credentials).every(present => !present)));
    assert.equal(result.calls[0].headed.canvas, true);
    assert.match(result.stderr, /Complete Canvas credentials and verification in the browser/);
    assert.doesNotMatch(result.stderr, /Canvas username: |Canvas password: |no interactive terminal/);
  } finally { fixture.close(); }
});

test("failed login skips only that portal's collections with no retry or old-session fallback", execution, () => {
  const fixture = harness();
  try {
    for (const portal of ["skyward", "canvas"]) {
      const result = fixture.run([], { [`${portal}:login`]: 1 });
      assert.equal(result.status, 1);
      assert.equal(result.calls.filter(call => call.args[1] === `${portal}:login`).length, 1);
      assert(result.calls.every(call => !call.args[1].startsWith(`${portal}:`) || call.args[1] === `${portal}:login`));
      assert(result.calls.some(call => call.args[1] === `${portal === "skyward" ? "canvas" : "skyward"}:assignments`));
      assert(result.calls.some(call => call.args[4] === "briefing"));
      assert.match(result.stderr, new RegExp(`Skipping ${portal}/assignments because its login failed`));
      assert.match(result.stderr, /no old-session fallback or retry/);
      assert.match(result.stderr, /1 step\(s\) failed or are unsupported/);
    }
    const interrupted = fixture.run(["--login"], { "skyward:login": 130 });
    assert.equal(interrupted.status, 130);
    assert.equal(interrupted.calls.length, 1);
  } finally { fixture.close(); }
});

test("login dry-run honors the configured portal without accessing credentials or sessions", () => {
  const fixture = harness(config({
    sources: [{ portal: "canvas", accountId: "only-canvas", sections: ["assignments"] }], children: [],
  }));
  try {
    const result = fixture.run(["--phase", "login", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /npm run canvas:login/);
    assert.doesNotMatch(result.stderr, /skyward:login|canvas:assignments|Review run|Review briefing/);
    assert.deepEqual(result.calls, []);
  } finally { fixture.close(); }
});

test("phase selection honors canonical order and reporting does not recollect or call an AI provider", execution, () => {
  const fixture = harness();
  try {
    const collection = fixture.run(["--phase", "collection", "--days", "14", "--messages", "all"]);
    assert.equal(collection.status, 0);
    assert.equal(collection.calls.length, 6);
    assert.deepEqual(collection.calls.slice(0, 2).map(call => call.args), [["run", "skyward:login"], ["run", "canvas:login"]]);
    assert.deepEqual(collection.calls[4].args, ["run", "skyward:messages", "--", "14", "--account", "skyward-fixture", "--all"]);
    for (const phase of ["change-detection", "review"]) {
      const result = fixture.run(["--phase", phase]);
      assert.equal(result.status, 0);
      assert.deepEqual(result.calls.map(call => call.args), [["run", "cli", "--", "Review", "run", "--config", fixture.configuration]]);
    }
    const report = fixture.run(["--phase", "reporting", "--format", "json"]);
    assert.equal(report.status, 0);
    assert.deepEqual(report.calls.map(call => call.args), [["run", "cli", "--", "Review", "briefing", "--config", fixture.configuration]]);
    const reversed = fixture.run(["--phase", "reporting,change-detection"]);
    assert.equal(reversed.status, 0);
    assert.deepEqual(reversed.calls.map(call => call.args[4]), ["run", "briefing"]);
  } finally { fixture.close(); }
});

test("configuration controls the platform/section scope and relative paths resolve from the repository root", execution, () => {
  const fixture = harness(config({
    sources: [{ portal: "canvas", accountId: "only-canvas", sections: ["assignments"] }], children: [],
  }));
  try {
    const relative = path.relative(root, fixture.configuration);
    const result = spawnSync("python3", [terminalDriver, "--no-terminal", script, "--config", relative, "--phase", "collection"], {
      cwd: fixture.directory,
      env: { ...process.env, ...noCredentials, CANVAS_USERNAME: "synthetic-canvas-user", CANVAS_PASSWORD: "synthetic-canvas-password",
        CANVAS_HEADED: undefined, PIPELINE_TEST_FAILURES: "{}",
        PATH: `${path.join(fixture.directory, "bin")}:${process.env.PATH ?? ""}`, PIPELINE_TEST_TRACE: fixture.trace },
      encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.trace, "utf8").trim().split("\n").map(line => callSchema.parse(JSON.parse(line)));
    assert.deepEqual(calls.map(call => call.args), [
      ["run", "canvas:login"], ["run", "canvas:assignments", "--", "--account", "only-canvas"],
    ]);
  } finally { fixture.close(); }
});

test("collection errors and unsupported sections stay visible while independent work and reports continue", execution, () => {
  const settings = fullConfig();
  settings.sources[1].sections.push("attendance");
  const fixture = harness(settings);
  try {
    const result = fixture.run([], { "skyward:grades": 1 });
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 8);
    assert(result.calls.some(call => call.args[1] === "canvas:assignments"));
    assert(result.calls.some(call => call.args[4] === "briefing"));
    assert(result.calls.every(call => call.args[1] !== "skyward:attendance"));
    assert.match(result.stderr, /No collector for configured skyward\/attendance/);
    assert.match(result.stderr, /Login or collection was incomplete/);
    assert.match(result.stderr, /may not create stored collection runs/);
    assert.match(result.stderr, /2 step\(s\) failed or are unsupported/);
  } finally { fixture.close(); }
});

test("review failures skip reporting, reporting failures propagate, and interruption stops later steps", execution, () => {
  const fixture = harness();
  try {
    const review = fixture.run(["--phase", "change-detection,reporting"], { "Review:run": 2 });
    assert.equal(review.status, 1);
    assert.equal(review.calls.length, 1);
    assert.match(review.stderr, /Reporting skipped because change detection failed/);
    const report = fixture.run(["--phase", "reporting"], { "Review:briefing": 1 });
    assert.equal(report.status, 1);
    assert.equal(report.calls.length, 1);
    assert.match(report.stderr, /reporting \(exit 1\)/);
    const interrupted = fixture.run([], { "skyward:assignments": 130 });
    assert.equal(interrupted.status, 130);
    assert.deepEqual(interrupted.calls.map(call => call.args[1]), ["skyward:login", "canvas:login", "skyward:assignments"]);
  } finally { fixture.close(); }
});

test("login and collection refuse multiple account aliases sharing a portal-wide saved session", () => {
  const settings = fullConfig();
  settings.sources.push({ portal: "skyward", accountId: "second-account", sections: ["assignments"] });
  const fixture = harness(settings);
  try {
    for (const phase of ["collection", "login"]) {
      const result = fixture.run(["--dry-run", "--phase", phase]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /only one configured account per portal/);
      assert.deepEqual(result.calls, []);
    }
    const local = fixture.run(["--dry-run", "--phase", "change-detection,reporting"]);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stderr, /Review run/);
    assert.match(local.stderr, /Review briefing/);
  } finally { fixture.close(); }
});
