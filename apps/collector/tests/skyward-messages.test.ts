import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { DiagnosticLogError, withDiagnosticSink, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import { collectMessages, collectMessagesToStore, dateWindow, decryptRun, encryptRun, messageDate, parseDays, parseMessageOptions } from "../src/skyward-messages";
import portalConfig from "../../../config/portals.json";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const now = new Date("2026-09-13T12:00:00Z");

test("validates the CLI day count with actionable, non-sensitive errors", () => {
  assert.equal(parseDays(["7"]), 7);
  assert.equal(parseDays(["1"]), 1);
  assert.equal(parseDays(["366"]), 366);
  for (const args of [[], ["N"], ["7", "extra"], ["1.5"], ["-1"]]) {
    assert.throws(() => parseDays(args), /Provide exactly one day count/);
  }
  for (const value of ["0", "367", "999999999999999999999"]) {
    assert.throws(() => parseDays([value]), /between 1 and 366/);
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/skyward-messages.ts")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm run skyward:messages -- 7/);
  assert.match(result.stderr, /No login was attempted/);
  assert.doesNotMatch(result.stderr, /renew the session/);
});

test("uses inclusive Pacific calendar days including across DST and UTC midnight", () => {
  assert.equal(dateWindow(7, now).startDate, "2026-09-07");
  assert.equal(dateWindow(7, new Date("2026-09-13T02:00:00Z")).endDate, "2026-09-12");
  assert.equal(dateWindow(7, new Date("2026-03-09T12:00:00Z")).startDate, "2026-03-03");
  for (const invalid of [0, -1, 1.5, NaN, 367]) assert.throws(() => dateWindow(invalid));
  assert.equal(messageDate("07/09/2026", "2026-09-13"), "2026-09-07");
  assert.equal(messageDate("01:10", "2026-09-13"), "2026-09-13");
  assert.equal(messageDate("Yesterday", "2026-09-13"), "2026-09-12");
  assert.throws(() => messageDate("31/02/2026", "2026-09-13"));
  assert.throws(() => messageDate("unknown", "2026-09-13"));
  assert.throws(() => messageDate("23:10 PM", "2026-09-13"));
  assert.throws(() => messageDate("00:10 AM", "2026-09-13"));
  assert.equal(messageDate("12:10 PM", "2026-09-13"), "2026-09-13");
});

test("builds ISO dates from named parts rather than locale-formatted strings", () => {
  const prototype = Intl.DateTimeFormat.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "format")!;
  Object.defineProperty(prototype, "format", {
    configurable: true,
    get: () => () => "09/13/2026",
  });
  try {
    assert.deepEqual(dateWindow(7, now), {
      days: 7, startDate: "2026-09-07", endDate: "2026-09-13",
      timeZone: "America/Los_Angeles",
    });
  } finally {
    Object.defineProperty(prototype, "format", descriptor);
  }
});

test("defaults to unread and accepts only the optional all flag", () => {
  assert.deepEqual(parseMessageOptions(["7"]), { days: 7, includeRead: false, accountId: undefined });
  assert.deepEqual(parseMessageOptions(["7", "--all"]), { days: 7, includeRead: true, accountId: undefined });
  assert.deepEqual(parseMessageOptions(["--all", "7"]), { days: 7, includeRead: true, accountId: undefined });
  for (const args of [["--all"], ["7", "--all", "--all"], ["7", "--unknown"]]) {
    assert.throws(() => parseMessageOptions(args));
  }
});

test("validates the storage account alias before session access", () => {
  assert.deepEqual(parseMessageOptions(["7", "--account", "lkwash-parent", "--all"]), {
    days: 7, includeRead: true, accountId: "lkwash-parent",
  });
  for (const args of [["7", "--account"], ["7", "--account", "parent~"],
    ["7", "--account", "parent", "--account", "other"]]) assert.throws(() => parseMessageOptions(args), /Use --account/);
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/skyward-messages.ts"), "7"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--account lkwash-parent/);
  assert.match(result.stderr, /No login was attempted/);
});

function fixture(dates: string[], readIds: number[] = []) {
  return `<div class="myMessagesVueBrowse"><div class="vueBrowse__unlockedBody">${dates.map((date, index) =>
    `<div class="messageCell ${readIds.includes(index) ? "messageCell--state-read" : "messageCell--state-unread"}" data-messageid="${index}"><span class="messageCell__from">Synthetic sender</span><div class="messageCell__subject">Message ${index}</div><div class="messageCell__date">${date}</div></div>`).join("")}</div></div>
    <div class="detailsPanel__myMessages"></div><script>
      document.querySelector('.myMessagesVueBrowse').addEventListener('click', event => {
        const subject = event.target.closest('.messageCell__subject');
        if (!subject) return;
        const id = subject.parentElement.dataset.messageid;
        subject.parentElement.dataset.opened = 'yes';
        subject.parentElement.classList.remove('messageCell--state-unread');
        subject.parentElement.classList.add('messageCell--state-read');
        document.querySelector('.detailsPanel__myMessages').innerHTML = '<div class="currentRecordContent" data-primaryid="' + id + '"><div class="myMessageContent">Synthetic body ' + id + '</div></div>';
      });
    </script>`;
}

test("writes directly to SQLite and deduplicates current messages across collection runs", async () => {
  const directory = `.collector-message-store-${randomUUID()}`;
  mkdirSync(directory);
  const store = new SqliteMessageStore(path.join(directory, "database/schoolhawk.sqlite"), randomBytes(32));
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "06/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const first = await collectMessagesToStore(page, store, "parent", 7, now, 500, { includeRead: true });
    const second = await collectMessagesToStore(page, store, "parent", 7, now, 500, { includeRead: true });
    assert.equal(first.status, "complete");
    assert.equal(second.status, "complete");
    assert.notEqual(first.runId, second.runId);
    assert.equal(store.listRuns("parent").length, 2);
    assert.equal(store.listMessages("parent").length, 1);
    assert.equal(store.listMessages("parent")[0].message.unreadBeforeOpen, false);
    assert.equal(store.importRun("parent", second), "already-imported");
    assert.deepEqual(store.getRun("parent", first.runId), first);
    assert.deepEqual(store.getRun("parent", second.runId), second);
    assert.equal(store.listMessages("other").length, 0);
    assert.deepEqual(readdirSync(directory), ["database"]);
    await page.unroute("**/*");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const partial = await collectMessagesToStore(page, store, "parent", 7, now, 200);
    assert.equal(partial.status, "partial");
    assert.deepEqual(store.getRun("parent", partial.runId), partial);
    assert.equal(store.listMessages("parent")[0].runId, second.runId);
    await page.unroute("**/*");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html",
      body: fixture(["12/09/2026", "11/09/2026", "10/09/2026", "06/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    await page.locator('[data-messageid="1"]').evaluate(element => { element.setAttribute("class", "messageCell"); });
    const invalid = await collectMessagesToStore(page, store, "parent", 7, now, 200);
    assert.equal(invalid.status, "partial");
    assert.deepEqual(invalid.messages.map(message => message.id), ["0", "2"]);
    assert.deepEqual(store.getRun("parent", invalid.runId), invalid);
    assert.equal(store.listMessages("parent").find(record => record.message.id === "0")?.runId, second.runId);
    await page.setContent("<h1>Loading</h1>");
    const failed = await collectMessagesToStore(page, store, "parent", 7, now, 200);
    assert.equal(failed.status, "failed");
    assert.deepEqual(store.getRun("parent", failed.runId), failed);
    assert.equal(store.listMessages("parent").length, 1);
    await assert.rejects(() => collectMessagesToStore(page, {
      importRun() { throw new Error("Synthetic database failure"); },
    }, "parent", 7, now, 200), /Synthetic database failure/);
  } finally {
    await page.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unread mode never clicks read rows; all mode includes both statuses within the date range", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "11/09/2026", "06/09/2026"], [0]) }));
    for (const includeRead of [false, true]) {
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      const result = includeRead
        ? await collectMessages(page, 7, now, 500, { includeRead: true })
        : await collectMessages(page, 7, now, 500);
      assert.equal(result.status, "complete");
      assert.equal(result.selection, includeRead ? "all" : "unread");
      assert.equal(result.scannedCount, 3);
      assert.deepEqual(result.messages.map(message => message.id), includeRead ? ["0", "1"] : ["1"]);
      assert.deepEqual(result.messages.map(message => message.unreadBeforeOpen), includeRead ? [false, true] : [true]);
      assert.equal(await page.locator('[data-messageid="0"]').getAttribute("data-opened"), includeRead ? "yes" : null);
      assert.equal(await page.locator('[data-messageid="2"]').getAttribute("data-opened"), null);
    }
  } finally { await page.close(); }
});

test("returns a scoped empty success when all in-range messages are read and the date boundary is verified", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "06/09/2026"], [0]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 500);
    assert.equal(result.status, "complete");
    assert.equal(result.selection, "unread");
    assert.equal(result.messages.length, 0);
    assert.equal(await page.locator('[data-opened="yes"]').count(), 0);
  } finally { await page.close(); }
});

test("unrelated message presentation states do not override explicit read/unread markers", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html",
      body: fixture(["12/09/2026", "11/09/2026", "06/09/2026"], [0]) }));
    for (const includeRead of [false, true]) {
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      await page.locator(".messageCell").evaluateAll(elements => {
        elements[0].classList.add("messageCell--state-selected");
        elements[1].classList.add("messageCell--state-highlighted");
      });
      const events: DiagnosticEvent[] = [];
      const result = await withDiagnosticSink(event => events.push(event),
        () => collectMessages(page, 7, now, 500, { includeRead }));
      assert.equal(result.status, "complete");
      assert.deepEqual(result.messages.map(message => message.id), includeRead ? ["0", "1"] : ["1"]);
      assert.deepEqual(result.messages.map(message => message.unreadBeforeOpen), includeRead ? [false, true] : [true]);
      assert(events.every(event => event.code !== "STATE_UNKNOWN"));
    }
  } finally { await page.close(); }
});

test("out-of-window record fields cannot make verified in-window messages incomplete", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html",
      body: fixture(["12/09/2026", "06/09/2026", "05/09/2026"]) }));
    for (const includeRead of [false, true]) {
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      await page.locator(".messageCell").evaluateAll(elements => {
        elements[1].setAttribute("class", "messageCell messageCell--state-PRIVATE_UNKNOWN");
        elements[1].querySelector(".messageCell__subject")!.textContent = "";
        elements[2].setAttribute("class", "messageCell");
        elements[2].removeAttribute("data-messageid");
        elements[2].querySelector(".messageCell__from")!.textContent = "";
      });
      const events: DiagnosticEvent[] = [];
      const result = await withDiagnosticSink(event => events.push(event),
        () => collectMessages(page, 7, now, 500, { includeRead }));
      assert.equal(result.status, "complete");
      assert.deepEqual(result.messages.map(message => message.id), ["0"]);
      assert.equal(result.scannedCount, 3);
      assert.equal(await page.locator('[data-opened="yes"]').count(), 1);
      assert(events.every(event => event.code !== "STATE_UNKNOWN" && event.code !== "RECORD_INVALID"));
    }
  } finally { await page.close(); }
});

test("collects matching days and bodies, excludes older items, and encrypts the run", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["01:10", "07/09/2026", "06/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 500);
    assert.equal(result.status, "complete");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1].bodyText, "Synthetic body 1");
    const key = randomBytes(32);
    const encrypted = encryptRun(result, key);
    assert(!JSON.stringify(encrypted).includes("Synthetic"));
    assert.deepEqual(decryptRun(encrypted, key), result);
    assert.throws(() => decryptRun(encrypted, randomBytes(32)));
  } finally { await page.close(); }
});

test("does not interpret missing rows as an empty inbox", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<h1>Loading</h1>" }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 200);
    assert.equal(result.status, "failed");
    assert.equal(result.warning, "INBOX_NOT_READY");
  } finally { await page.close(); }
});

test("flags stalled pagination rather than claiming complete coverage", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 200);
    assert.equal(result.status, "partial");
    assert.equal(result.warning, "SCROLL_COMPLETENESS_UNVERIFIED");
  } finally { await page.close(); }
});

test("scrolls for more records and deduplicates existing message IDs", async () => {
  const page = await browser.newPage();
  try {
    const html = fixture(["12/09/2026"]) + `<script>
      document.querySelector('.vueBrowse__unlockedBody').addEventListener('scroll', () => {
        const container = document.querySelector('.vueBrowse__unlockedBody');
        if (container.dataset.loaded) return;
        container.dataset.loaded = 'yes';
        const row = container.firstElementChild.cloneNode(true);
        row.dataset.messageid = 'older';
        row.querySelector('.messageCell__date').textContent = '06/09/2026';
        container.appendChild(row);
      });
    </script>`;
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 500);
    assert.equal(result.status, "complete");
    assert.equal(result.messages.length, 1);
    assert.equal(result.scannedCount, 2);
  } finally { await page.close(); }
});

test("rejects stale previews belonging to another message", async () => {
  const page = await browser.newPage();
  try {
    const html = fixture(["12/09/2026", "06/09/2026"]).replace("const id = subject.parentElement.dataset.messageid;", "const id = 'wrong-message';");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 200);
    assert.equal(result.status, "failed");
    assert.equal(result.messages.length, 0);
    assert.equal(result.warning, "MESSAGE_BODY_UNVERIFIED");
  } finally { await page.close(); }
});

test("unknown dates remain failed when no messages can be safely collected", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["PRIVATE_INVALID_DATE"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const result = await collectMessages(page, 7, now, 200);
    assert.equal(result.status, "failed");
    assert.equal(result.warning, "DATE_OR_ORDER_UNVERIFIED");
    assert.equal(result.scannedCount, 1);
    assert.equal(await page.locator("[data-opened]").count(), 0);
  } finally { await page.close(); }
});

test("row, unread-state and body errors skip only the affected message", async () => {
  const page = await browser.newPage();
  try {
    for (const issue of ["missing-id", "missing-subject", "unknown-state", "ambiguous-state", "absent-state",
      "stale-body", "empty-body", "oversized-body"]) {
      const html = fixture(["12/09/2026", "11/09/2026", "10/09/2026", "06/09/2026"]) + `<script>
        document.querySelector('.myMessagesVueBrowse').addEventListener('click', event => {
          const row = event.target.closest('.messageCell');
          if (row?.dataset.messageid !== '1') return;
          const issue = ${JSON.stringify(issue)};
          const record = document.querySelector('.currentRecordContent');
          if (issue === 'stale-body') record.dataset.primaryid = 'PRIVATE_WRONG_RECORD';
          if (issue === 'empty-body') record.querySelector('.myMessageContent').textContent = ' ';
          if (issue === 'oversized-body') record.querySelector('.myMessageContent').textContent = 'x'.repeat(1000001);
        });
      </script>`;
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      await page.locator('[data-messageid="1"]').evaluate((element, issue) => {
        if (issue === "missing-id") element.removeAttribute("data-messageid");
        if (issue === "missing-subject") element.querySelector(".messageCell__subject")!.textContent = "";
        if (issue === "unknown-state") element.setAttribute("class", "messageCell messageCell--state-PRIVATE_UNKNOWN");
        if (issue === "ambiguous-state") element.classList.add("messageCell--state-read");
        if (issue === "absent-state") element.setAttribute("class", "messageCell");
      }, issue);
      const events: DiagnosticEvent[] = [];
      // The million-character preview needs layout time before the next safe click on the Pi.
      const timeout = issue === "oversized-body" ? 1500 : 200;
      const result = await withDiagnosticSink(event => events.push(event), () => collectMessages(page, 7, now, timeout, { includeRead: true }));
      assert.equal(result.status, "partial", issue);
      assert.deepEqual(result.messages.map(message => message.id), ["0", "2"], `${issue}: ${JSON.stringify(events)}`);
      assert.equal(result.messages[1].bodyText, "Synthetic body 2");
      assert.equal(result.scannedCount, 4);
      assert.equal(await page.locator(".messageCell").nth(1).getAttribute("data-opened"), issue.endsWith("-body") ? "yes" : null);
      assert.equal(await page.locator('[data-messageid="3"]').getAttribute("data-opened"), null);
      assert(events.some(event => event.record === 2 && event.page === 1 &&
        event.code === (issue.endsWith("-body") ? "MESSAGE_BODY_UNVERIFIED" : issue.endsWith("-state") ? "STATE_UNKNOWN" : "RECORD_INVALID")));
      if (issue.endsWith("-state")) {
        const diagnostic = events.find(event => event.record === 2 && event.code === "STATE_UNKNOWN")!;
        assert.equal(diagnostic.flags?.hasReadState, issue === "ambiguous-state");
        assert.equal(diagnostic.flags?.hasUnreadState, issue === "ambiguous-state");
        assert.equal(diagnostic.counts?.stateMarkers, issue === "ambiguous-state" ? 2 : issue === "absent-state" ? 0 : 1);
      }
      assert.equal(events[0].code, "RUN_STARTED");
      assert.equal(events.at(-1)?.code, "RUN_SUMMARY");
      assert.equal(events.at(-1)?.status, "partial");
      assert(events.every(event => event.runId === result.runId));
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Synthetic|Message \d|https?:|body 2/);
      await page.unroute("**/*");
    }
  } finally { await page.close(); }
});

test("bad or out-of-order dates disable early boundary completion while later scoped messages are retained", async () => {
  const page = await browser.newPage();
  try {
    for (const dates of [["12/09/2026", "PRIVATE_INVALID_DATE", "06/09/2026"],
      ["06/09/2026", "12/09/2026"], ["12/09/2026", "14/09/2026", "06/09/2026"]]) {
      const html = fixture(dates) + `<script>
        document.querySelector('.vueBrowse__unlockedBody').addEventListener('scroll', () => {
          const container = document.querySelector('.vueBrowse__unlockedBody');
          if (container.dataset.loaded) return;
          container.dataset.loaded = 'yes';
          for (const [id, date] of [['PRIVATE_LATER_ID', '11/09/2026'], ['PRIVATE_OLD_ID', '05/09/2026']]) {
            const row = container.firstElementChild.cloneNode(true);
            row.dataset.messageid = id;
            delete row.dataset.opened;
            row.className = 'messageCell messageCell--state-unread';
            row.querySelector('.messageCell__date').textContent = date;
            container.appendChild(row);
          }
        });
      </script>`;
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      const events: DiagnosticEvent[] = [];
      const result = await withDiagnosticSink(event => events.push(event), () => collectMessages(page, 7, now, 200));
      assert.equal(result.status, "partial");
      assert.equal(result.warning, "DATE_OR_ORDER_UNVERIFIED");
      assert.equal(result.scannedCount, dates.length + 2);
      assert.deepEqual(result.messages.map(message => message.id), [dates.length === 2 ? "1" : "0", "PRIVATE_LATER_ID"]);
      assert(result.messages.every(message => message.sentDate >= result.window.startDate && message.sentDate <= result.window.endDate));
      assert.equal(await page.locator('[data-messageid="PRIVATE_OLD_ID"]').getAttribute("data-opened"), null);
      if (dates.length === 3) assert.equal(await page.locator('[data-messageid="1"]').getAttribute("data-opened"), null);
      assert(events.some(event => event.code === "SCROLL_COMPLETENESS_UNVERIFIED" && event.page === 2));
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Synthetic|https?:|14\/09/);
      await page.unroute("**/*");
    }
  } finally { await page.close(); }
});

test("ambiguous message identities are not opened while later independent rows still collect", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "11/09/2026", "10/09/2026", "06/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    await page.locator('[data-messageid="1"]').evaluate(element => { element.setAttribute("data-messageid", "0"); });
    const result = await withDiagnosticSink(event => events.push(event), () => collectMessages(page, 7, now, 200));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.messages.map(message => message.id), ["2"]);
    assert.equal(result.scannedCount, 4);
    assert.equal(await page.locator('[data-messageid="0"][data-opened]').count(), 0);
    assert.equal(events.filter(event => event.code === "DUPLICATE_RECORD").length, 2);
  } finally { await page.close(); }
});

test("authentication and source-scope failures stop collection without login or navigation retries", async () => {
  const page = await browser.newPage();
  const events: DiagnosticEvent[] = [];
  let navigations = 0;
  try {
    await page.route("**/*", route => {
      if (route.request().isNavigationRequest()) navigations++;
      return route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "06/09/2026"]) });
    });
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    await page.setContent('<input type="password">');
    const expired = await withDiagnosticSink(event => events.push(event), () => collectMessages(page, 7, now, 200));
    assert.equal(expired.status, "failed");
    assert.equal(expired.warning, "AUTH_REQUIRED");
    assert.equal(navigations, 1);
    await page.goto("https://unapproved.example/PRIVATE_SOURCE");
    const wrongScope = await withDiagnosticSink(event => events.push(event), () => collectMessages(page, 7, now, 200));
    assert.equal(wrongScope.status, "failed");
    assert.equal(navigations, 2);
    assert.equal(await page.locator("[data-opened]").count(), 0);
    assert(events.some(event => event.code === "AUTH_REQUIRED"));
    assert(events.some(event => event.code === "SCOPE_MISSING" && event.field === "source"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|unapproved|https?:/);

    await page.unroute("**/*");
    const html = fixture(["12/09/2026", "11/09/2026", "10/09/2026", "06/09/2026"]) + `<script>
      document.querySelector('.myMessagesVueBrowse').addEventListener('click', event => {
        if (event.target.closest('.messageCell')?.dataset.messageid === '1') {
          document.body.insertAdjacentHTML('beforeend', '<input type="password">');
        }
      });
    </script>`;
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    const interrupted = await withDiagnosticSink(() => {}, () => collectMessages(page, 7, now, 200));
    assert.equal(interrupted.status, "partial");
    assert.equal(interrupted.warning, "AUTH_REQUIRED");
    assert.deepEqual(interrupted.messages.map(message => message.id), ["0"]);
    assert.equal(await page.locator('[data-messageid="2"]').getAttribute("data-opened"), null);
  } finally { await page.close(); }
});

test("message collection preserves batch and record caps without claiming empty success", async () => {
  await withDiagnosticSink(() => {}, async () => {
    for (const manyRows of [false, true]) {
      let batches = 0;
      let scrolls = 0;
      const page = {
        url: () => portalConfig.portals.skyward.urls.messages.inbox,
        locator: () => ({
          count: async () => 0,
          first: () => ({ waitFor: async () => {} }),
          evaluate: async () => { scrolls++; },
          evaluateAll: async () => {
            batches++;
            return Array.from({ length: manyRows ? 100_001 : 1 }, (_, index) => ({
              key: `${batches}-${index}`, id: `${batches}-${index}`, sender: "Synthetic sender", subject: "Synthetic subject",
              date: "12/09/2026", unread: false,
            }));
          },
        }),
        waitForFunction: async () => {},
      } as unknown as Page;
      const result = await collectMessages(page, 7, now, 100);
      assert.equal(result.status, "failed");
      assert.equal(result.warning, "COLLECTION_LIMIT_REACHED");
      assert.equal(result.messages.length, 0);
      assert.equal(result.scannedCount, manyRows ? 100_000 : 50);
      assert.equal(batches, manyRows ? 1 : 50);
      assert.equal(scrolls, manyRows ? 0 : 49);
    }
  });
});

test("message diagnostics omit raw exceptions and DiagnosticLogError is never swallowed", async () => {
  const events: DiagnosticEvent[] = [];
  const brokenPage = {
    url: () => portalConfig.portals.skyward.urls.messages.inbox,
    locator: () => ({
      count: async () => 0,
      first: () => ({ waitFor: async () => { throw new Error("PRIVATE_EXTRACT_EXCEPTION https://private.example/secret"); } }),
    }),
  } as unknown as Page;
  const failed = await withDiagnosticSink(event => events.push(event), () => collectMessages(brokenPage, 7, now, 100));
  assert.equal(failed.status, "failed");
  assert(events.some(event => event.code === "LIST_LAYOUT_UNVERIFIED" && event.errorType === "other"));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|https?:|secret/);

  const page = await browser.newPage();
  const error = new DiagnosticLogError("PRIVATE_LOG_FAILURE");
  try {
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(["12/09/2026", "06/09/2026"]) }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    await page.locator('[data-messageid="0"]').evaluate(element => { element.setAttribute("class", "messageCell"); });
    await assert.rejects(() => withDiagnosticSink(event => {
      if (event.code === "STATE_UNKNOWN") throw error;
    }, () => collectMessages(page, 7, now, 200)), failure => failure === error);
  } finally { await page.close(); }
});