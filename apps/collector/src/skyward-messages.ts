import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import portalConfig from "../../../config/portals.json";
import { collectedMessageSchema, messageRunSchema, type MessageRun } from "@schoolhawk/core/messages";
import { DiagnosticLogError, diagnosticErrorType, reportDiagnostic, type DiagnosticEvent } from "@schoolhawk/core/diagnostics";
import type { MessageStore } from "@schoolhawk/storage/messages";
import { withLocalDiagnostics } from "@schoolhawk/storage/diagnostics";
import { dateWindow, withSkywardCollection } from "./skyward";
export { dateWindow } from "./skyward";
export { encryptRun, decryptRun } from "@schoolhawk/storage/encrypted-runs";
export type { CollectedMessage, MessageRun } from "@schoolhawk/core/messages";

const INBOX = portalConfig.portals.skyward.urls.messages.inbox;
const ROWS = ".myMessagesVueBrowse .messageCell";
const rowSchema = collectedMessageSchema.pick({ id: true, sender: true, subject: true, displayedDate: true });
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

export function messageDate(label: string, today: string): string {
  const text = label.trim();
  if (/^(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:0?[1-9]|1[0-2]):[0-5]\d\s*[AP]M)$/i.test(text) || /^today$/i.test(text)) return today;
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

function snapshotMessageRows(elements: Element[]) {
  const occurrences = new Map<string, number>();
  return elements.slice(0, 100_001).map(element => {
    const id = element.getAttribute("data-messageid") || "";
    const identity = id ? `id:${id}` : `missing:${element.textContent ?? ""}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const hasReadState = element.classList.contains("messageCell--state-read");
    const hasUnreadState = element.classList.contains("messageCell--state-unread");
    return {
      key: `${occurrence}:${identity}`, id,
      sender: element.querySelector(".messageCell__from")?.textContent?.trim() || "",
      subject: element.querySelector(".messageCell__subject")?.textContent?.trim() || "",
      subjectCount: element.querySelectorAll(".messageCell__subject").length,
      date: element.querySelector(".messageCell__date")?.textContent?.trim() || "",
      unread: hasReadState === hasUnreadState ? null : hasUnreadState,
      hasReadState, hasUnreadState,
      stateMarkers: [...element.classList].filter(value => value.startsWith("messageCell--state-")).length,
    };
  });
}

export async function collectMessages(page: Page, days: number, now = new Date(), timeout = 15_000, options: { includeRead?: boolean } = {}): Promise<MessageRun> {
  const startedAt = Date.now();
  const result: MessageRun = {
    runId: randomUUID(), capturedAt: now.toISOString(), window: dateWindow(days, now),
    status: "failed", messages: [], scannedCount: 0, parserVersion: 1,
    selection: options.includeRead ? "all" : "unread",
  };
  const seen = new Set<string>();
  const stageCodes = { INBOX_NOT_READY: "LIST_LAYOUT_UNVERIFIED", LIST_EXTRACTION_FAILED: "RESPONSE_INVALID",
    SCROLL_COMPLETENESS_UNVERIFIED: "SCROLL_COMPLETENESS_UNVERIFIED" } as const;
  let stage: keyof typeof stageCodes = "INBOX_NOT_READY";
  let batches = 0;
  let failures = 0;
  let duplicates = 0;
  let previousDate = "9999-12-31";
  // A later older row cannot restore the ordering evidence lost to an invalid date.
  let dateOrderVerified = true;
  const warn = (warning: string, event: DiagnosticEvent) => {
    failures++;
    if (!result.warning || warning === "AUTH_REQUIRED") result.warning = warning;
    reportDiagnostic({ portal: "skyward", section: "messages", runId: result.runId, page: batches || undefined, ...event });
  };
  const finish = (boundaryVerified = false) => {
    result.status = boundaryVerified && failures === 0 ? "complete" : result.messages.length ? "partial" : "failed";
    const parsed = messageRunSchema.parse(result);
    reportDiagnostic({ level: result.status === "complete" ? "info" : "warn", code: "RUN_SUMMARY", portal: "skyward", section: "messages",
      runId: result.runId, status: result.status, durationMs: Math.max(0, Date.now() - startedAt),
      counts: { scanned: result.scannedCount, accepted: result.messages.length, skipped: result.scannedCount - result.messages.length,
        pages: batches, duplicates }, flags: { verifiedEmpty: result.status === "complete" && result.messages.length === 0 } });
    return parsed;
  };
  const verifyInbox = async () => {
    if (await page.locator('input[type="password"]:visible').count()) {
      warn("AUTH_REQUIRED", { code: "AUTH_REQUIRED" });
      return false;
    }
    const current = new URL(page.url());
    const expected = new URL(INBOX);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.username || current.password) {
      warn("INBOX_NOT_READY", { code: "SCOPE_MISSING", field: "source" });
      return false;
    }
    return true;
  };
  reportDiagnostic({ level: "info", code: "RUN_STARTED", portal: "skyward", section: "messages", runId: result.runId, parserVersion: result.parserVersion });
  try {
    if (!await verifyInbox()) return finish();
    await page.locator(ROWS).first().waitFor({ timeout });
    for (let batch = 0; batch < 50; batch++) {
      batches = batch + 1;
      if (!await verifyInbox()) return finish();
      stage = "LIST_EXTRACTION_FAILED";
      const rows = await page.locator(ROWS).evaluateAll(snapshotMessageRows);
      const idCounts = new Map<string, number>();
      for (const row of rows) if (row.id) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
      const scannedBefore = result.scannedCount;
      const acceptedBefore = result.messages.length;
      const failuresBefore = failures;
      let crossedBoundary = false;
      for (const row of rows) {
        if (seen.has(row.key)) continue;
        if (result.scannedCount >= 100_000) {
          warn("COLLECTION_LIMIT_REACHED", { code: "COLLECTION_LIMIT", flags: { capped: true } });
          return finish();
        }
        seen.add(row.key);
        result.scannedCount++;
        const location = { record: result.scannedCount, page: batches };
        let sentDate: string;
        try {
          collectedMessageSchema.shape.displayedDate.parse(row.date);
          sentDate = messageDate(row.date, result.window.endDate);
          if (sentDate > result.window.endDate) throw new Error();
        } catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          dateOrderVerified = false;
          warn("DATE_OR_ORDER_UNVERIFIED", { code: "DATE_UNVERIFIED", ...location, field: "sentDate", errorType: diagnosticErrorType(error) });
          continue;
        }
        if (sentDate > previousDate) {
          dateOrderVerified = false;
          warn("DATE_OR_ORDER_UNVERIFIED", { code: "DATE_ORDER_UNVERIFIED", ...location, field: "sentDate" });
        }
        previousDate = sentDate;
        if (sentDate < result.window.startDate) {
          crossedBoundary = true;
          continue;
        }
        const parsed = rowSchema.safeParse({ ...row, displayedDate: row.date });
        if (!parsed.success) {
          const field = parsed.error.issues[0]?.path[0];
          warn("RECORD_INVALID", { code: "RECORD_INVALID", ...location, errorType: diagnosticErrorType(parsed.error),
            field: field === "id" ? "id" : field === "sender" ? "name" : field === "subject" ? "title" : "date" });
          continue;
        }
        if (idCounts.get(row.id)! > 1) {
          duplicates++;
          warn("RECORD_INVALID", { code: "DUPLICATE_RECORD", ...location, field: "id" });
          continue;
        }
        if (row.unread === null) {
          warn("STATE_UNKNOWN", { code: "STATE_UNKNOWN", ...location, field: "unread",
            counts: { stateMarkers: row.stateMarkers },
            flags: { hasReadState: row.hasReadState, hasUnreadState: row.hasUnreadState } });
          continue;
        }
        if (!options.includeRead && !row.unread) continue;
        if (!await verifyInbox()) return finish();
        try {
          const cell = page.locator(ROWS);
          const matches = (await cell.evaluateAll(snapshotMessageRows)).map((value, index) => ({ value, index }))
            .filter(({ value }) => value.id === row.id);
          if (matches.length !== 1) throw new Error();
          const { value, index } = matches[0];
          if (value.subjectCount !== 1 || value.subject !== row.subject || value.sender !== row.sender ||
              value.date !== row.date || value.unread !== row.unread) throw new Error();
          await cell.nth(index).locator(".messageCell__subject").click({ timeout });
          await page.waitForFunction(id => {
            const records = document.querySelectorAll(".detailsPanel__myMessages .currentRecordContent[data-primaryid]");
            return records.length === 1 && records[0].getAttribute("data-primaryid") === id && records[0].querySelectorAll(".myMessageContent").length === 1;
          }, row.id, { timeout });
          if (!await verifyInbox()) return finish();
          const bodyText = await page.locator(".detailsPanel__myMessages .currentRecordContent[data-primaryid]").evaluateAll((records, id) => {
            if (records.length !== 1 || records[0].getAttribute("data-primaryid") !== id) return null;
            const bodies = records[0].querySelectorAll<HTMLElement>(".myMessageContent");
            return bodies.length === 1 && (bodies[0].textContent?.length ?? 0) <= 1_000_000 ? bodies[0].innerText : null;
          }, row.id);
          if (typeof bodyText !== "string" || bodyText.length > 1_000_000) throw new Error();
          result.messages.push(collectedMessageSchema.parse({
            ...parsed.data, sentDate, unreadBeforeOpen: row.unread, bodyText: bodyText.trim(),
            source: { portal: "skyward", url: INBOX, capturedAt: new Date().toISOString() },
          }));
        } catch (error) {
          if (error instanceof DiagnosticLogError) throw error;
          warn("MESSAGE_BODY_UNVERIFIED", { code: "MESSAGE_BODY_UNVERIFIED", ...location, field: "body", errorType: diagnosticErrorType(error) });
          if (!await verifyInbox()) return finish();
        }
      }
      reportDiagnostic({ level: "info", code: "SECTION_SUMMARY", portal: "skyward", section: "messages", runId: result.runId, page: batches,
        status: failures === failuresBefore ? "complete" : "partial",
        counts: { scanned: result.scannedCount - scannedBefore, accepted: result.messages.length - acceptedBefore,
          skipped: result.scannedCount - scannedBefore - (result.messages.length - acceptedBefore) } });
      if (crossedBoundary && dateOrderVerified) return finish(true);
      if (batch === 49) break;
      stage = "SCROLL_COMPLETENESS_UNVERIFIED";
      const knownKeys = [...seen];
      await page.locator(".myMessagesVueBrowse .vueBrowse__unlockedBody").evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await page.waitForFunction(({ selector, known }) => {
        const occurrences = new Map<string, number>();
        const knownKeys = new Set(known);
        return [...document.querySelectorAll(selector)].some(element => {
          const id = element.getAttribute("data-messageid") || "";
          const identity = id ? `id:${id}` : `missing:${element.textContent ?? ""}`;
          const occurrence = (occurrences.get(identity) ?? 0) + 1;
          occurrences.set(identity, occurrence);
          return !knownKeys.has(`${occurrence}:${identity}`);
        });
      }, { selector: ROWS, known: knownKeys }, { timeout });
    }
    warn("COLLECTION_LIMIT_REACHED", { code: "COLLECTION_LIMIT", flags: { capped: true } });
  } catch (error) {
    if (error instanceof DiagnosticLogError) throw error;
    warn(stage, { code: stageCodes[stage], errorType: diagnosticErrorType(error) });
  }
  return finish();
}

export async function collectMessagesToStore(page: Page, store: Pick<MessageStore, "importRun">, accountId: string,
  days: number, now = new Date(), timeout = 15_000, options: { includeRead?: boolean } = {}): Promise<MessageRun> {
  const result = await collectMessages(page, days, now, timeout, options);
  runStage = "DATABASE_WRITE";
  reportDiagnostic({ level: "info", code: "STAGE_STARTED", portal: "skyward", section: "messages",
    stage: "DATABASE_WRITE", runId: result.runId });
  store.importRun(accountId, result);
  return result;
}

async function main() {
  const { days, includeRead, accountId } = parseMessageOptions(process.argv.slice(2));
  if (!accountId) throw new MessageUsageError("Provide the same account alias used for stored data. Example: npm run skyward:messages -- 7 --account lkwash-parent");
  runStage = "DATE_WINDOW";
  dateWindow(days);
  const { result, database } = await withSkywardCollection(async (page, store) => {
    runStage = "INBOX_NAVIGATION";
    reportDiagnostic({ level: "info", code: "STAGE_STARTED", portal: "skyward", section: "messages", stage: "INBOX_NAVIGATION" });
    await page.getByRole("link", { name: /my messages/i }).first().click();
    return collectMessagesToStore(page, store, accountId, days, new Date(), 15_000, { includeRead });
  }, { onStage: stage => { runStage = stage; } });
  console.log(JSON.stringify({ status: result.status, selection: result.selection, window: result.window,
    messages: result.messages.length, scanned: result.scannedCount, runId: result.runId,
    warning: result.warning, database }, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}

if (require.main === module) {
  withLocalDiagnostics(path.resolve(__dirname, "../../.."), "skyward:messages", main).catch((error: unknown) => {
    if (error instanceof DiagnosticLogError) {
      console.error(`LOCAL_LOG: ${error.message}`);
      process.exitCode = 1;
      return;
    }
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