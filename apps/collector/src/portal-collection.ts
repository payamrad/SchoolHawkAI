import { chromium, type Page } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkPrivatePath } from "@schoolhawk/storage/private-files";
import { withWorkspaceStore, type SqliteCanvasStore } from "@schoolhawk/storage/canvas-sqlite";
import portalConfig from "../../../config/portals.json";
import { restrictPortalNavigation, type PortalId } from "./portal-session";

const ROOT = path.resolve(__dirname, "../../..");
export interface CollectionOptions { root?: string; onStage?: (stage: string) => void }

export function readPortalSession(portal: PortalId, root = ROOT, onStage: (stage: string) => void = () => {}) {
  onStage("PRIVATE_SESSION_FILE");
  const auth = path.join(root, "playwright/.auth");
  const file = path.join(auth, `${portal}.json`);
  checkPrivatePath(auth, true);
  checkPrivatePath(file);
  const { entryUrl, cookies, origins } = JSON.parse(readFileSync(file, "utf8"));
  onStage("SAVED_ENTRY_URL");
  const entry = new URL(entryUrl);
  const validPath = portal === "skyward" ? /^\/lkwash(?:\/|$)/.test(entry.pathname) : ["/", "/dashboard"].includes(entry.pathname);
  if (entry.origin !== new URL(portalConfig.portals[portal].urls.login).origin || !validPath || entry.username || entry.password ||
      !Array.isArray(cookies) || !Array.isArray(origins)) throw new Error("Invalid saved application session.");
  return { entry, state: { cookies, origins } };
}

export async function withPortalCollection<Result>(portal: PortalId, operation: (page: Page, store: SqliteCanvasStore) => Promise<Result>,
  options: CollectionOptions = {}): Promise<{ result: Result; database: string }> {
  const root = options.root ?? ROOT;
  const onStage = options.onStage ?? (() => {});
  const session = readPortalSession(portal, root, onStage);
  return withWorkspaceStore(root, async store => {
    onStage("BROWSER_LAUNCH");
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    try {
      onStage("SESSION_RESUME");
      const context = await browser.newContext({ storageState: session.state, viewport: { width: 1440, height: 1000 },
        timezoneId: "America/Los_Angeles", acceptDownloads: false, serviceWorkers: "block" });
      await restrictPortalNavigation(context, session.entry.origin);
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(session.entry.href, { waitUntil: "domcontentloaded" });
      return { result: await operation(page, store), database: "data/database/schoolhawk.sqlite" };
    } finally { await browser.close(); }
  }, onStage);
}