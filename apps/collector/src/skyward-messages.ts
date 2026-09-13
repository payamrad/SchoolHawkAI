import { chromium, type Page } from "playwright";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import portalConfig from "../../../config/portals.json";

const ROOT = path.resolve(__dirname, "../../..");
const AUTH = path.join(ROOT, "playwright/.auth");
const INBOX = portalConfig.portals.skyward.urls.messages.inbox;
const ROWS = ".myMessagesVueBrowse .messageCell[data-messageid]";
const ZONE = "America/Los_Angeles";
let runStage = "CONFIGURATION";

export function dateWindow(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("N must be an integer between 1 and 366.");
  }
  const endDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
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

export interface CollectedMessage {
  id: string;
  sender: string;
  subject: string;
  sentDate: string;
  displayedDate: string;
  unreadBeforeOpen: boolean;
  bodyText: string;
  source: { portal: "skyward"; url: string; capturedAt: string };
}

export interface MessageRun {
  runId: string;
  capturedAt: string;
  window: ReturnType<typeof dateWindow>;
  status: "complete" | "partial" | "failed";
  warning?: string;
  messages: CollectedMessage[];
  scannedCount: number;
  parserVersion: 1;
}

export async function collectMessages(page: Page, days: number, now = new Date(), timeout = 15_000): Promise<MessageRun> {
  const result: MessageRun = {
    runId: randomUUID(), capturedAt: now.toISOString(), window: dateWindow(days, now),
    status: "failed", messages: [], scannedCount: 0, parserVersion: 1,
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

export function encryptRun(run: MessageRun, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(run), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptRun(envelope: ReturnType<typeof encryptRun>, key: Buffer): MessageRun {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted result.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

async function checkPrivate(filePath: string, directory = false) {
  const info = await lstat(filePath);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Unsafe permissions or ownership.");
}

async function writePrivate(filePath: string, data: string | Buffer) {
  const file = await open(filePath, "wx", 0o600);
  try { await file.writeFile(data); } finally { await file.close(); }
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^\d+$/.test(args[0])) throw new Error("Usage: npm run skyward:messages -- N");
  const days = Number(args[0]);
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
  runStage = "ENCRYPTED_OUTPUT_STORAGE";
  const dataDirectory = path.join(ROOT, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await checkPrivate(dataDirectory, true);
  const outputDirectory = path.join(dataDirectory, "messages");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await checkPrivate(outputDirectory, true);
  const keyPath = path.join(AUTH, "messages.key");
  try { await writePrivate(keyPath, randomBytes(32)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await checkPrivate(keyPath);
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error("Invalid encryption key.");
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
    const result = await collectMessages(page, days);
    runStage = "ENCRYPTED_RESULT_WRITE";
    const output = path.join(outputDirectory, `${result.runId}.json.enc`);
    await writePrivate(output, JSON.stringify(encryptRun(result, key)));
    console.log(JSON.stringify({ status: result.status, window: result.window,
      messages: result.messages.length, scanned: result.scannedCount,
      warning: result.warning, output: path.relative(ROOT, output) }, null, 2));
    if (result.status !== "complete") process.exitCode = 1;
  } finally { await browser.close(); }
}

if (require.main === module) {
  main().catch(() => {
    console.error(`MESSAGES: Failed at ${runStage}. Check N (1-366), private storage permissions, and renew the session with skyward:login if needed. No private error details printed.`);
    process.exitCode = 1;
  });
}