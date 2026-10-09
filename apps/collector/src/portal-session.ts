import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const AUTH_DIRECTORY = path.resolve(__dirname, "../../../playwright/.auth");
export type PortalId = "skyward" | "canvas";

export class LoginDiagnostic extends Error {}

export async function loginStep<Result>(diagnostic: string, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LoginDiagnostic) throw error;
    throw new LoginDiagnostic(diagnostic);
  }
}

export interface LoginPortal {
  id: PortalId;
  name: string;
  loginUrl: string;
  authenticationOrigins?: readonly string[];
  manualWhenHeaded?: boolean;
  headedTimeout?: number;
  submit(page: Page, username: string, password: string, successSelector?: string, timeout?: number): Promise<void>;
  confirm(page: Page, successSelector?: string, timeout?: number): Promise<void>;
}

export function readLoginSettings(portal: LoginPortal, environment = process.env) {
  const prefix = portal.id.toUpperCase();
  const username = environment[`${prefix}_USERNAME`];
  const password = environment[`${prefix}_PASSWORD`];
  delete environment[`${prefix}_USERNAME`];
  delete environment[`${prefix}_PASSWORD`];
  const headed = environment[`${prefix}_HEADED`] === "1";
  const manual = !!portal.manualWhenHeaded && headed && !username && !password;
  if (!manual && (!username || !password)) {
    throw new LoginDiagnostic(`CONFIGURATION: Export ${prefix}_USERNAME and ${prefix}_PASSWORD in the same terminal before running.`);
  }
  return { username, password, headed, manual, successSelector: environment[`${prefix}_SUCCESS_SELECTOR`],
    timeout: headed ? portal.headedTimeout ?? 30_000 : 30_000 };
}

export async function restrictPortalNavigation(context: BrowserContext, origin: string, authenticationOrigins: readonly string[] = []): Promise<void> {
  const allowedOrigins = new Set([origin]);
  for (const allowed of authenticationOrigins) {
    const url = new URL(allowed);
    if (url.protocol !== "https:" || url.origin !== allowed) throw new Error("Authentication destinations must be exact HTTPS origins.");
    allowedOrigins.add(allowed);
  }
  await context.route("**/*", route => {
    const request = route.request();
    if (!allowedOrigins.has(new URL(request.url()).origin) &&
        (request.isNavigationRequest() || !["GET", "HEAD"].includes(request.method()))) return route.abort();
    return route.fallback();
  });
}

export async function prepareAuthDirectory(directory = AUTH_DIRECTORY): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error("Authentication directory must be owned by the current user.");
  }
  await chmod(directory, 0o700);
}

export async function saveVerifiedSession(browser: Pick<Browser, "newContext">, context: BrowserContext, page: Page, portal: LoginPortal,
  options: { directory?: string; successSelector?: string; timeout?: number } = {}): Promise<void> {
  const directory = options.directory ?? AUTH_DIRECTORY;
  await portal.confirm(page, options.successSelector, options.timeout);
  const entryUrl = page.url();
  const entry = new URL(entryUrl);
  if (entry.origin !== new URL(portal.loginUrl).origin || entry.username || entry.password) {
    throw new LoginDiagnostic("SESSION_REUSE: The authenticated destination is not permitted.");
  }
  const state = await context.storageState({ indexedDB: true });
  const verificationContext = await browser.newContext({ storageState: state, acceptDownloads: false, serviceWorkers: "block" });
  try {
    await restrictPortalNavigation(verificationContext, entry.origin, portal.authenticationOrigins);
    const verificationPage = await verificationContext.newPage();
    await loginStep("SESSION_REUSE: Initial login was verified, but a fresh browser context could not verify the saved session.", async () => {
      await verificationPage.goto(entryUrl, { waitUntil: "domcontentloaded" });
      try { await portal.confirm(verificationPage, options.successSelector, options.timeout); }
      catch { throw new Error(); }
    });
  } finally { await verificationContext.close(); }
  await prepareAuthDirectory(directory);
  const temporaryPath = path.join(directory, `.${portal.id}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ ...state, entryUrl }), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporaryPath, path.join(directory, `${portal.id}.json`));
  } finally { await rm(temporaryPath, { force: true }); }
}

export async function runPortalLogin(portal: LoginPortal): Promise<void> {
  process.umask(0o077);
  const settings = readLoginSettings(portal);
  await loginStep("STORAGE: Cannot prepare the private authentication directory. Check ownership and permissions.", () => prepareAuthDirectory());
  const browser = await loginStep("BROWSER: Chromium could not launch. Check its installation and, for headed mode, desktop availability.", () => chromium.launch({
    headless: !settings.headed, chromiumSandbox: true,
  }));
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    await restrictPortalNavigation(context, new URL(portal.loginUrl).origin, portal.authenticationOrigins);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await loginStep("NAVIGATION: The public login page could not load. Check connectivity and portal availability.",
      () => page.goto(portal.loginUrl, { waitUntil: "domcontentloaded" }));
    if (new URL(page.url()).origin !== new URL(portal.loginUrl).origin) {
      throw new LoginDiagnostic("NAVIGATION: Unexpected login destination; credentials were not submitted.");
    }
    if (settings.manual) {
      console.log(`Complete ${portal.name} login in the browser within ${settings.timeout / 1000} seconds, including any required verification.`);
      await portal.confirm(page, settings.successSelector, settings.timeout);
    } else {
      await loginStep("FORM: Could not fill or submit the expected login controls. The form may have changed.",
        () => portal.submit(page, settings.username!, settings.password!, settings.successSelector, settings.timeout));
    }
    await saveVerifiedSession(browser, context, page, portal, { successSelector: settings.successSelector, timeout: settings.timeout });
    console.log(`${portal.name} login and session reuse verified. Protected session saved.`);
  } finally { await browser.close(); }
}

export function reportLoginFailure(error: unknown): void {
  console.error(error instanceof LoginDiagnostic ? error.message :
    "INTERNAL: Login or session persistence failed. Raw error details were withheld to protect account data.");
  console.error("Run did not complete successfully; any existing session file may be stale.");
  process.exitCode = 1;
}