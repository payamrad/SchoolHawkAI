import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { CANVAS_ORIGIN, collectCanvasAssignments, collectCanvasAssignmentsToStore, normalizeCanvasAssignment, parseCanvasAssignmentOptions, readCanvasPages, validateCanvasPageUrl } from "../src/canvas-assignments";
import { SqliteCanvasStore } from "@schoolhawk/storage/canvas-sqlite";
import { randomBytes } from "node:crypto";
import { DiagnosticLogError, withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";

let browser: Browser;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const dashboard = '<section role="region" aria-label="Global Navigation"><button>Account</button></section><main><h1>Dashboard</h1></main>';
const raw = { id: 40, course_id: 20, name: "U1L6 More Visual Patterns", description: '<p>Complete <strong>problems 1-5</strong>.</p>',
  due_at: "2026-09-22T06:59:59Z", points_possible: 5, submission_types: ["on_paper"] };

async function fixture(page: Page, mode = "normal") {
  const requests: string[] = [];
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    assert.equal(request.method(), "GET");
    assert.equal(url.origin, CANVAS_ORIGIN);
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: mode === "expired" ? '<input type="password">' : dashboard });
    let body: unknown;
    let link: string | undefined;
    if (url.pathname === "/api/v1/users/self/observees") body = mode === "invalid-discovery"
      ? [{ id: 10, name: "Synthetic Student" }, { id: "PRIVATE_STUDENT_ID", name: "PRIVATE_STUDENT_NAME" }, { id: 11, name: "Other Student" }]
      : [{ id: 10, name: "Synthetic Student" }, { id: 11, name: "Other Student" }];
    else if (url.pathname.endsWith("/courses")) body = mode === "invalid-discovery"
      ? [{ id: 20, name: "Synthetic Course" }, { id: 987654321, name: null, course_code: "PRIVATE_COURSE_CODE" }, { id: 22, name: "Later Course" }]
      : [{ id: 20, name: "Synthetic Course", course_code: "ALG" }];
    else if (/^\/api\/v1\/users\/11\/courses\/(?:20|22)\/assignments$/.test(url.pathname)) body = [];
    else if (url.pathname === "/api/v1/users/10/courses/22/assignments") body = [{ ...raw, id: 50, course_id: 22 }];
    else if (url.pathname === "/api/v1/users/10/courses/20/assignments") {
      if (mode === "forbidden") return route.fulfill({ status: 403 });
      if (mode === "rate-limit") return route.fulfill({ status: 429 });
      if (mode === "auth-lost") return route.fulfill({ status: 401 });
      if (mode === "not-json") return route.fulfill({ contentType: "text/html", body: "Loading" });
      if (!url.searchParams.has("page")) {
        body = mode === "invalid-records" ? [raw,
          { ...raw, id: "PRIVATE_ASSIGNMENT_ID", name: "PRIVATE_ASSIGNMENT_NAME", description: "PRIVATE_BODY" },
          { ...raw, id: 42 }, raw, { ...raw, id: 43 }] :
          mode === "normalization-failure" ? [raw, { ...raw, id: 42, course_id: 99 }, { ...raw, id: 43 }] :
          mode === "all-invalid" ? [{ ...raw, id: null }, { ...raw, due_at: "PRIVATE_INVALID_DATE" }] :
          [{ ...raw, course_id: mode === "wrong-course" ? 99 : 20 }];
        const next = mode === "foreign-next" ? "https://unapproved.example/private" : mode === "wrong-student" ?
          `${CANVAS_ORIGIN}/api/v1/users/11/courses/20/assignments?page=2&per_page=100` :
          `${CANVAS_ORIGIN}${url.pathname}?page=2&per_page=100`;
        if (mode !== "all-invalid") link = `<${next}>; rel="next"`;
      } else {
        if (mode === "page-failure") return route.fulfill({ status: 503 });
        body = [{ ...raw, id: mode === "duplicate" ? 40 : 41, name: "Undated", due_at: null }];
        if (mode === "loop") link = `<${url.href}>; rel="next"`;
      }
    } else assert.fail(`Unexpected fixture route: ${url.pathname}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body), headers: link ? { link } : {} });
  });
  await page.goto(CANVAS_ORIGIN);
  return requests;
}

test("Canvas normalizes assignment details safely and preserves source dates without inferring grades", () => {
  const assignment = normalizeCanvasAssignment({ ...raw, description: '<p>Do <b>work</b> &amp; learn.</p><script>privateCode()</script><iframe src="https://external.example"></iframe><a href="https://external.example/?token=secret">Resource</a>' }, "20", "2026-10-08T12:00:00Z");
  assert.match(assignment.description!, /Do work & learn/);
  assert.doesNotMatch(assignment.description!, /privateCode|token=|iframe|<b>/);
  assert.equal(assignment.dueDate, "2026-09-21");
  assert.equal(assignment.dueAt, "2026-09-22T06:59:59.000Z");
  assert.equal(assignment.source.dateScope, "student");
  assert.equal("missing" in assignment, false);
  assert.equal("score" in assignment, false);
  assert.throws(() => normalizeCanvasAssignment(raw, "99", "2026-10-08T12:00:00Z"));
  assert.deepEqual(parseCanvasAssignmentOptions(["--account", "parent"]), { accountId: "parent" });
  assert.throws(() => parseCanvasAssignmentOptions(["7", "--account", "parent"]));
});

test("Canvas preserves absent override metadata as unknown for parent API responses", () => {
  const capturedAt = "2026-10-08T12:00:00Z";
  assert.equal(normalizeCanvasAssignment(raw, "20", capturedAt).hasOverrides, null);
  for (const hasOverrides of [true, false, null]) {
    const assignment = normalizeCanvasAssignment({ ...raw, has_overrides: hasOverrides }, "20", capturedAt);
    assert.equal(assignment.hasOverrides, hasOverrides);
    assert.equal(assignment.source.dateScope, "student");
  }
  assert.throws(() => normalizeCanvasAssignment({ ...raw, has_overrides: "false" }, "20", capturedAt));
});

test("Canvas reads all linked students and paginates per-student assignment lists including verified empty courses", async () => {
  const page = await browser.newPage();
  try {
    const requests = await fixture(page);
    const run = await collectCanvasAssignments(page, new Date(), 1500);
    assert.equal(run.status, "complete");
    assert.equal(run.students.length, 2);
    assert.deepEqual(run.students[0].courses[0].assignments.map(assignment => assignment.id), ["40", "41"]);
    assert(run.students[0].courses[0].assignments.every(assignment => assignment.hasOverrides === null));
    assert.equal(run.students[0].courses[0].pages, 2);
    assert.equal(run.students[1].courses[0].verifiedEmpty, true);
    assert.equal(requests.filter(request => request.includes("/assignments")).length, 3);
  } finally { await page.close(); }
});

test("Canvas keeps valid records after malformed and duplicate records and follows later safe pages", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    const requests = await fixture(page, "invalid-records");
    const run = await withDiagnosticSink(event => events.push(event), () => collectCanvasAssignments(page, new Date(), 1500));
    const course = run.students[0].courses[0];
    assert.equal(run.status, "partial");
    assert.equal(course.status, "partial");
    assert.equal(course.verifiedEmpty, false);
    assert.equal(course.scannedCount, 6);
    assert.equal(course.pages, 2);
    assert.deepEqual(course.assignments.map(assignment => assignment.id), ["40", "42", "43", "41"]);
    assert.equal(requests.filter(request => request.includes("/assignments")).length, 3);
    assert(events.some(event => event.code === "RECORD_INVALID" && event.page === 1 && event.record === 2 && event.field === "id"));
    assert(events.some(event => event.code === "DUPLICATE_RECORD" && event.page === 1 && event.record === 4));
    assert(events.some(event => event.code === "SECTION_SUMMARY" && event.page === 2 && event.counts?.accepted === 1));
    assert.equal(events[0].code, "RUN_STARTED");
    assert.equal(events.at(-1)?.code, "RUN_SUMMARY");
    assert.equal(events.at(-1)?.status, "partial");
    assert(events.every(event => event.runId === run.runId));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Synthetic|U1L6|Visual Patterns|https?:|course_id|assignments\?/);
  } finally { await page.close(); }
});

test("Canvas skips malformed students and courses without losing later valid scopes", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    const requests = await fixture(page, "invalid-discovery");
    const run = await withDiagnosticSink(event => events.push(event), () => collectCanvasAssignments(page, new Date(), 1500));
    assert.equal(run.status, "partial");
    assert.equal(run.discoveryComplete, false);
    assert.deepEqual(run.students.map(student => student.id), ["10", "11"]);
    for (const student of run.students) {
      assert.equal(student.discoveryComplete, false);
      assert.equal(student.status, "partial");
      assert.deepEqual(student.courses.map(course => course.id), ["20", "22"]);
      assert(student.courses.every(course => course.status === "complete"));
    }
    assert.equal(run.students[0].courses[1].assignments[0].id, "50");
    assert(run.students[1].courses.every(course => course.verifiedEmpty));
    assert(!requests.some(request => /PRIVATE_|987654321/.test(request)));
    assert(events.some(event => event.code === "STUDENT_RECORD_INVALID" && event.record === 2));
    assert(events.some(event => event.section === "courses" && event.code === "RECORD_INVALID" && event.student === 3));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Synthetic|987654321|https?:/);
  } finally { await page.close(); }
});

test("Canvas isolates assignment normalization failures and never turns rejected records into verified emptiness", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    await fixture(page, "normalization-failure");
    const run = await withDiagnosticSink(event => events.push(event), () => collectCanvasAssignments(page, new Date(), 1500));
    const course = run.students[0].courses[0];
    assert.equal(run.status, "partial");
    assert.equal(course.status, "partial");
    assert.equal(course.scannedCount, 4);
    assert.deepEqual(course.assignments.map(assignment => assignment.id), ["40", "43", "41"]);
    assert(course.assignments.every(assignment => assignment.courseId === "20"));
    assert(events.some(event => event.code === "RECORD_INVALID" && event.field === "course" && event.page === 1 && event.record === 2));
    await page.unroute("**/*");
    await fixture(page, "all-invalid");
    const rejected = await withDiagnosticSink(() => {}, () => collectCanvasAssignments(page, new Date(), 1500));
    assert.equal(rejected.students[0].courses[0].status, "failed");
    assert.equal(rejected.students[0].courses[0].scannedCount, 2);
    assert.equal(rejected.students[0].courses[0].assignments.length, 0);
    assert.equal(rejected.students[0].courses[0].verifiedEmpty, false);
  } finally { await page.close(); }
});

test("Canvas refuses incomplete, cross-scope, cyclic, denied, and malformed API observations", async () => {
  const page = await browser.newPage();
  try {
    for (const mode of ["forbidden", "foreign-next", "wrong-student", "wrong-course", "loop", "duplicate", "page-failure", "not-json", "auth-lost", "rate-limit"]) {
      await page.unroute("**/*");
      const requests = await fixture(page, mode);
      const run = await collectCanvasAssignments(page, new Date(), 1500);
      assert.notEqual(run.status, "complete", mode);
      assert.notEqual(run.students[0].courses[0].status, "complete", mode);
      if (["page-failure", "foreign-next", "wrong-student", "loop", "duplicate"].includes(mode)) {
        assert(run.students[0].courses[0].assignments.length > 0);
      }
      if (mode === "auth-lost") assert.equal(run.status, "auth-required");
      if (["auth-lost", "rate-limit"].includes(mode)) assert(!requests.some(request => request.endsWith("/users/11/courses")));
      if (mode === "forbidden") assert(requests.some(request => request.endsWith("/users/11/courses")));
    }
  } finally { await page.close(); }
});

test("pagination cannot change request filters or smuggle impersonation credentials", () => {
  const initial = "/api/v1/users/10/courses?enrollment_state=active&per_page=100";
  for (const next of ["/api/v1/users/11/courses?enrollment_state=active", "/api/v1/users/10/courses?enrollment_state=completed",
    "/api/v1/users/10/courses?enrollment_state=active&as_user_id=1", "/api/v1/users/10/courses?enrollment_state=active&page=1&page=2",
    "/api/v1/users/10/courses?enrollment_state=active#private", "https://foreign.example/api/v1/users/10/courses?enrollment_state=active",
    `${CANVAS_ORIGIN.replace("https://", "https://user:password@")}/api/v1/users/10/courses?enrollment_state=active`]) {
    assert.throws(() => validateCanvasPageUrl(next, initial));
  }
});

test("Canvas scanning and pagination budgets count malformed records and stop without extra requests", async () => {
  const initial = "/api/v1/users/10/courses/20/assignments?per_page=100";
  let calls = 0;
  const page = { evaluate: async () => {
    calls++;
    return { status: 200, json: true, text: JSON.stringify([{ id: String(calls) }, {}, { id: "later" }]),
      link: `<${CANVAS_ORIGIN}${initial}&page=${calls + 1}>; rel="next"` };
  } } as unknown as Page;
  const schema = z.object({ id: z.string() });
  await withDiagnosticSink(() => {}, async () => {
    for (const budget of [{ requests: 500, deadline: Date.now() + 10_000 }, { requests: 0, deadline: 0 }]) {
      const run = await readCanvasPages(page, initial, schema, budget, 100);
      assert.equal(run.warning, "COLLECTION_LIMIT");
      assert.equal(run.complete, false);
      assert.equal(calls, 0);
    }
    const limited = await readCanvasPages(page, initial, schema, { requests: 0, deadline: Date.now() + 10_000 }, 100, 2);
    assert.equal(limited.warning, "COLLECTION_LIMIT");
    assert.equal(limited.scannedCount, 2);
    assert.equal(limited.records.length, 1);
    assert.equal(limited.pages, 1);
    assert.equal(calls, 1);

    calls = 0;
    const budget = { requests: 0, deadline: Date.now() + 10_000 };
    const capped = await readCanvasPages(page, initial, schema, budget, 100);
    assert.equal(capped.warning, "COLLECTION_LIMIT");
    assert.equal(capped.complete, false);
    assert.equal(capped.pages, 50);
    assert.equal(capped.scannedCount, 150);
    assert.equal(calls, 50);
    assert.equal(budget.requests, 50);
  });
});

test("Canvas rejects oversized envelopes and unsafe pagination after salvaging the current page", async () => {
  const initial = "/api/v1/users/10/courses/20/assignments?per_page=100";
  const schema = z.object({ id: z.string() });
  const responses = [
    { status: 200, json: true, text: JSON.stringify(Array.from({ length: 1001 }, (_, id) => ({ id: String(id) }))), link: "" },
    { status: 200, json: true, text: '{"PRIVATE_RESPONSE_BODY":true}', link: "" },
    { status: 200, json: true, text: JSON.stringify([{ id: "1" }, { id: null }, { id: "2" }]),
      link: `<${CANVAS_ORIGIN}${initial}&page=2>; rel="next", <${CANVAS_ORIGIN}${initial}&page=3>; rel="next"` },
  ];
  await withDiagnosticSink(() => {}, async () => {
    for (const [index, response] of responses.entries()) {
      let calls = 0;
      const page = { evaluate: async () => { calls++; return response; } } as unknown as Page;
      const run = await readCanvasPages(page, initial, schema, { requests: 0, deadline: Date.now() + 10_000 }, 100);
      assert.equal(run.complete, false);
      assert.equal(calls, 1);
      assert.equal(run.warning, index === 2 ? "PAGINATION_INVALID" : "RESPONSE_INVALID");
      assert.deepEqual(run.records, index === 2 ? [{ id: "1" }, { id: "2" }] : []);
    }
  });
});

test("Canvas diagnostics never contain raw exceptions and logging failures propagate", async () => {
  const events: DiagnosticEvent[] = [];
  const page = { evaluate: async () => { throw new Error("PRIVATE_API_EXCEPTION https://private.example/?token=secret"); } } as unknown as Page;
  const initial = "/api/v1/users/10/courses/20/assignments?per_page=100";
  const schema = z.object({ id: z.string() });
  const run = await withDiagnosticSink(event => events.push(event),
    () => readCanvasPages(page, initial, schema, { requests: 0, deadline: Date.now() + 10_000 }, 100));
  assert.equal(run.warning, "REQUEST_FAILED");
  assert.equal(events[0].errorType, "other");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:|token|secret/);

  const logFailure = new DiagnosticLogError("PRIVATE_LOG_FAILURE");
  const fixturePage = await browser.newPage();
  try {
    await fixture(fixturePage, "invalid-records");
    await assert.rejects(() => withDiagnosticSink(event => {
      if (event.code === "RECORD_INVALID") throw logFailure;
    }, () => collectCanvasAssignments(fixturePage, new Date(), 1500)), error => error === logFailure);
    const brokenPage = { evaluate: async () => { throw logFailure; } } as unknown as Page;
    await assert.rejects(() => readCanvasPages(brokenPage, initial, schema, { requests: 0, deadline: Date.now() + 10_000 }, 100),
      error => error === logFailure);
  } finally { await fixturePage.close(); }
});

test("expired Canvas login does not produce an empty success or attempt API reads", async () => {
  const page = await browser.newPage();
  try {
    const requests = await fixture(page, "expired");
    const run = await collectCanvasAssignments(page, new Date(), 150);
    assert.equal(run.status, "auth-required");
    assert.equal(run.discoveryComplete, false);
    assert.equal(requests.length, 1);
  } finally { await page.close(); }
});

test("Canvas collection writes complete and partial runs without replacing complete assignment observations", async () => {
  const page = await browser.newPage();
  const store = new SqliteCanvasStore(":memory:", randomBytes(32));
  try {
    await fixture(page);
    const first = await collectCanvasAssignmentsToStore(page, store, "canvas-parent", new Date(), 1500);
    assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", first.runId), first);
    assert.equal(store.listCanvasAssignments("canvas-parent").length, 2);
    for (const mode of ["page-failure", "invalid-records", "normalization-failure"]) {
      await page.unroute("**/*");
      await fixture(page, mode);
      const partial = await collectCanvasAssignmentsToStore(page, store, "canvas-parent", new Date(), 1500);
      assert.equal(partial.status, "partial");
      assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", partial.runId), partial);
      assert(store.listCanvasAssignments("canvas-parent").every(record => record.runId === first.runId));
    }
    await page.goto(CANVAS_ORIGIN);
    await assert.rejects(collectCanvasAssignmentsToStore(page, { importCanvasAssignmentRun() { throw new Error("Synthetic write failure"); } }, "parent", new Date(), 1500), /Synthetic write failure/);
  } finally { store.close(); await page.close(); }
});