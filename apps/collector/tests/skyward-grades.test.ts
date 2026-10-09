import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { collectGrades, collectGradesToStore, GRADES_URL, gradeRequestStudentIds, gradeSummary, parseGradeOptions } from "../src/skyward-grades";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const home = "https://www.q.wa-k12.net/lkwash/Home";
const now = new Date("2026-09-27T12:00:00.000Z");
type Options = { empty?: boolean; missingResponse?: boolean; wrongStudent?: boolean; truncated?: boolean; capped?: boolean;
  missingEmptyMarker?: boolean; duplicateBucket?: boolean; headerChanged?: boolean; rowMismatch?: boolean; missingNames?: boolean };

async function fixture(page: Page, options: Options = {}) {
  const students = ["1", "2"];
  const dashboard = `<a href="/logout">Sign Out</a><a id="-studentGrades_Widget" data-studentid="" href="${GRADES_URL}">Grading</a>` + students.map(student =>
    `<div class="familyAccessHeaderSelectTile" data-studentid="${student}"><span class="familyAccessStudentNameText">Synthetic Family,</span>${options.missingNames ? "" : `<span class="familyAccessStudentNameText">Student ${student}</span>`}</div><a id="${student}-studentGrades_Widget" data-studentid="${student}">Grading</a>`).join("");
  const pageHtml = `<a href="/logout">Sign Out</a><script>
    ${JSON.stringify(students)}.forEach(student => fetch('/lkwash/Grading/StudentSection/GetBrowse', {
      method: 'POST', body: JSON.stringify({ queryParameterData: JSON.stringify({ StudentID: student }) })
    }));</script>`;
  await page.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/lkwash/Grading/StudentSection/GetBrowse") {
      const { StudentID: student } = JSON.parse(route.request().postDataJSON().queryParameterData);
      if (student === "2" && options.missingResponse) return route.abort();
      const empty = options.empty && student === "2";
      const headers = [options.headerChanged ? "Changed header" : "Class", "Missing Assignments", "T1", "T2"]
        .map((label, index) => `<th data-column-index="${index}"><div class="headerTextContainerDiv">${label}</div></th>`).join("");
      const id = `StudentGrades-${student}00`;
      const rows = empty ? "" : `<tr class="browseRow" id="${id}_unlockedRow0"><td data-column="0"><a class="studentGradesClassCell"
        data-studentid="${options.wrongStudent && student === "2" ? "1" : student}" data-studentsectionid="10${student}"
        data-coursedescription="Synthetic course" data-coursecode="SYNTH"><div class="fivetoppadding">Synthetic class details</div></a></td>
        <td data-column="1"></td><td data-column="2" data-student-grade-bucket-id="1001"><a class="progressReportBreakdownGradeMarkCode progressReportDetailOpenGrade"><span class="anchorText">${student === "1" ? "A" : "0"}</span></a></td>
        ${options.rowMismatch ? "" : `<td data-column="2" data-student-grade-bucket-id="${options.duplicateBucket ? "1001" : "1002"}"><a class="progressReportBreakdownGradeMarkCode progressReportDetailClosedGrade"><svg></svg></a></td>`}</tr>`;
      const html = `<div class="browse" id="${id}"><table><thead><tr class="unlockedHeaderTableRow">${headers}</tr></thead><tbody>${rows}</tbody></table>
        ${empty && !options.missingEmptyMarker ? '<div class="noRecordsInBrowse">No records</div>' : ""}</div>`;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ html,
        script: `skyward.browse.registerBrowse(${JSON.stringify({ browseName: id, browseRequestName: "StudentGrades", skywardID: "shared-template",
          recordCount: options.truncated && student === "2" ? 2 : 1, rowsPerPageCap: options.capped ? 100 : null })});` }) });
    }
    return route.fulfill({ contentType: "text/html", body: route.request().url() === home ? dashboard : pageHtml });
  });
  await page.goto(home);
}

test("grade options require one account and reject day counts before portal access", () => {
  assert.deepEqual(parseGradeOptions(["--account", "parent"]), { accountId: "parent" });
  assert.deepEqual(parseGradeOptions(["--account=parent"]), { accountId: "parent" });
  for (const args of [[], ["7", "--account", "parent"], ["--account", "parent~"], ["--account", "parent", "--account=other"], ["--all"]]) {
    assert.throws(() => parseGradeOptions(args));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/skyward-grades.ts")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skyward:grades/);
  assert.match(result.stderr, /No portal access was attempted/);
  assert.deepEqual(gradeRequestStudentIds({ queryParameterData: '{"StudentID":"12"}', postData: '{"StudentID":"12"}' }), ["12"]);
  assert.deepEqual(gradeRequestStudentIds({ queryParameterData: '{"StudentID":"12"}', postData: '{"StudentID":"13"}' }), ["12", "13"]);
});

test("collects all students and grading periods with stable source IDs and preserves blank grades versus zero", async () => {
  const page = await browser.newPage();
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    await fixture(page);
    const run = await collectGradesToStore(page, store, "parent", now, 500);
    assert.equal(run.status, "complete");
    assert.equal(run.students.length, 2);
    assert.deepEqual(run.students.map(student => student.grades.map(grade => grade.grade)), [["A", null], ["0", null]]);
    for (const student of run.students) {
      assert.equal(student.firstName, `Student ${student.id}`);
      assert.equal(student.lastName, "Synthetic Family");
      assert.deepEqual(student.periods, ["T1", "T2"]);
      assert.deepEqual(student.grades.map(grade => grade.periodStatus), ["open", "closed"]);
      assert(student.grades.every(grade => grade.score === null && grade.gradingScale === null));
    }
    assert.deepEqual(store.getGradeRun("parent", run.runId), run);
    assert.equal(store.listGrades("parent").length, 4);
    assert.equal(store.listGrades("parent", { studentId: "2" }).length, 2);
    assert.equal(store.importGradeRun("parent", run), "already-imported");
    assert.equal(JSON.stringify(gradeSummary(run)).includes("Synthetic"), false);
    await page.goto(home);
    await assert.rejects(() => collectGradesToStore(page, { importGradeRun() { throw new Error("Synthetic write failure"); } }, "parent", now, 500), /Synthetic write failure/);
  } finally { await page.close(); store.close(); }
});

test("empty grades require both student binding and the explicit empty marker", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page, { empty: true });
    const run = await collectGrades(page, now, 500);
    assert.equal(run.status, "complete");
    assert.equal(run.students[1].verifiedEmpty, true);
    assert.deepEqual(run.students[1].grades, []);
  } finally { await page.close(); }
});

test("missing, truncated, inconsistent, and cross-student grade results cannot claim complete coverage", async () => {
  const page = await browser.newPage();
  try {
    for (const options of [{ missingResponse: true }, { wrongStudent: true }, { truncated: true }, { capped: true },
      { empty: true, missingEmptyMarker: true }, { duplicateBucket: true }, { headerChanged: true }, { rowMismatch: true }, { missingNames: true }]) {
      await page.unroute("**/*");
      await fixture(page, options);
      const run = await collectGrades(page, now, 300);
      assert.notEqual(run.status, "complete");
      assert(run.students.some(student => student.status !== "complete") || !run.discoveryComplete);
    }
  } finally { await page.close(); }
});

test("expired grade sessions are auth-required and not empty grade collections", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<input type="password">' }));
    await page.goto(home);
    const run = await collectGrades(page, now, 100);
    assert.equal(run.status, "auth-required");
    assert.equal(run.discoveryComplete, false);
  } finally { await page.close(); }
});