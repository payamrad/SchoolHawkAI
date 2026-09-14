import { chromium, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import portalConfig from "../../../config/portals.json";
import type { MessageRun } from "@schoolhawk/core/messages";
import { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import type { MessageStore } from "@schoolhawk/storage/messages";
export { encryptRun, decryptRun } from "@schoolhawk/storage/encrypted-runs";
export type { CollectedMessage, MessageRun } from "@schoolhawk/core/messages";

const ROOT = path.resolve(__dirname, "../../..");
const AUTH = path.join(ROOT, "playwright/.auth");
const INBOX = portalConfig.portals.skyward.urls.messages.inbox;
const ROWS = ".myMessagesVueBrowse .messageCell[data-messageid]";
const ZONE = "America/Los_Angeles";
let runStage = "CONFIGURATION";

class MessageUsageError extends Error {}

export function parseDays(args: string[]): number {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    throw new MessageUsageError("Provide exactly one day count. Run: npm run skyward:messages -- 7 --account lkwash-parent");
  }
  const days = Number(args[0]);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new MessageUsageError("N must be an integer between 1 and 366. Example: npm run skyward:messages -- 7 --account lkwash-parent");
  }
  return days;
}

export function parseMessageOptions(args: string[]) {
  const remaining = [...args];
  const accountIndex = remaining.indexOf("--account");
  let accountId: string | undefined;
  if (accountIndex !== -1) {
    accountId = remaining[accountIndex + 1];
    if (remaining.filter(arg => arg === "--account").length !== 1 ||
        !accountId || !/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)) {
      throw new MessageUsageError("Use --account once with an alias containing letters, digits, underscores, or hyphens. Example: --account lkwash-parent");
    }
    remaining.splice(accountIndex, 2);
  }
  const allFlags = remaining.filter(arg => arg === "--all");
  if (allFlags.length > 1) throw new MessageUsageError("Use --all at most once. Example: npm run skyward:messages -- 7 --account lkwash-parent --all");
  return { days: parseDays(remaining.filter(arg => arg !== "--all")), includeRead: allFlags.length === 1, accountId };
}

export function dateWindow(days: number, now = new Date()): MessageRun["window"] {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("N must be an integer between 1 and 366.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;
  const endDate = `${year}-${month}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("Cannot determine Pacific calendar date.");
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { days, startDate: start.toISOString().slice(0, 10), endDate, timeZone: ZONE };
}

export function messageDate(label: string, today: string): string {
  const text = label.trim();
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[AP]M)?$/i.test(text) || /^today$/i.test(text)) return today;
  if (/^yesterday$/i.test(text)) {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) throw new Error("Unrecognized message date.");
  const value = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid message date.");
  }
  return value;
}

export async function collectMessages(page: Page, days: number, now = new Date(), timeout = 15_000, options: { includeRead?: boolean } = {}): Promise<MessageRun> {
  const result: MessageRun = {
    runId: randomUUID(), capturedAt: now.toISOString(), window: dateWindow(days, now),
    status: "failed", messages: [], scannedCount: 0, parserVersion: 1,
    selection: options.includeRead ? "all" : "unread",
  };
  const seen = new Set<string>();
  let stage = "INBOX_NOT_READY";
  let previousDate = "9999-12-31";
  try {
    await page.locator(ROWS).first().waitFor({ timeout });
    if (new URL(page.url()).origin !== new URL(INBOX).origin ||
      new URL(page.url()).pathname !== new URL(INBOX).pathname) throw new Error();
    for (let batch = 0; batch < 50; batch++) {
      stage = "LIST_EXTRACTION_FAILED";
      const rows = await page.locator(ROWS).evaluateAll(elements => elements.map(element => ({
        id: element.getAttribute("data-messageid") || "",
        sender: element.querySelector(".messageCell__from")?.textContent?.trim() || "",
        subject: element.querySelector(".messageCell__subject")?.textContent?.trim() || "",
        date: element.querySelector(".messageCell__date")?.textContent?.trim() || "",
        unread: element.classList.contains("messageCell--state-unread"),
      })));
      let crossedBoundary = false;
      for (const row of rows) {
        if (!row.id || !row.sender || !row.subject) throw new Error();
        if (seen.has(row.id)) continue;
        stage = "DATE_OR_ORDER_UNVERIFIED";
        const sentDate = messageDate(row.date, result.window.endDate);
        if (sentDate > previousDate || sentDate > result.window.endDate) throw new Error();
        previousDate = sentDate;
        seen.add(row.id);
        result.scannedCount++;
        if (sentDate < result.window.startDate) {
          crossedBoundary = true;
          continue;
        }
        if (!options.includeRead && !row.unread) continue;
        stage = "MESSAGE_BODY_UNVERIFIED";
        const cell = page.locator(ROWS).filter({ has: page.locator(".messageCell__subject") });
        const target = await cell.evaluateAll((elements, id) => elements.findIndex(element => element.getAttribute("data-messageid") === id), row.id);
        if (target < 0) throw new Error();
        await cell.nth(target).locator(".messageCell__subject").click();
        await page.waitForFunction(id => {
          const record = document.querySelector(".detailsPanel__myMessages .currentRecordContent[data-primaryid]");
          return record?.getAttribute("data-primaryid") === id && !!record.querySelector(".myMessageContent");
        }, row.id, { timeout });
        const bodyText = await page.locator(".detailsPanel__myMessages .myMessageContent").allInnerTexts();
        if (bodyText.length !== 1 || !bodyText[0].trim() || bodyText[0].length > 1_000_000) throw new Error();
        result.messages.push({
          id: row.id, sender: row.sender, subject: row.subject, sentDate,
          displayedDate: row.date, unreadBeforeOpen: row.unread, bodyText: bodyText[0].trim(),
          source: { portal: "skyward", url: INBOX, capturedAt: new Date().toISOString() },
        });
      }
      if (crossedBoundary) {
        result.status = "complete";
        return result;
      }
      stage = "SCROLL_COMPLETENESS_UNVERIFIED";
      const knownIds = [...seen];
      await page.locator(".myMessagesVueBrowse .vueBrowse__unlockedBody").evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await page.waitForFunction(({ selector, known }) =>
        [...document.querySelectorAll(selector)].some(element => !known.includes(element.getAttribute("data-messageid") || "")),
      { selector: ROWS, known: knownIds }, { timeout });
    }
    stage = "COLLECTION_LIMIT_REACHED";
    throw new Error();
  } catch {
    result.status = result.messages.length ? "partial" : "failed";
    result.warning = stage;
    return result;
  }
}

async function checkPrivate(filePath: string, directory = false) {
  const info = await lstat(filePath);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Unsafe permissions or ownership.");
}

export async function collectMessagesToStore(page: Page, store: Pick<MessageStore, "importRun">, accountId: string,
  days: number, now = new Date(), timeout = 15_000, options: { includeRead?: boolean } = {}): Promise<MessageRun> {
  const result = await collectMessages(page, days, now, timeout, options);
  runStage = "DATABASE_WRITE";
  store.importRun(accountId, result);
  return result;
}

async function main() {
  process.umask(0o077);
  const { days, includeRead, accountId } = parseMessageOptions(process.argv.slice(2));
  if (!accountId) throw new MessageUsageError("Provide the same account alias used for stored data. Example: npm run skyward:messages -- 7 --account lkwash-parent");
  runStage = "DATE_WINDOW";
  dateWindow(days);
  runStage = "PRIVATE_SESSION_FILE";
  await checkPrivate(AUTH, true);
  const statePath = path.join(AUTH, "skyward.json");
  await checkPrivate(statePath);
  const { entryUrl, cookies, origins } = JSON.parse(await readFile(statePath, "utf8"));
  runStage = "SAVED_ENTRY_URL";
  const entry = new URL(entryUrl);
  if (entry.origin !== new URL(INBOX).origin ||
    !(entry.pathname === "/lkwash" || entry.pathname.startsWith("/lkwash/")) ||
    entry.username || entry.password) throw new Error("Invalid saved application entry.");
  runStage = "DATABASE_OPEN";
  const dataDirectory = path.join(ROOT, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await checkPrivate(dataDirectory, true);
  const databasePath = path.join(dataDirectory, "database/schoolhawk.sqlite");
  runStage = "PRIVATE_DATABASE_KEY";
  const keyPath = path.join(AUTH, "messages.key");
  await checkPrivate(keyPath);
  const key = await readFile(keyPath);
  try {
    if (key.length !== 32) throw new Error("Invalid encryption key.");
    runStage = "DATABASE_OPEN";
    const store = new SqliteMessageStore(databasePath, key);
    try {
      runStage = "BROWSER_LAUNCH";
      const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      try {
        runStage = "SESSION_RESUME";
        const context = await browser.newContext({ storageState: { cookies, origins },
          viewport: { width: 1440, height: 1000 }, timezoneId: ZONE, acceptDownloads: false });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(entry.href, { waitUntil: "domcontentloaded" });
        runStage = "INBOX_NAVIGATION";
        await page.getByRole("link", { name: /my messages/i }).first().click();
        const result = await collectMessagesToStore(page, store, accountId, days, new Date(), 15_000, { includeRead });
        console.log(JSON.stringify({ status: result.status, selection: result.selection, window: result.window,
          messages: result.messages.length, scanned: result.scannedCount, runId: result.runId,
          warning: result.warning, database: path.relative(ROOT, databasePath) }, null, 2));
        if (result.status !== "complete") process.exitCode = 1;
      } finally { await browser.close(); }
    } finally { store.close(); }
  } finally { key.fill(0); }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof MessageUsageError) {
      console.error(`MESSAGES: ${error.message} No login was attempted.`);
      process.exitCode = 1;
      return;
    }
    if (runStage === "DATE_WINDOW" || runStage === "CONFIGURATION") {
      console.error(`MESSAGES: Failed at ${runStage} before session access (Node ${process.version}). Check the system clock and Node timezone support. No login was attempted.`);
      process.exitCode = 1;
      return;
    }
    if (["PRIVATE_DATABASE_KEY", "DATABASE_OPEN", "DATABASE_WRITE"].includes(runStage)) {
      console.error(`MESSAGES: Failed at ${runStage}. Check database permissions, disk space, and the original messages.key. For a new installation run bash scripts/setup-database.sh; never replace a lost key. If messages were opened, retry with --all after fixing storage. No private error details printed.`);
      process.exitCode = 1;
      return;
    }
    console.error(`MESSAGES: Failed at ${runStage}. Check N (1-366), private storage permissions, and renew the session with skyward:login if needed. No private error details printed.`);
    process.exitCode = 1;
  });
}