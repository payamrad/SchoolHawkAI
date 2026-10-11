import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { DiagnosticLogError, withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { collectGrades, collectGradesToStore, GRADES_URL, gradeRequestStudentIds, gradeSummary, parseGradeOptions,
  parseGradeSnapshot, type gradeSnapshot } from "../src/skyward-grades";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const home = "https://www.q.wa-k12.net/lkwash/Home";
const now = new Date("2026-09-27T12:00:00.000Z");
type Options = { empty?: boolean; missingResponse?: boolean; wrongStudent?: boolean; truncated?: boolean; capped?: boolean;
  missingEmptyMarker?: boolean; duplicateBucket?: boolean; headerChanged?: boolean; rowMismatch?: boolean; missingNames?: boolean;
  extraBrowses?: ("unbound" | "ambiguous" | "conflict" | "duplicate" | "same-scope")[];
  responseError?: "json" | "payload" | "registration" | "http" };

async function fixture(page: Page, options: Options = {}) {
  const students = ["1", "2"];
  const dashboard = `<a href="/logout">Sign Out</a><a id="-studentGrades_Widget" data-studentid="" href="${GRADES_URL}">Grading</a>` + students.map(student =>
    `<div class="familyAccessHeaderSelectTile" data-studentid="${student}"><span class="familyAccessStudentNameText">Synthetic Family,</span>${options.missingNames ? "" : `<span class="familyAccessStudentNameText">Student ${student}</span>`}</div><a id="${student}-studentGrades_Widget" data-studentid="${student}">Grading</a>`).join("");
  const requests = [...(options.extraBrowses ?? []).map((extra, index) => ({ extra, index, queryParameterData: JSON.stringify(
    extra === "unbound" ? {} : extra === "ambiguous" ? { first: { StudentID: "1" }, second: { StudentID: "2" } } :
      { StudentID: extra === "conflict" ? "2" : "1" }) })),
    ...students.map(student => ({ queryParameterData: JSON.stringify({ StudentID: student }) }))];
  const pageHtml = `<a href="/logout">Sign Out</a><script>
    ${JSON.stringify(requests)}.forEach(request => fetch('/lkwash/Grading/StudentSection/GetBrowse', {
      method: 'POST', body: JSON.stringify(request)
    }));</script>`;
  await page.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/lkwash/Grading/StudentSection/GetBrowse") {
      const request = route.request().postDataJSON();
      const { extra } = request;
      const student = JSON.parse(request.queryParameterData).StudentID ?? "1";
      if (!extra && student === "2" && options.missingResponse) return route.abort();
      const empty = extra === "unbound" || extra === "ambiguous" || options.empty && student === "2";
      const headers = [options.headerChanged ? "Changed header" : "Class", "Missing Assignments", "T1", "T2"]
        .map((label, index) => `<th data-column-index="${index}"><div class="headerTextContainerDiv">${label}</div></th>`).join("");
      const id = extra && extra !== "same-scope" ? `StudentGrades-${900 + request.index}` : `StudentGrades-${student}00`;
      const rows = empty ? "" : `<tr class="browseRow" id="${id}_unlockedRow0"><td data-column="0"><a class="studentGradesClassCell"
        data-studentid="${extra === "conflict" || options.wrongStudent && student === "2" ? "1" : student}" data-studentsectionid="10${student}"
        data-coursedescription="Synthetic course" data-coursecode="SYNTH"><div class="fivetoppadding">Synthetic class details</div></a></td>
        <td data-column="1"></td><td data-column="2" data-student-grade-bucket-id="1001"><a class="progressReportBreakdownGradeMarkCode progressReportDetailOpenGrade"><span class="anchorText">${extra === "duplicate" || extra === "same-scope" ? "Synthetic changed mark" : student === "1" ? "A" : "0"}</span></a></td>
        ${options.rowMismatch ? "" : `<td data-column="2" data-student-grade-bucket-id="${options.duplicateBucket ? "1001" : "1002"}"><a class="progressReportBreakdownGradeMarkCode progressReportDetailClosedGrade"><svg></svg></a></td>`}</tr>`;
      const html = `<div class="browse" id="${id}"><table><thead><tr class="unlockedHeaderTableRow">${headers}</tr></thead><tbody>${rows}</tbody></table>
        ${empty && !options.missingEmptyMarker ? '<div class="noRecordsInBrowse">No records</div>' : ""}</div>`;
      if (!extra && student === "2" && options.responseError) {
        if (options.responseError === "http") return route.fulfill({ status: 503, body: "Synthetic private response" });
        if (options.responseError === "json") return route.fulfill({ contentType: "application/json", body: "Synthetic invalid JSON" });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(options.responseError === "payload" ?
          { html: { private: "Synthetic private body" }, script: "" } : { html, script: "Synthetic invalid registration" }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ html,
        script: `skyward.browse.registerBrowse(${JSON.stringify({ browseName: id, browseRequestName: "StudentGrades", skywardID: "shared-template",
          recordCount: options.truncated && student === "2" ? 2 : 1, rowsPerPageCap: options.capped ? 100 : null })});` }) });
    }
    return route.fulfill({ contentType: "text/html", body: route.request().url() === home ? dashboard : pageHtml });
  });
  await page.goto(home);
}

const syntheticStudent = { id: "1", name: "Synthetic Family, Alex", firstName: "Alex", lastName: "Synthetic Family" };

function syntheticSnapshot(): Awaited<ReturnType<typeof gradeSnapshot>> {
  const blank = { span: 1, bucketId: null, text: "", hasLink: false, mark: "", unrecognizedMark: false, periodStatus: "unknown" as const };
  return {
    headers: ["Class", "Missing Assignments", "T1", "T2", "T3"].map(label => ({ label, span: 1, termId: null })),
    rows: [{ studentId: "1", studentSectionId: "101", course: "Synthetic course", courseCode: "SYNTH", classDetails: null,
      cells: [blank, blank, ...["1101", "1102", "1103"].map(bucketId => ({ ...blank, bucketId, text: "A", mark: "A",
        hasLink: true, periodStatus: "open" as const }))] }],
    emptyMarkers: 0,
  };
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

test("grade parsing continues after invalid middle cells and rows with contextual diagnostics", () => {
  for (const invalid of ["cell", "row", "student", "duplicate"] as const) {
    const snapshot = syntheticSnapshot();
    if (invalid === "cell") snapshot.rows[0].cells[3].bucketId = "invalid";
    if (invalid === "duplicate") snapshot.rows[0].cells[3].bucketId = "1101";
    if (invalid === "row" || invalid === "student") {
      snapshot.rows = [snapshot.rows[0], { ...structuredClone(snapshot.rows[0]), studentSectionId: invalid === "row" ? "" : "102",
        studentId: invalid === "student" ? "2" : "1" }, { ...structuredClone(snapshot.rows[0]), studentSectionId: "103",
        cells: snapshot.rows[0].cells.map(cell => ({ ...cell, bucketId: cell.bucketId ? `9${cell.bucketId}` : null })) }];
    }
    const events: DiagnosticEvent[] = [];
    const context = { runId: randomUUID(), student: 7, parserVersion: 1 };
    const student = withDiagnosticSink(event => events.push(event), () =>
      parseGradeSnapshot(syntheticStudent, { recordCount: snapshot.rows.length, rowsPerPageCap: null }, snapshot, now.toISOString(), context));
    assert.equal(student.status, "partial");
    if (invalid === "cell") assert.deepEqual(student.grades.map(grade => grade.id), ["1101", "1103"]);
    else if (invalid === "duplicate") assert.deepEqual(student.grades.map(grade => grade.id), ["1103"]);
    else assert.deepEqual(student.grades.map(grade => grade.studentSectionId), ["101", "101", "101", "103", "103", "103"]);
    assert(events.some(event => event.course === (invalid === "row" || invalid === "student" ? 2 : 1)));
    assert(events.every(event => event.runId === context.runId && event.student === 7 && event.section === "grades"));
    assert.equal(JSON.stringify(events).includes("Synthetic"), false);
  }
});

test("unknown optional grade marks, status, and term IDs remain null or unknown without losing later cells", () => {
  const snapshot = syntheticSnapshot();
  snapshot.rows[0].cells[3].unrecognizedMark = true;
  snapshot.rows[0].cells[3].periodStatus = "unknown";
  snapshot.headers[3].termId = "";
  const events: DiagnosticEvent[] = [];
  const student = withDiagnosticSink(event => events.push(event), () =>
    parseGradeSnapshot(syntheticStudent, { recordCount: 1, rowsPerPageCap: null }, snapshot, now.toISOString(), { student: 1 }));
  assert.equal(student.status, "partial");
  assert.deepEqual(student.grades.map(grade => grade.grade), ["A", null, "A"]);
  assert.equal(student.grades[1].periodStatus, "unknown");
  assert.equal(student.grades[1].termId, null);
  assert(events.some(event => event.code === "FIELD_INVALID" && event.field === "mark" && event.record === 4));
  assert(events.some(event => event.code === "FIELD_INVALID" && event.field === "periods"));
  assert(events.some(event => event.code === "STATE_UNKNOWN" && event.field === "status"));
});

test("grade headers and cell spans are diagnosed while independent periods and rows remain collectible", () => {
  for (const invalid of ["period", "header-span", "cell-span"] as const) {
    const snapshot = syntheticSnapshot();
    if (invalid === "period") snapshot.headers[3].label = "";
    else if (invalid === "header-span") {
      snapshot.headers[3].span = 2;
      snapshot.rows[0].cells[3].span = 2;
    } else {
      snapshot.rows.push({ ...structuredClone(snapshot.rows[0]), studentSectionId: "102",
        cells: snapshot.rows[0].cells.map(cell => ({ ...cell, bucketId: cell.bucketId ? `9${cell.bucketId}` : null })) });
      snapshot.rows[0].cells[3].span = 2;
    }
    const events: DiagnosticEvent[] = [];
    const student = withDiagnosticSink(event => events.push(event), () =>
      parseGradeSnapshot(syntheticStudent, { recordCount: snapshot.rows.length, rowsPerPageCap: null }, snapshot, now.toISOString(), { student: 2 }));
    assert.equal(student.status, "partial");
    if (invalid === "cell-span") assert(student.grades.every(grade => grade.studentSectionId === "102"));
    else assert.deepEqual(student.grades.map(grade => grade.term), ["T1", "T3"]);
    assert(events.some(event => event.code === "LIST_LAYOUT_UNVERIFIED" && event.counts?.headers === 5 ||
      event.code === "LIST_LAYOUT_UNVERIFIED" && event.field === "periods"));
    if (invalid !== "period") assert(events.some(event => event.expected === 1 && event.actual === 2));
  }
});

test("invalid and conflicting roster students do not prevent trustworthy siblings from collecting grades", async () => {
  const page = await browser.newPage();
  try {
    for (const invalid of ["name", "conflict", "id"] as const) {
      await page.unroute("**/*");
      await fixture(page);
      await page.locator(".familyAccessHeaderSelectTile").first().evaluate((tile, invalid) => {
        if (invalid === "name") tile.lastElementChild?.remove();
        else {
          const duplicate = tile.cloneNode(true) as HTMLElement;
          if (invalid === "conflict") duplicate.innerHTML = '<span class="familyAccessStudentNameText">Synthetic Other, Name</span>';
          else duplicate.setAttribute("data-studentid", "invalid");
          tile.after(duplicate);
        }
      }, invalid);
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectGrades(page, now, 300));
      assert.equal(run.status, "partial");
      assert.equal(run.discoveryComplete, false);
      assert.equal(run.students.find(student => student.id === "2")!.status, "complete");
      if (invalid !== "id") assert.deepEqual(run.students.map(student => student.id), ["2"]);
      assert(events.some(event => event.code === "STUDENT_RECORD_INVALID" || event.code === "STUDENT_BINDING_CONFLICT"));
      assert.equal(JSON.stringify(events).includes("Synthetic"), false);
    }
  } finally { await page.close(); }
});

test("unbound and ambiguous browse responses do not suppress valid responses arriving afterward", async () => {
  const page = await browser.newPage();
  try {
    for (const extra of ["unbound", "ambiguous", "conflict"] as const) {
      await page.unroute("**/*");
      await fixture(page, { extraBrowses: [extra] });
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectGrades(page, now, 300));
      assert.equal(run.status, "partial");
      assert.equal(run.discoveryComplete, false);
      assert.deepEqual(run.students.map(student => student.grades.map(grade => grade.grade)), [["A", null], ["0", null]]);
      const code = extra === "unbound" ? "STUDENT_BINDING_MISSING" : extra === "ambiguous" ?
        "STUDENT_BINDING_AMBIGUOUS" : "STUDENT_BINDING_CONFLICT";
      const diagnostic = events.find(event => event.code === code && event.counts?.requestStudents !== undefined)!;
      assert(diagnostic);
      assert.equal(diagnostic.counts!.requestStudents, extra === "unbound" ? 0 : extra === "ambiguous" ? 2 : 1);
      assert.equal(diagnostic.counts!.rowStudents, extra === "conflict" ? 1 : 0);
      if (extra === "conflict") {
        assert.equal(diagnostic.student, 2);
        assert.equal(run.students[0].status, "complete");
        assert.equal(run.students[1].status, "partial");
      }
      assert(events.every(event => event.runId === run.runId && event.portal === "skyward"));
      assert(events.some(event => event.code === "RUN_SUMMARY" && event.status === "partial"));
      assert.equal(JSON.stringify(events).includes("Synthetic"), false);
    }
  } finally { await page.close(); }
});

test("grade snapshot failures are isolated to the expected roster ordinal", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    await page.addInitScript(() => {
      const parse = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (input, type) {
        if (String(input).includes("StudentGrades-100")) throw new Error("Synthetic private snapshot failure");
        return parse.call(this, input, type);
      };
    });
    await fixture(page);
    const run = await withDiagnosticSink(event => events.push(event), () => collectGrades(page, now, 300));
    assert.equal(run.status, "partial");
    assert.equal(run.students[0].status, "failed");
    assert.equal(run.students[1].status, "complete");
    assert.equal(run.students[1].grades.length, 2);
    assert(events.some(event => event.code === "SCOPE_FAILED" && event.student === 1 && event.record !== undefined));
    assert(events.some(event => event.code === "STUDENT_BINDING_MISSING" && event.student === 1));
    assert.equal(JSON.stringify(events).includes("Synthetic"), false);
  } finally { await page.close(); }
});

test("rejected grade response structures and HTTP failures are diagnosed without aborting independent students", async () => {
  const page = await browser.newPage();
  try {
    for (const responseError of ["json", "payload", "registration", "http"] as const) {
      await page.unroute("**/*");
      await fixture(page, { responseError });
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectGrades(page, now, 150));
      assert.equal(run.status, "partial");
      assert.equal(run.students[0].status, "complete");
      assert.equal(run.students[1].status, "failed");
      const expected = responseError === "http" ? "BROWSE_HTTP_ERROR" :
        responseError === "registration" ? "BROWSE_REGISTRATION_INVALID" : "BROWSE_RESPONSE_INVALID";
      assert(events.some(event => event.code === expected && event.student === 2));
      assert.equal(JSON.stringify(events).includes("Synthetic"), false);
    }
  } finally { await page.close(); }
});

test("different valid grade observations never overwrite an ambiguous student baseline", async () => {
  const page = await browser.newPage();
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    await fixture(page);
    const baseline = await collectGradesToStore(page, store, "parent", now, 300);
    for (const extra of ["duplicate", "same-scope"] as const) {
      await page.unroute("**/*");
      await fixture(page, { extraBrowses: [extra] });
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () =>
        collectGradesToStore(page, store, "parent", new Date(now.getTime() + 60_000), 300));
      assert.equal(run.status, "partial");
      assert.equal(run.students[0].status, "partial");
      assert.equal(run.students[1].status, "complete");
      assert.deepEqual(run.students[0].grades.map(grade => grade.id), ["1002"]);
      assert(store.listGrades("parent", { studentId: "1" }).every(record => record.runId === baseline.runId));
      assert(events.some(event => event.code === "DUPLICATE_STUDENT" && event.student === 1));
      assert(events.some(event => event.code === "DUPLICATE_RECORD" && event.flags?.conflicted));
      if (extra === "same-scope") assert(events.some(event => event.code === "DUPLICATE_SCOPE" && event.flags?.conflicted));
    }
  } finally { await page.close(); store.close(); }
});

test("diagnostic write failures escape grade cell and observer recovery", async () => {
  const snapshot = syntheticSnapshot();
  snapshot.rows[0].cells[3].bucketId = "invalid";
  const failure = new DiagnosticLogError("Synthetic log unavailable");
  assert.throws(() => withDiagnosticSink(() => { throw failure; }, () =>
    parseGradeSnapshot(syntheticStudent, { recordCount: 1, rowsPerPageCap: null }, snapshot, now.toISOString())), error => error === failure);
  const page = await browser.newPage();
  try {
    await fixture(page, { responseError: "json" });
    await assert.rejects(() => withDiagnosticSink(event => {
      if (event.code === "BROWSE_RESPONSE_INVALID") throw failure;
    }, () => collectGrades(page, now, 150)), error => error === failure);
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