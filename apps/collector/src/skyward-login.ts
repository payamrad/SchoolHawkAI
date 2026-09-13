import { chromium, type Page } from "playwright";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import portalConfig from "../../../config/portals.json";

export const LOGIN_URL = portalConfig.portals.skyward.urls.login;
const loginUrl = new URL(LOGIN_URL);
const loginPath = loginUrl.pathname.replace(/\/+$/, "").toLowerCase();
const AUTH_DIRECTORY = path.resolve(__dirname, "../../../playwright/.auth");

class LoginDiagnostic extends Error {}

export async function loginStep<Result>(
  diagnostic: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LoginDiagnostic) throw error;
    throw new LoginDiagnostic(diagnostic);
  }
}

export async function confirmLogin(
  page: Page,
  successSelector?: string,
  timeout = 30_000,
): Promise<void> {
  const marker = successSelector
    ? page.locator(successSelector)
    : page.getByRole("link", { name: /^(sign out|log out|logout)$/i }).or(
        page.getByRole("button", { name: /^(sign out|log out|logout)$/i }),
      );
  try {
    await marker.first().waitFor({ state: "visible", timeout });
  } catch {
    if (page.isClosed()) {
      throw new LoginDiagnostic("CONFIRMATION: Browser page closed before login could be verified.");
    }
    if (await page.locator('input[type="password"]:visible').count()) {
      throw new LoginDiagnostic(
        "CONFIRMATION: A password form is still visible. Login may have been rejected or an additional authentication step may be required.",
      );
    }
    throw new LoginDiagnostic(
      "CONFIRMATION: No visible authenticated-page marker was found. The dashboard selector may need adjustment, or an authentication challenge may remain.",
    );
  }
  const currentUrl = new URL(page.url());
  if (
    currentUrl.origin !== loginUrl.origin ||
    currentUrl.pathname.toLowerCase() === loginPath ||
    currentUrl.pathname.toLowerCase().startsWith(`${loginPath}/`) ||
    await page.locator('input[type="password"]:visible').count()
  ) {
    throw new LoginDiagnostic("CONFIRMATION: Marker found, but the page is still in the login service, has a password form, or is on an unexpected origin.");
  }
}

export async function submitLogin(
  page: Page,
  username: string,
  password: string,
  successSelector?: string,
  timeout = 30_000,
): Promise<void> {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await confirmLogin(page, successSelector, timeout);
}

async function prepareAuthDirectory(): Promise<void> {
  await mkdir(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = await lstat(AUTH_DIRECTORY);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.()) {
    throw new Error("Authentication directory must be owned by the current user.");
  }
  await chmod(AUTH_DIRECTORY, 0o700);
}

async function main(): Promise<void> {
  process.umask(0o077);
  const username = process.env.SKYWARD_USERNAME;
  const password = process.env.SKYWARD_PASSWORD;
  delete process.env.SKYWARD_USERNAME;
  delete process.env.SKYWARD_PASSWORD;
  if (!username || !password) {
    throw new LoginDiagnostic("CONFIGURATION: Export SKYWARD_USERNAME and SKYWARD_PASSWORD in the same terminal before running.");
  }
  await loginStep("STORAGE: Cannot prepare the private authentication directory. Check ownership and permissions.", prepareAuthDirectory);
  const browser = await loginStep("BROWSER: Chromium could not launch. Check its installation and, for headed mode, desktop availability.", () => chromium.launch({
    headless: process.env.SKYWARD_HEADED !== "1",
    chromiumSandbox: true,
  }));
  try {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await loginStep("NAVIGATION: The public login page could not load. Check connectivity and portal availability.",
      () => page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }));
    if (new URL(page.url()).origin !== loginUrl.origin) {
      throw new LoginDiagnostic("NAVIGATION: Unexpected login destination; credentials were not submitted.");
    }
    await loginStep("FORM: Could not fill or submit the expected login controls. The form may have changed.",
      () => submitLogin(page, username, password, process.env.SKYWARD_SUCCESS_SELECTOR));
    const state = await context.storageState({ indexedDB: true });
    const verificationContext = await browser.newContext({ storageState: state });
    try {
      const verificationPage = await verificationContext.newPage();
      try {
        await verificationPage.goto(page.url(), { waitUntil: "domcontentloaded" });
        await confirmLogin(verificationPage, process.env.SKYWARD_SUCCESS_SELECTOR);
      } catch {
        throw new LoginDiagnostic("SESSION_REUSE: Initial login was verified, but a fresh browser context could not verify the saved session.");
      }
    } finally {
      await verificationContext.close();
    }
    const temporaryPath = path.join(AUTH_DIRECTORY, `.skyward-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ ...state, entryUrl: page.url() }), "utf8");
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path.join(AUTH_DIRECTORY, "skyward.json"));
    } finally {
      await rm(temporaryPath, { force: true });
    }
    console.log("Skyward login and session reuse verified. Protected session saved.");
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof LoginDiagnostic ? error.message :
        "INTERNAL: Login or session persistence failed. Raw error details were withheld to protect account data.",
    );
    console.error("Run did not complete successfully; any existing session file may be stale.");
    process.exitCode = 1;
  });
}