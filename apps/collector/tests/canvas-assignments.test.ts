import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CANVAS_ORIGIN, collectCanvasAssignments, collectCanvasAssignmentsToStore, normalizeCanvasAssignment, parseCanvasAssignmentOptions, validateCanvasPageUrl } from "../src/canvas-assignments";
import { SqliteCanvasStore } from "@schoolhawk/storage/canvas-sqlite";
import { randomBytes } from "node:crypto";

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
    if (url.pathname === "/api/v1/users/self/observees") body = [{ id: 10, name: "Synthetic Student" }, { id: 11, name: "Other Student" }];
    else if (url.pathname.endsWith("/courses")) body = [{ id: 20, name: "Synthetic Course", course_code: "ALG" }];
    else if (url.pathname === "/api/v1/users/11/courses/20/assignments") body = [];
    else if (url.pathname === "/api/v1/users/10/courses/20/assignments") {
      if (mode === "forbidden") return route.fulfill({ status: 403 });
      if (mode === "rate-limit") return route.fulfill({ status: 429 });
      if (mode === "auth-lost") return route.fulfill({ status: 401 });
      if (mode === "not-json") return route.fulfill({ contentType: "text/html", body: "Loading" });
      if (!url.searchParams.has("page")) {
        body = [{ ...raw, course_id: mode === "wrong-course" ? 99 : 20 }];
        const next = mode === "foreign-next" ? "https://unapproved.example/private" : mode === "wrong-student" ?
          `${CANVAS_ORIGIN}/api/v1/users/11/courses/20/assignments?page=2&per_page=100` :
          `${CANVAS_ORIGIN}${url.pathname}?page=2&per_page=100`;
        link = `<${next}>; rel="next"`;
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

test("Canvas refuses incomplete, cross-scope, cyclic, denied, and malformed API observations", async () => {
  const page = await browser.newPage();
  try {
    for (const mode of ["forbidden", "foreign-next", "wrong-student", "wrong-course", "loop", "duplicate", "page-failure", "not-json", "auth-lost", "rate-limit"]) {
      await page.unroute("**/*");
      await fixture(page, mode);
      const run = await collectCanvasAssignments(page, new Date(), 1500);
      assert.notEqual(run.status, "complete", mode);
      assert.notEqual(run.students[0].courses[0].status, "complete", mode);
      if (["page-failure", "foreign-next", "wrong-student", "loop", "duplicate"].includes(mode)) {
        assert(run.students[0].courses[0].assignments.length > 0);
      }
      if (mode === "auth-lost") assert.equal(run.status, "auth-required");
    }
  } finally { await page.close(); }
});

test("pagination cannot change request filters or smuggle impersonation credentials", () => {
  const initial = "/api/v1/users/10/courses?enrollment_state=active&per_page=100";
  for (const next of ["/api/v1/users/11/courses?enrollment_state=active", "/api/v1/users/10/courses?enrollment_state=completed",
    "/api/v1/users/10/courses?enrollment_state=active&as_user_id=1", "/api/v1/users/10/courses?enrollment_state=active&page=1&page=2"]) {
    assert.throws(() => validateCanvasPageUrl(next, initial));
  }
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
    await page.unroute("**/*");
    await fixture(page, "page-failure");
    const partial = await collectCanvasAssignmentsToStore(page, store, "canvas-parent", new Date(), 1500);
    assert.equal(partial.status, "partial");
    assert.deepEqual(store.getCanvasAssignmentRun("canvas-parent", partial.runId), partial);
    assert(store.listCanvasAssignments("canvas-parent").every(record => record.runId === first.runId));
    await page.goto(CANVAS_ORIGIN);
    await assert.rejects(collectCanvasAssignmentsToStore(page, { importCanvasAssignmentRun() { throw new Error("Synthetic write failure"); } }, "parent", new Date(), 1500), /Synthetic write failure/);
  } finally { store.close(); await page.close(); }
});