import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import { DiagnosticLogError, withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { ASSIGNMENTS_URL, assignmentDate, assignmentSummary, collectAssignments, collectAssignmentsToStore,
  parseAssignmentOptions, parseBrowseRegistration, parseStudentName } from "../src/skyward-assignments";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const now = new Date("2026-09-26T12:00:00.000Z");
const home = "https://www.q.wa-k12.net/lkwash/Home";
const fields = ["DueDate", "StudentFamilyAccessAttachmentCount", "Name", "Section.SpecifiedStudentSection.CourseOrTransferDescription",
  "Section.Code", "Section.StaffCurrentStoredPrimary.FamilyStudentAccessStaffNameToUse", "Category.Description",
  "StudentAssignment.CecsSafeGradeMarkCodeToUse", "StudentAssignment.CecsSafeStudentOnlineAssignmentDisplayPointsEarned",
  "CecsSafeMaxScoreDisplay", "CecsSafeWeightDisplay", "StudentAssignment.CecsSafeAttemptCountDisplay"];
const prefixes = { upcoming: "StudentUpcomingAssignmentsFamilyAccess-", missing: "StudentMissingAssignmentsFamilyAccess-", past: "StudentPastAssignmentsFamilyAccess-" };
type FixtureRow = { id: string; due: string; title?: string; attachments?: string };
type FixtureOptions = { omitStudent?: boolean; incomplete?: boolean; cap?: boolean; missingHeader?: boolean; currentTerm?: boolean;
  duplicate?: boolean; invalidDate?: boolean; emptyCount?: number; missingEmptyMarker?: boolean; upcoming?: FixtureRow[];
  duplicateScope?: boolean; responseError?: "json" | "payload" | "registration" | "http"; conflictingResponse?: boolean };

async function fixture(page: Page, options: FixtureOptions = {}) {
  const registry = new Map<string, { count: number; html: string }>();
  let allYearRequests = 0;
  const groups = ["1", "2"].filter(student => !options.omitStudent || student === "1").map(student => {
    const sections = Object.entries(prefixes).map(([kind, prefix]) => {
      const id = prefix + student;
      const records: FixtureRow[] = student === "2" ? [] : kind === "upcoming" ? options.upcoming ?? [{ id: "100", due: "2027-01-01T00:00:00.0000000" }] :
        kind === "missing" ? [{ id: "101", due: "2026-01-01T00:00:00.0000000" }] :
          [{ id: "102", due: "2026-09-20T00:00:00.0000000" }, { id: "103", due: "2026-09-19T00:00:00.0000000" }, { id: "104", due: "" }];
      if (options.duplicate && records.length) records.push({ ...records[0] });
      if (options.invalidDate && records.length) records[0].due = "not a date";
      const headers = fields.filter(field => !options.missingHeader || field !== "Name").map(field => `<th data-field-name="${field}" data-column-index="${fields.indexOf(field)}"></th>`).join("");
      const rows = records.map((record, index) => {
        const values = [record.due, record.attachments ?? "0", record.title ?? "Synthetic assignment", "Synthetic course", "A", "Synthetic teacher", "Homework", "", "", "10", "1", ""];
        const cells = values.map((value, column) => `<td data-column="${column}" data-field-value="${value}">${column === 1
          ? `<a class="attachmentButton" data-module="Gradebook" data-object="Assignment" data-action="AttachmentsFamilyAccess" data-field="StudentFamilyAccessAttachmentCount" data-id="${record.id}"></a>` : value}</td>`).join("");
        return `<tr class="browseRow" id="${id}_unlockedRow${index}">${cells}</tr>`;
      }).join("");
      const html = `<div class="browse" id="${id}"><table><thead><tr class="unlockedHeaderTableRow">${headers}</tr></thead><tbody>${rows}</tbody></table>${records.length || options.missingEmptyMarker ? "" : '<div class="noRecordsInBrowse browseRow">No records</div>'}</div>`;
      const count = records.length || (options.emptyCount ?? 1);
      registry.set(id, { count: count + (options.incomplete && student === "1" && kind === "upcoming" ? 1 : 0), html });
      return html;
    }).join("");
    const scope = `<div class="template"><section id="StudentAssignments">${sections}</section><input name="StudentID" value="${student}" type="hidden"></div>`;
    return scope + (options.duplicateScope && student === "1" ? scope : "");
  }).join("");
  const pageHtml = `<a href="/logout">Sign Out</a><div id="StudentAssignmentWrapper"><label><input type="radio" name="DateRangeModeAssignment" value="AllYear" ${options.currentTerm ? "" : "checked"}>All Year</label>${groups}</div>
    <script>const allYear = document.querySelector('input[value=AllYear]');
      const load = () => document.querySelectorAll('.browse').forEach(element => {
        fetch('/lkwash/Gradebook/Assignment/GetBrowse', { method: 'POST', body: JSON.stringify({ id: element.id, allYear: allYear.checked }) });
        if (${!!options.conflictingResponse} && element.id === 'StudentUpcomingAssignmentsFamilyAccess-1')
          fetch('/lkwash/Gradebook/Assignment/GetBrowse', { method: 'POST', body: JSON.stringify({ id: element.id, allYear: allYear.checked, changed: true }) });
      });
      allYear.onchange = load; load();</script>`;
  const dashboard = `<a href="/logout">Sign Out</a><a id="-assignmentsList_Widget" data-studentid="" href="${ASSIGNMENTS_URL}">Assignments</a>` + ["1", "2"].map(student =>
    `<div class="familyAccessHeaderSelectTile" data-studentid="${student}"><div class="familyAccessStudentNameTextWrapper"><span class="familyAccessStudentNameText">Synthetic Family,</span><span class="familyAccessStudentNameText">${student === "1" ? "Alex" : "Jordan"}</span></div></div><a id="${student}-assignmentsList_Widget" data-studentid="${student}">Assignments</a>`).join("");
  await page.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/lkwash/Gradebook/Assignment/GetBrowse") {
      const { id, allYear, changed } = route.request().postDataJSON();
      if (allYear) allYearRequests++;
      if (id === prefixes.upcoming + "1" && options.responseError) {
        if (options.responseError === "http") return route.fulfill({ status: 503, body: "Synthetic private response" });
        if (options.responseError === "json") return route.fulfill({ contentType: "application/json", body: "Synthetic invalid JSON" });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(options.responseError === "payload" ?
          { html: { private: "Synthetic private body" }, script: "" } : { html: registry.get(id)?.html, script: "Synthetic invalid registration" }) });
      }
      const html = registry.get(id)?.html;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ html: changed ? html?.replace("Synthetic assignment", "Synthetic changed assignment") : html, script: `skyward.browse.registerBrowse(${JSON.stringify({
        browseName: id, browseRequestName: id.replace(/-\d+$/, ""), skywardID: "shared-template-id",
        recordCount: registry.get(id)?.count, rowsPerPageCap: options.cap ? 100 : null,
      })});` }) });
    }
    return route.fulfill({ contentType: "text/html", body: route.request().url() === home ? dashboard : pageHtml });
  });
  await page.goto(home);
  return { allYearRequests: () => allYearRequests, registry };
}

test("assignment arguments and raw local dates are validated without guessing", () => {
  assert.deepEqual(parseAssignmentOptions(["7", "--account", "parent"]), { days: 7, accountId: "parent" });
  for (const args of [[], ["7"], ["0", "--account", "parent"], ["367", "--account", "parent"], ["7", "--account", "parent", "--all"], ["7", "--account", "parent~"]]) {
    assert.throws(() => parseAssignmentOptions(args));
  }
  assert.equal(assignmentDate("2026-09-20T00:00:00.0000000"), "2026-09-20");
  assert.equal(assignmentDate(""), null);
  assert.throws(() => assignmentDate("2026-02-31T00:00:00"));
  assert.throws(() => assignmentDate("unknown"));
  assert.throws(() => parseBrowseRegistration('skyward.browse.registerBrowse(alert("unsafe"));'));
});

test("student names preserve multi-word and hyphenated parts without guessing ambiguous formats", () => {
  assert.deepEqual(parseStudentName([" De la Cruz, ", "  Ana   Maria \n"]), {
    name: "De la Cruz, Ana Maria", firstName: "Ana Maria", lastName: "De la Cruz",
  });
  assert.deepEqual(parseStudentName(["O'Neil-Smith,Jean-Luc"]), {
    name: "O'Neil-Smith, Jean-Luc", firstName: "Jean-Luc", lastName: "O'Neil-Smith",
  });
  for (const parts of [[], ["Family,"], [", Alex"], ["Alex Family"], ["Family,", "Alex, Jr."]]) {
    assert.throws(() => parseStudentName(parts), /^Error: Unverified student name format\.$/);
  }
});

test("collects all students and all upcoming/missing work, applies the inclusive past window, and saves to SQLite", async () => {
  const page = await browser.newPage();
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    await fixture(page);
    const run = await collectAssignmentsToStore(page, store, "parent", 7, now, 500);
    assert.equal(run.status, "complete");
    assert.equal(run.students.length, 2);
    assert.deepEqual(run.students.map(({ id, name, firstName, lastName }) => ({ id, name, firstName, lastName })), [
      { id: "1", name: "Synthetic Family, Alex", firstName: "Alex", lastName: "Synthetic Family" },
      { id: "2", name: "Synthetic Family, Jordan", firstName: "Jordan", lastName: "Synthetic Family" },
    ]);
    assert.deepEqual(run.students[0].sections.map(section => section.assignments.map(assignment => assignment.id)), [["100"], ["101"], ["102", "104"]]);
    assert.equal(run.students[0].sections[1].assignments[0].missing, true);
    assert.equal(run.students[0].sections[0].assignments[0].score, null);
    assert(run.students[1].sections.every(section => section.verifiedEmpty && section.status === "complete"));
    assert.deepEqual(store.getAssignmentRun("parent", run.runId), run);
    assert.equal(store.listAssignments("parent").length, 4);
    assert.deepEqual(store.listAssignments("parent")[0].student, {
      id: "1", name: "Synthetic Family, Alex", firstName: "Alex", lastName: "Synthetic Family",
    });
    assert.equal(store.importAssignmentRun("parent", run), "already-imported");
    assert.equal(JSON.stringify(assignmentSummary(run)).includes("Synthetic"), false);
  } finally { await page.close(); store.close(); }
});

test("incomplete student names leave verified siblings collectible without accepting truncated names", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    await fixture(page);
    await page.locator(".familyAccessStudentNameTextWrapper").first().evaluate(wrapper => {
      wrapper.lastElementChild?.remove();
    });
    const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 300));
    assert.equal(run.status, "partial");
    assert.equal(run.discoveryComplete, false);
    assert.equal(run.warning, "STUDENT_DISCOVERY_UNVERIFIED");
    assert.deepEqual(run.students.map(student => student.id), ["2"]);
    assert(run.students[0].sections.every(section => section.status === "complete" && section.verifiedEmpty));
    assert.equal(page.url(), ASSIGNMENTS_URL);
    assert(events.some(event => event.code === "STUDENT_RECORD_INVALID" && event.student === 1 && event.field === "name"));
    assert(events.some(event => event.code === "SECTION_SUMMARY" && event.student === 2 && event.status === "complete"));
    assert(events.every(event => event.runId === run.runId));
    assert.equal(JSON.stringify(events).includes("Synthetic"), false);
  } finally { await page.close(); }
});

test("conflicting roster identities and duplicate scopes do not suppress independent students", async () => {
  const page = await browser.newPage();
  try {
    for (const conflict of ["identity", "scope", "invalid-id"] as const) {
      await page.unroute("**/*");
      await fixture(page, { duplicateScope: conflict === "scope" });
      if (conflict !== "scope") {
        await page.locator(".familyAccessHeaderSelectTile").first().evaluate((tile, conflict) => {
          const duplicate = tile.cloneNode(true) as HTMLElement;
          if (conflict === "identity") duplicate.querySelector(".familyAccessStudentNameTextWrapper")!.textContent = "";
          if (conflict === "identity") duplicate.innerHTML = '<span class="familyAccessStudentNameText">Conflicting Family, Other</span>';
          else duplicate.setAttribute("data-studentid", "not-an-identity");
          tile.after(duplicate);
        }, conflict);
      }
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 300));
      assert.equal(run.status, "partial");
      assert.equal(run.discoveryComplete, false);
      assert(run.students.find(student => student.id === "2")!.sections.every(section => section.status === "complete"));
      if (conflict === "identity") assert.deepEqual(run.students.map(student => student.id), ["2"]);
      if (conflict === "scope") assert(run.students[0].sections.every(section => section.status === "failed"));
      assert(events.some(event => ["STUDENT_BINDING_CONFLICT", "DUPLICATE_SCOPE", "STUDENT_RECORD_INVALID"].includes(event.code)));
      assert.equal(JSON.stringify(events).includes("Conflicting Family"), false);
    }
  } finally { await page.close(); }
});

test("valid-invalid-valid assignment rows continue scanning and optional bad fields become unknown", async () => {
  const page = await browser.newPage();
  try {
    for (const invalid of [{ id: "invalid", due: "2027-01-01" }, { id: "111", due: "2027-01-01", title: "" },
      { id: "111", due: "not a date", attachments: "unknown" }]) {
      await page.unroute("**/*");
      await fixture(page, { upcoming: [{ id: "110", due: "2027-01-01" }, invalid, { id: "112", due: "2027-01-03" }] });
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 300));
      const section = run.students[0].sections[0];
      assert.equal(run.status, "partial");
      assert.equal(section.status, "partial");
      assert.equal(section.scannedCount, 3);
      assert.deepEqual(section.assignments.map(assignment => assignment.id), invalid.due === "not a date" ? ["110", "111", "112"] : ["110", "112"]);
      if (invalid.due === "not a date") {
        assert.equal(section.assignments[1].dueDate, null);
        assert.equal(section.assignments[1].attachmentCount, null);
      }
      assert(run.students[0].sections.slice(1).every(section => section.status === "complete"));
      assert(run.students[1].sections.every(section => section.status === "complete"));
      assert(events.some(event => event.student === 1 && event.record === 2 && event.section === "upcoming"));
      assert(events.some(event => event.code === "RUN_STARTED"));
      assert(events.some(event => event.code === "RUN_SUMMARY" && event.status === "partial"));
      assert.equal(JSON.stringify(events).includes("not a date"), false);
    }
  } finally { await page.close(); }
});

test("unverified optional headers and cells are diagnosed without discarding safe assignment identities", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    const { registry } = await fixture(page);
    const browse = registry.get(prefixes.upcoming + "1")!;
    browse.html = browse.html.replace('data-field-name="Category.Description"', 'colspan="2" data-field-name="Category.Description"')
      .replace('data-column="9"', 'colspan="2" data-column="9"');
    const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 300));
    const section = run.students[0].sections[0];
    assert.equal(section.status, "partial");
    assert.equal(section.assignments.length, 1);
    assert.equal(section.assignments[0].category, null);
    assert.equal(section.assignments[0].maxScore, null);
    assert(events.some(event => event.code === "LIST_LAYOUT_UNVERIFIED" && event.field === "headers" &&
      event.expected === 1 && event.actual === 2 && event.counts?.headers === 12));
    assert(events.some(event => event.code === "FIELD_INVALID" && event.counts?.cells === 12 && event.actual === 2));
    assert(events.every(event => event.runId === run.runId && event.portal === "skyward"));
  } finally { await page.close(); }
});

test("section snapshot failures and rejected responses retain other sections and emit safe diagnostics", async () => {
  const page = await browser.newPage();
  try {
    for (const responseError of ["json", "payload", "registration", "http"] as const) {
      await page.unroute("**/*");
      await fixture(page, { responseError });
      const events: DiagnosticEvent[] = [];
      const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 150));
      assert.equal(run.status, "partial");
      assert.equal(run.students[0].sections[0].status, "failed");
      assert(run.students[0].sections.slice(1).every(section => section.status === "complete"));
      const expected = responseError === "http" ? "BROWSE_HTTP_ERROR" :
        responseError === "registration" ? "BROWSE_REGISTRATION_INVALID" : "BROWSE_RESPONSE_INVALID";
      assert(events.some(event => event.code === expected && event.record !== undefined));
      assert.equal(JSON.stringify(events).includes("Synthetic"), false);
    }
    await page.unroute("**/*");
    await page.addInitScript(() => {
      const parse = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (input, type) {
        if (String(input).includes("StudentUpcomingAssignmentsFamilyAccess-1")) throw new Error("Synthetic private snapshot failure");
        return parse.call(this, input, type);
      };
    });
    await fixture(page);
    const events: DiagnosticEvent[] = [];
    const run = await withDiagnosticSink(event => events.push(event), () => collectAssignments(page, 7, now, 300));
    assert.equal(run.students[0].sections[0].status, "failed");
    assert(run.students[0].sections.slice(1).every(section => section.status === "complete"));
    assert(events.some(event => event.code === "SCOPE_FAILED" && event.student === 1 && event.section === "upcoming"));
    assert.equal(JSON.stringify(events).includes("Synthetic"), false);
  } finally { await page.close(); }
});

test("conflicting assignment observations remain partial and cannot advance a complete baseline", async () => {
  const page = await browser.newPage();
  const store = new SqliteMessageStore(":memory:", randomBytes(32));
  try {
    await fixture(page);
    const baseline = await collectAssignmentsToStore(page, store, "parent", 7, now, 300);
    await page.unroute("**/*");
    await fixture(page, { conflictingResponse: true });
    const events: DiagnosticEvent[] = [];
    const run = await withDiagnosticSink(event => events.push(event), () =>
      collectAssignmentsToStore(page, store, "parent", 7, new Date(now.getTime() + 60_000), 300));
    assert.equal(run.status, "partial");
    assert.equal(run.students[0].sections[0].status, "partial");
    assert.equal(store.listAssignments("parent").find(record => record.assignment.id === "100")!.runId, baseline.runId);
    assert(events.some(event => event.code === "DUPLICATE_SCOPE" && event.flags?.conflicted));
  } finally { await page.close(); store.close(); }
});

test("diagnostic write failures propagate through assignment record and observer recovery", async () => {
  const page = await browser.newPage();
  try {
    for (const options of [{ invalidDate: true }, { responseError: "json" as const }]) {
      await page.unroute("**/*");
      await fixture(page, options);
      const failure = new DiagnosticLogError("Synthetic log unavailable");
      await assert.rejects(() => withDiagnosticSink(event => {
        if (event.code === "FIELD_INVALID" || event.code === "BROWSE_RESPONSE_INVALID") throw failure;
      }, () => collectAssignments(page, 7, now, 150)), error => error === failure);
    }
  } finally { await page.close(); }
});

test("reports missing students and truncated/changed lists without claiming complete coverage", async () => {
  const page = await browser.newPage();
  try {
    for (const options of [{ omitStudent: true }, { incomplete: true }, { cap: true }, { missingHeader: true }, { duplicate: true }, { invalidDate: true }, { emptyCount: 2 }, { missingEmptyMarker: true }]) {
      await page.unroute("**/*");
      await fixture(page, options);
      const run = await collectAssignments(page, 7, now, 300);
      assert.notEqual(run.status, "complete");
      assert.equal(run.students.length, 2);
      assert(run.students.some(student => student.sections.some(section => section.status !== "complete")));
    }
  } finally { await page.close(); }
});

test("switches Current Term to All Year before accepting assignment results", async () => {
  const page = await browser.newPage();
  try {
    const tracking = await fixture(page, { currentTerm: true });
    const run = await collectAssignments(page, 7, now, 500);
    assert.equal(run.status, "complete");
    assert.equal(tracking.allYearRequests(), 6);
    assert.equal(await page.getByLabel("All Year", { exact: true }).isChecked(), true);
  } finally { await page.close(); }
});

test("expired sessions are recorded as auth-required, not empty assignment collections", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<input type="password">' }));
    await page.goto(home);
    const run = await collectAssignments(page, 7, now, 100);
    assert.equal(run.status, "auth-required");
    assert.equal(run.discoveryComplete, false);
    assert.equal(run.warning, "AUTH_REQUIRED");
  } finally { await page.close(); }
});