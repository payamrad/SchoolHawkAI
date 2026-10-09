import type { Page } from "playwright";
import portalConfig from "../../../config/portals.json";
import { LoginDiagnostic, reportLoginFailure, runPortalLogin } from "./portal-session";
export { loginStep } from "./portal-session";

export const LOGIN_URL = portalConfig.portals.skyward.urls.login;
const loginUrl = new URL(LOGIN_URL);
const loginPath = loginUrl.pathname.replace(/\/+$/, "").toLowerCase();

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

export async function loginSkyward(): Promise<void> {
  await runPortalLogin({ id: "skyward", name: "Skyward", loginUrl: LOGIN_URL, submit: submitLogin, confirm: confirmLogin });
}

if (require.main === module) {
  loginSkyward().catch(reportLoginFailure);
}