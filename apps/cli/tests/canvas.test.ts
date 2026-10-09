import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SqliteCanvasStore } from "@schoolhawk/storage/canvas-sqlite";
import { CanvasMappingError } from "@schoolhawk/storage/canvas-assignments";
import { executeCanvasCommand, parseCanvasCliArgs } from "../src/canvas";
import { cliFailureMessage, runCli } from "../src/index";
import { pacificDate } from "@schoolhawk/core/canvas-assignments";

test("Canvas CLI validates read-only query scope and rejects ambiguous mutation arguments", async context => {
  context.mock.method(console, "log", () => {});
  await runCli(["Canvas", "--help"], "/missing-root");
  await runCli(["Canvas", "match", "--help"], "/missing-root");
  await runCli(["Assignments", "--help"], "/missing-root");
  assert.equal(parseCanvasCliArgs(["assignments", "--account", "parent", "--student", "10", "--course", "20"]).action, "assignments");
  for (const args of [[], ["assignments"], ["assignments", "--account", "parent", "--yes"],
    ["assignments", "--account", "parent", "--course", "20"], ["assignments", "--account", "parent", "--limit", "0"],
    ["assignments", "--account", "parent", "--offset", "-1"], ["links", "--account", "parent", "--account", "other"],
    ["map", "--account", "parent"], ["confirm", "--account", "parent"]]) assert.throws(() => parseCanvasCliArgs(args));
});

test("canvas:match shortcut forwards arguments from the root and collector workspace", () => {
  const root = path.resolve(__dirname, "../../..");
  for (const cwd of [root, path.join(root, "apps/collector")]) {
    const result = spawnSync("npm", ["run", "canvas:match", "--", "--help"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm run canvas:match -- --account/);
    assert.match(result.stdout, /confirmed course mappings only/);
    assert.doesNotMatch(result.stderr, /Missing script|original key|database/i);
  }
});

test("Canvas mapping requires confirmation and does not guess student or course identities", async context => {
  context.mock.method(console, "log", () => {});
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  const capturedAt = "2026-10-08T12:00:00.000Z";
  try {
    store.importCanvasAssignmentRun("canvas-parent", { runId: randomUUID(), capturedAt, parserVersion: 1, status: "complete", discoveryComplete: true,
      students: [{ id: "10", name: "Synthetic Student", sortableName: null, status: "complete", discoveryComplete: true,
        courses: [{ id: "20", name: "Synthetic Course", code: null, termId: null, status: "complete", assignments: [], pages: 1, scannedCount: 0, verifiedEmpty: true }] }] });
    const section = { status: "complete", assignments: [], pages: 1, scannedCount: 0, verifiedEmpty: true };
    store.importAssignmentRun("skyward-parent", { runId: randomUUID(), capturedAt, parserVersion: 2, status: "complete", discoveryComplete: true,
      window: { days: 1, startDate: "2026-10-08", endDate: "2026-10-08", timeZone: "America/Los_Angeles" },
      students: [{ id: "30", name: "Student, Synthetic", firstName: "Synthetic", lastName: "Student", sections: [
        { ...section, kind: "missing" }, { ...section, kind: "past" }, { ...section, kind: "upcoming", scannedCount: 1, verifiedEmpty: false,
          assignments: [{ id: "40", title: "Work", course: "Algebra", section: "A", teacher: null, dueDate: "2026-10-09", assignedDate: null,
            description: null, category: null, grade: null, score: null, scoreStatus: null, maxScore: null, weight: null, attempts: null,
            attachmentCount: null, missing: false, source: { portal: "skyward", url: "https://example.test/assignments", capturedAt } }] },
      ] }] });
    const args = ["map", "--account", "canvas-parent", "--student", "10", "--course", "20", "--skyward-account", "skyward-parent",
      "--skyward-student", "30", "--skyward-course", "Algebra", "--skyward-section", "A"];
    assert.deepEqual(await executeCanvasCommand(store, parseCanvasCliArgs(args), async () => false), { cancelled: true });
    assert.deepEqual(store.listCanvasCourseMappings("canvas-parent"), []);
    await executeCanvasCommand(store, parseCanvasCliArgs([...args, "--yes"]), async () => assert.fail("Explicit --yes must not prompt"));
    assert.equal(store.listCanvasCourseMappings("canvas-parent").length, 1);
    assert.equal(store.listCanvasScopes("canvas-parent").length, 1);
    assert.equal(store.listSkywardAssignmentScopes("skyward-parent").length, 1);
    const output = await executeCanvasCommand(store, parseCanvasCliArgs(["enriched", "--account", "skyward-parent"]), async () => false);
    assert(output && "assignments" in output && output.assignments);
    assert.equal(output.assignments.length, 1);
  } finally { store.close(); }
});

test("Canvas match requires a bounded lookback and validates unattended and preview options", () => {
  const input = parseCanvasCliArgs(["match", "--account", "canvas-parent", "--lookback", "30", "--yes"]);
  assert.equal(input.action, "match");
  assert.equal(input.values.lookback, "30");
  assert.equal(input.values.yes, true);
  for (const days of ["0", "367", "-1", "1.5", "NaN", "1e2"]) {
    assert.throws(() => parseCanvasCliArgs(["match", "--account", "canvas-parent", "--lookback", days]));
  }
  for (const args of [["match", "--account", "canvas-parent"],
    ["match", "--account", "canvas-parent", "--lookback", "2", "--dry-run", "--yes"],
    ["match", "--account", "canvas-parent", "--lookback", "2", "--lookback", "3"],
    ["matches", "--account", "canvas-parent", "--lookback", "2"],
    ["match", "--account", "canvas-parent", "--lookback", "2", "--max-source-age-hours", "169"]]) {
    assert.throws(() => parseCanvasCliArgs(args));
  }
});

test("Canvas match reports missing mappings as setup guidance instead of a storage or deletion failure", async () => {
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  const args = ["match", "--account", "canvas-parent", "--lookback", "30"];
  try {
    for (const flag of ["--dry-run", "--yes"]) {
      await assert.rejects(executeCanvasCommand(store, parseCanvasCliArgs([...args, flag]),
        async () => assert.fail("Missing mappings must not prompt")), (error: unknown) => {
        assert(error instanceof CanvasMappingError);
        assert.equal(error.code, "NO_COURSE_MAPPINGS");
        const message = cliFailureMessage(error, ["Canvas", ...args, flag]);
        assert.match(message, /NO_COURSE_MAPPINGS/);
        assert.match(message, /Canvas scopes/);
        assert.match(message, /Canvas map/);
        assert.match(message, /npm run canvas:match -- --help/);
        assert.doesNotMatch(message, /deletion|disk availability|original key/);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    await assert.rejects(executeCanvasCommand(store,
      parseCanvasCliArgs([...args, "--mapping", randomUUID(), "--dry-run"]), async () => false), (error: unknown) => {
      assert(error instanceof CanvasMappingError);
      assert.equal(error.code, "COURSE_MAPPING_NOT_FOUND");
      const message = cliFailureMessage(error, ["Canvas", ...args]);
      assert.match(message, /Canvas mappings/);
      assert.match(message, /same --account/);
      assert.doesNotMatch(message, /deletion|original key/);
      return true;
    });
    assert.deepEqual(store.listCanvasCourseMappings("canvas-parent"), []);
    assert.deepEqual(store.listCanvasAssignmentLinks("canvas-parent"), []);
  } finally { store.close(); }
});

test("CLI unexpected failures stay private and only deletion commands mention deletion rollback", () => {
  const error = new Error("synthetic-private-password /private/path?token=synthetic-private-token");
  for (const args of [["Canvas", "match"], ["Assignments"], ["Messages"]]) {
    const message = cliFailureMessage(error, args);
    assert.match(message, /Private error details withheld/);
    assert.doesNotMatch(message, /synthetic-private|\/private\/path|deletion/);
  }
  const deletion = cliFailureMessage(error, ["Truncate"]);
  assert.match(deletion, /Any failed deletion transaction was rolled back/);
  assert.doesNotMatch(deletion, /synthetic-private/);
  assert.doesNotMatch(cliFailureMessage(new Error("No confirmed course mapping. synthetic-private"), ["Canvas", "match"]), /synthetic-private|NO_COURSE_MAPPINGS/);
});

test("Canvas match previews, cancels, confirms, and supports idempotent unattended retries", async context => {
  context.mock.method(console, "log", () => {});
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  const capturedAt = new Date().toISOString();
  const today = pacificDate(capturedAt);
  try {
    store.importCanvasAssignmentRun("canvas-parent", { runId: randomUUID(), capturedAt, parserVersion: 1, status: "complete", discoveryComplete: true,
      students: [{ id: "10", name: "Synthetic Student", sortableName: null, status: "complete", discoveryComplete: true,
        courses: [{ id: "20", name: "Synthetic Course", code: null, termId: null, status: "complete", pages: 1, scannedCount: 1, verifiedEmpty: false,
          assignments: [{ id: "50", courseId: "20", title: "Work", description: "Synthetic instructions", dueAt: capturedAt, dueDate: today,
            unlockAt: null, lockAt: null, createdAt: null, updatedAt: null, pointsPossible: 5, gradingType: "points", submissionTypes: ["on_paper"],
            allowedExtensions: [], externalTool: false, lockedForUser: false, hasOverrides: null,
            source: { portal: "canvas", url: "https://example.test/courses/20/assignments/50", capturedAt, dateScope: "student" } }] }] }] });
    const empty = { status: "complete", assignments: [], pages: 1, scannedCount: 0, verifiedEmpty: true };
    store.importAssignmentRun("skyward-parent", { runId: randomUUID(), capturedAt, parserVersion: 2, status: "complete", discoveryComplete: true,
      window: { days: 1, startDate: today, endDate: today, timeZone: "America/Los_Angeles" },
      students: [{ id: "30", name: "Student, Synthetic", firstName: "Synthetic", lastName: "Student", sections: [
        { ...empty, kind: "missing" }, { ...empty, kind: "upcoming" }, { ...empty, kind: "past", scannedCount: 1, verifiedEmpty: false,
          assignments: [{ id: "40", title: "Work", course: "Algebra", section: "A", teacher: null, dueDate: today, assignedDate: null,
            description: null, category: null, grade: null, score: null, scoreStatus: null, maxScore: "5", weight: null, attempts: null,
            attachmentCount: null, missing: false, source: { portal: "skyward", url: "https://example.test/assignments", capturedAt } }] },
      ] }] });
    store.saveCanvasCourseMapping("canvas-parent", { canvasStudentId: "10", canvasCourseId: "20", skywardAccountId: "skyward-parent",
      skywardStudentId: "30", skywardCourse: "Algebra", skywardSection: "A" });
    const args = ["match", "--account", "canvas-parent", "--lookback", "1"];
    const preview = await executeCanvasCommand(store, parseCanvasCliArgs([...args, "--dry-run"]), async () => assert.fail("Preview must not prompt"));
    assert(preview && "wouldLink" in preview);
    assert.equal(preview.wouldLink, 1);
    assert.equal(store.listAssignments("skyward-parent")[0].canvasStatus, "pending");
    assert.deepEqual(await executeCanvasCommand(store, parseCanvasCliArgs(args), async () => false), { cancelled: true });
    assert.equal(store.listCanvasAssignmentLinks("canvas-parent").length, 0);
    const matched = await executeCanvasCommand(store, parseCanvasCliArgs(args), async () => true);
    assert(matched && "linked" in matched);
    assert.equal(matched.linked, 1);
    const repeated = await executeCanvasCommand(store, parseCanvasCliArgs([...args, "--yes"]), async () => assert.fail("--yes must not prompt"));
    assert(repeated && "alreadyLinked" in repeated);
    assert.equal(repeated.alreadyLinked, 1);
    const output = store.listEnrichedAssignments("skyward-parent")[0];
    assert.equal(output.canvasStatus, "linked");
    assert.equal(output.skyward.observedInLatestCollection, true);
    assert.equal(output.canvas?.record.assignment.description, "Synthetic instructions");
    assert.deepEqual(output.canvas?.conflicts, []);
  } finally { store.close(); }
});