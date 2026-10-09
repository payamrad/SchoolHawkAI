import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { randomBytes } from "node:crypto";
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
type FixtureRow = { id: string; due: string; title?: string };
type FixtureOptions = { omitStudent?: boolean; incomplete?: boolean; cap?: boolean; missingHeader?: boolean; currentTerm?: boolean; duplicate?: boolean; invalidDate?: boolean; emptyCount?: number; missingEmptyMarker?: boolean };

async function fixture(page: Page, options: FixtureOptions = {}) {
  const registry = new Map<string, { count: number; html: string }>();
  let allYearRequests = 0;
  const groups = ["1", "2"].filter(student => !options.omitStudent || student === "1").map(student => {
    const sections = Object.entries(prefixes).map(([kind, prefix]) => {
      const id = prefix + student;
      const records: FixtureRow[] = student === "2" ? [] : kind === "upcoming" ? [{ id: "100", due: "2027-01-01T00:00:00.0000000" }] :
        kind === "missing" ? [{ id: "101", due: "2026-01-01T00:00:00.0000000" }] :
          [{ id: "102", due: "2026-09-20T00:00:00.0000000" }, { id: "103", due: "2026-09-19T00:00:00.0000000" }, { id: "104", due: "" }];
      if (options.duplicate && records.length) records.push({ ...records[0] });
      if (options.invalidDate && records.length) records[0].due = "not a date";
      const headers = fields.filter(field => !options.missingHeader || field !== "Name").map(field => `<th data-field-name="${field}" data-column-index="${fields.indexOf(field)}"></th>`).join("");
      const rows = records.map((record, index) => {
        const values = [record.due, "0", record.title ?? "Synthetic assignment", "Synthetic course", "A", "Synthetic teacher", "Homework", "", "", "10", "1", ""];
        const cells = values.map((value, column) => `<td data-column="${column}" data-field-value="${value}">${column === 1
          ? `<a class="attachmentButton" data-module="Gradebook" data-object="Assignment" data-action="AttachmentsFamilyAccess" data-field="StudentFamilyAccessAttachmentCount" data-id="${record.id}"></a>` : value}</td>`).join("");
        return `<tr class="browseRow" id="${id}_unlockedRow${index}">${cells}</tr>`;
      }).join("");
      const html = `<div class="browse" id="${id}"><table><thead><tr class="unlockedHeaderTableRow">${headers}</tr></thead><tbody>${rows}</tbody></table>${records.length || options.missingEmptyMarker ? "" : '<div class="noRecordsInBrowse browseRow">No records</div>'}</div>`;
      const count = records.length || (options.emptyCount ?? 1);
      registry.set(id, { count: count + (options.incomplete && student === "1" && kind === "upcoming" ? 1 : 0), html });
      return html;
    }).join("");
    return `<div class="template"><section id="StudentAssignments">${sections}</section><input name="StudentID" value="${student}" type="hidden"></div>`;
  }).join("");
  const pageHtml = `<a href="/logout">Sign Out</a><div id="StudentAssignmentWrapper"><label><input type="radio" name="DateRangeModeAssignment" value="AllYear" ${options.currentTerm ? "" : "checked"}>All Year</label>${groups}</div>
    <script>const allYear = document.querySelector('input[value=AllYear]');
      const load = () => document.querySelectorAll('.browse').forEach(element => fetch('/lkwash/Gradebook/Assignment/GetBrowse', { method: 'POST', body: JSON.stringify({ id: element.id, allYear: allYear.checked }) }));
      allYear.onchange = load; load();</script>`;
  const dashboard = `<a href="/logout">Sign Out</a><a id="-assignmentsList_Widget" data-studentid="" href="${ASSIGNMENTS_URL}">Assignments</a>` + ["1", "2"].map(student =>
    `<div class="familyAccessHeaderSelectTile" data-studentid="${student}"><div class="familyAccessStudentNameTextWrapper"><span class="familyAccessStudentNameText">Synthetic Family,</span><span class="familyAccessStudentNameText">${student === "1" ? "Alex" : "Jordan"}</span></div></div><a id="${student}-assignmentsList_Widget" data-studentid="${student}">Assignments</a>`).join("");
  await page.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/lkwash/Gradebook/Assignment/GetBrowse") {
      const { id, allYear } = route.request().postDataJSON();
      if (allYear) allYearRequests++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ html: registry.get(id)?.html, script: `skyward.browse.registerBrowse(${JSON.stringify({
        browseName: id, browseRequestName: id.replace(/-\d+$/, ""), skywardID: "shared-template-id",
        recordCount: registry.get(id)?.count, rowsPerPageCap: options.cap ? 100 : null,
      })});` }) });
    }
    return route.fulfill({ contentType: "text/html", body: route.request().url() === home ? dashboard : pageHtml });
  });
  await page.goto(home);
  return { allYearRequests: () => allYearRequests };
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

test("incomplete student names fail discovery without accepting a truncated name", async () => {
  const page = await browser.newPage();
  try {
    await fixture(page);
    await page.locator(".familyAccessStudentNameTextWrapper").first().evaluate(wrapper => {
      wrapper.lastElementChild?.remove();
    });
    const run = await collectAssignments(page, 7, now, 300);
    assert.equal(run.status, "failed");
    assert.equal(run.discoveryComplete, false);
    assert.equal(run.warning, "STUDENT_DISCOVERY_UNVERIFIED");
    assert.deepEqual(run.students, []);
    assert.equal(page.url(), home);
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