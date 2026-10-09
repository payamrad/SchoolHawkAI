import type { Page, Request, Response } from "playwright";
import portalConfig from "../../../config/portals.json";
import { LoginDiagnostic, reportLoginFailure, runPortalLogin, type LoginPortal } from "./portal-session";

export const LOGIN_URL = portalConfig.portals.canvas.urls.login;
const loginUrl = new URL(LOGIN_URL);

function dashboardMarkers(page: Page) {
  const navigation = page.getByRole("region", { name: "Global Navigation", exact: true });
  const account = navigation.getByRole("button", { name: "Account", exact: true })
    .or(navigation.getByRole("link", { name: "Account", exact: true }));
  const dashboard = page.getByRole("main").getByRole("heading", { name: "Dashboard", exact: true });
  return { account, dashboard };
}

async function confirmationFailure(page: Page, customSelector = false): Promise<LoginDiagnostic> {
  if (page.isClosed()) return new LoginDiagnostic("CONFIRMATION: PAGE_CLOSED. Canvas closed before login could be verified.");
  try {
    const current = new URL(page.url());
    if (!["https:", "http:"].includes(current.protocol)) {
      return new LoginDiagnostic("CONFIRMATION: NAVIGATION_FAILED. The browser did not reach a web page after login. Check the accompanying connection diagnostic; session was not saved.");
    }
    if (current.origin !== loginUrl.origin || current.username || current.password) {
      return new LoginDiagnostic("CONFIRMATION: UNEXPECTED_ORIGIN. Canvas left the approved login origin. Session was not saved.");
    }
    const challenge = page.locator('input[autocomplete="one-time-code"]:visible, input[name="otp"]:visible, iframe[title*="challenge" i]:visible, iframe[title*="recaptcha" i]:visible, iframe[src*="hcaptcha"]:visible');
    if (/^\/login\/(?:mfa|otp|captcha)(?:\/|$)/i.test(current.pathname) || await challenge.count()) {
      return new LoginDiagnostic("CONFIRMATION: CHALLENGE_PRESENT. Canvas requires manual verification. Use CANVAS_HEADED=1 to complete it; no bypass or automatic retry was attempted.");
    }
    if (await page.locator('input[type="password"]:visible').count()) {
      const rejection = page.locator('[role="alert"]:visible, #flash_error_message:visible, .ic-flash-error:visible, #login_error:visible')
        .filter({ hasText: /(?:invalid|incorrect)\s+(?:username|user name|login|email|password)|(?:username|password)\s+(?:is|was)\s+incorrect/i });
      if (await rejection.count()) {
        return new LoginDiagnostic("CONFIRMATION: LOGIN_REJECTED. Canvas displayed an invalid-login error. Check the Canvas login identifier and password in your own terminal. No retry was attempted.");
      }
      return new LoginDiagnostic("CONFIRMATION: LOGIN_FORM_PRESENT. Canvas still shows the password form after submission. No authenticated dashboard was reached; this alone does not identify a credential or challenge error.");
    }
    if (/^\/(?:login|logout)(?:\/|$)/i.test(current.pathname)) {
      return new LoginDiagnostic("CONFIRMATION: AUTH_PAGE_PRESENT. Canvas is still in its authentication service. Session was not saved.");
    }
    const { account, dashboard } = dashboardMarkers(page);
    if (!await account.first().isVisible()) {
      return new LoginDiagnostic("CONFIRMATION: ACCOUNT_MARKER_MISSING. The expected Canvas Account control is not visible. The page may be incomplete or have a different layout; session was not saved.");
    }
    if (!await dashboard.first().isVisible()) {
      return new LoginDiagnostic("CONFIRMATION: DASHBOARD_MARKER_MISSING. The Canvas Account control is visible but the Dashboard heading is not. The landing page or layout needs verification; session was not saved.");
    }
    return new LoginDiagnostic(customSelector
      ? "CONFIRMATION: CUSTOM_MARKER_MISSING. CANVAS_SUCCESS_SELECTOR did not match a visible element. Check or unset it before retrying."
      : "CONFIRMATION: DASHBOARD_UNVERIFIED. The Canvas page did not become verifiable within the confirmation timeout. Session was not saved.");
  } catch {
    return new LoginDiagnostic("CONFIRMATION: PAGE_UNAVAILABLE. Canvas could not be inspected after the confirmation timeout. Private details withheld.");
  }
}

export async function confirmLogin(page: Page, successSelector?: string, timeout = 30_000): Promise<void> {
  const { account, dashboard } = dashboardMarkers(page);
  const markers = successSelector ? [page.locator(successSelector)] : [
    account, dashboard,
  ];
  try {
    await Promise.all(markers.map(marker => marker.first().waitFor({ state: "visible", timeout })));
  } catch {
    throw await confirmationFailure(page, !!successSelector);
  }
  const current = new URL(page.url());
  if (current.origin !== loginUrl.origin || current.username || current.password || /^\/(?:login|logout)(?:\/|$)/i.test(current.pathname) ||
      await page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count()) {
    throw await confirmationFailure(page, !!successSelector);
  }
}

export async function submitLogin(page: Page, username: string, password: string, successSelector?: string, timeout = 30_000): Promise<void> {
  const current = new URL(page.url());
  if (current.origin !== loginUrl.origin || current.pathname.replace(/\/+$/, "") !== loginUrl.pathname || current.username || current.password) {
    throw new LoginDiagnostic("NAVIGATION: Unexpected Canvas login destination; credentials were not submitted.");
  }
  const button = page.getByRole("button", { name: "Log In", exact: true });
  const action = await button.evaluate(element => {
    const button = element as HTMLButtonElement;
    return button.hasAttribute("formaction") ? button.formAction : button.form?.action ?? null;
  });
  if (action) {
    const destination = new URL(action);
    if (destination.origin !== loginUrl.origin || destination.pathname !== loginUrl.pathname || destination.username || destination.password) {
      throw new LoginDiagnostic("FORM: Unexpected Canvas form destination; credentials were not submitted.");
    }
  }
  const diagnostics: { loginRequests: number; loginStatus?: number; navigationStatus?: number; destinationHost?: string; connectionFailure?: string } = { loginRequests: 0 };
  const isLogin = (request: Request) => {
    const url = new URL(request.url());
    return url.origin === loginUrl.origin && url.pathname === loginUrl.pathname && request.method() === "POST";
  };
  const onRequest = (request: Request) => {
    if (isLogin(request)) diagnostics.loginRequests++;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      diagnostics.destinationHost = new URL(request.url()).hostname;
    }
  };
  const onResponse = (response: Response) => {
    if (isLogin(response.request())) diagnostics.loginStatus = response.status();
    if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) diagnostics.navigationStatus = response.status();
  };
  const onRequestFailed = (request: Request) => {
    if (isLogin(request) || (request.isNavigationRequest() && request.frame() === page.mainFrame())) {
      const failure = request.failure()?.errorText;
      diagnostics.connectionFailure = failure && /^net::ERR_[A-Z_]+$/.test(failure) ? failure : "REQUEST_FAILED";
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  try {
    await page.getByRole("textbox", { name: "Login", exact: true }).fill(username);
    await page.getByLabel(/^Password\s*\*?$/i).and(page.locator('input[type="password"]')).fill(password);
    await button.click();
    await confirmLogin(page, successSelector, timeout);
  } catch (error) {
    const diagnostic = error instanceof LoginDiagnostic ? error : await confirmationFailure(page, !!successSelector);
    throw new LoginDiagnostic(`${diagnostic.message}\nCANVAS_CONNECTION: ${JSON.stringify(diagnostics)}`);
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
}

export const canvasLogin: LoginPortal = {
  id: "canvas", name: "Canvas", loginUrl: LOGIN_URL, submit: submitLogin, confirm: confirmLogin,
  authenticationOrigins: portalConfig.portals.canvas.authenticationOrigins,
  manualWhenHeaded: true, headedTimeout: 120_000,
};

export async function loginCanvas(): Promise<void> {
  await runPortalLogin(canvasLogin);
}

if (require.main === module) {
  loginCanvas().catch(reportLoginFailure);
}