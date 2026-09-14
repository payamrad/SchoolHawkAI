import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { collectMessages, dateWindow, decryptRun, encryptRun, messageDate, parseDays, parseMessageOptions } from "../src/skyward-messages";
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
  assert.deepEqual(parseMessageOptions(["7"]), { days: 7, includeRead: false });
  assert.deepEqual(parseMessageOptions(["7", "--all"]), { days: 7, includeRead: true });
  assert.deepEqual(parseMessageOptions(["--all", "7"]), { days: 7, includeRead: true });
  for (const args of [["--all"], ["7", "--all", "--all"], ["7", "--unknown"]]) {
    assert.throws(() => parseMessageOptions(args));
  }
});

function fixture(dates: string[], readIds: number[] = []) {
  return `<div class="myMessagesVueBrowse"><div class="vueBrowse__unlockedBody">${dates.map((date, index) =>
    `<div class="messageCell ${readIds.includes(index) ? "" : "messageCell--state-unread"}" data-messageid="${index}"><span class="messageCell__from">Synthetic sender</span><div class="messageCell__subject">Message ${index}</div><div class="messageCell__date">${date}</div></div>`).join("")}</div></div>
    <div class="detailsPanel__myMessages"></div><script>
      document.querySelectorAll('.messageCell__subject').forEach(subject => subject.onclick = () => {
        const id = subject.parentElement.dataset.messageid;
        subject.parentElement.dataset.opened = 'yes';
        subject.parentElement.classList.remove('messageCell--state-unread');
        document.querySelector('.detailsPanel__myMessages').innerHTML = '<div class="currentRecordContent" data-primaryid="' + id + '"><div class="myMessageContent">Synthetic body ' + id + '</div></div>';
      });
    </script>`;
}

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

test("rejects unknown dates and does not stop early on an out-of-order list", async () => {
  const page = await browser.newPage();
  try {
    for (const dates of [["unknown"], ["06/09/2026", "12/09/2026"]]) {
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture(dates) }));
      await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
      const result = await collectMessages(page, 7, now, 200);
      assert.equal(result.status, "failed");
      assert.equal(result.warning, "DATE_OR_ORDER_UNVERIFIED");
      await page.unroute("**/*");
    }
  } finally { await page.close(); }
});