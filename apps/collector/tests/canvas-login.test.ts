import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { canvasLogin, confirmLogin, LOGIN_URL, submitLogin } from "../src/canvas-login";
import { readLoginSettings, restrictPortalNavigation } from "../src/portal-session";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });

const dashboard = '<section role="region" aria-label="Global Navigation"><button>Account</button><a href="/">Dashboard</a></section><main><h1>Dashboard</h1></main>';
const form = '<form method="post" action="/login/canvas"><label>Login<input name="pseudonym_session[unique_id]"></label>' +
  '<label>Password<input type="password" name="pseudonym_session[password]"></label><label><input type="checkbox" name="remember_me">Remember me</label><button>Log In</button></form>';

test("Canvas submits one login attempt without changing Remember me and verifies the dashboard", async () => {
  const page = await browser.newPage();
  let submissions = 0;
  try {
    await page.route("**/*", async route => {
      const request = route.request();
      if (request.method() === "POST") {
        submissions++;
        const body = new URLSearchParams(request.postData()!);
        assert.equal(body.get("pseudonym_session[unique_id]"), "synthetic-parent");
        assert.equal(body.get("pseudonym_session[password]"), "synthetic-password");
        assert.equal(body.has("remember_me"), false);
        return route.fulfill({ contentType: "text/html", body: dashboard + '<script>history.replaceState(null, "", "/?login_success=1")</script>' });
      }
      await route.fulfill({ contentType: "text/html", body: new URL(request.url()).pathname === "/" ? dashboard : form });
    });
    await page.goto(LOGIN_URL);
    await submitLogin(page, "synthetic-parent", "synthetic-password", undefined, 500);
    assert.equal(submissions, 1);
    assert.equal(new URL(page.url()).pathname, "/");
  } finally { await page.close(); }
});

test("Canvas accepts required-field markers in the password label", async () => {
  const page = await browser.newPage();
  let submissions = 0;
  try {
    await page.route("**/*", route => {
      if (route.request().method() === "POST") {
        submissions++;
        const body = new URLSearchParams(route.request().postData()!);
        assert.equal(body.get("pseudonym_session[password]"), "synthetic-password");
        return route.fulfill({ contentType: "text/html", body: dashboard + '<script>history.replaceState(null, "", "/")</script>' });
      }
      return route.fulfill({ contentType: "text/html", body: form.replace("<label>Password", "<label>Password <span>*</span>") });
    });
    await page.goto(LOGIN_URL);
    page.setDefaultTimeout(500);
    assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    await submitLogin(page, "synthetic-parent", "synthetic-password", undefined, 1_000);
    assert.equal(submissions, 1);
  } finally { await page.close(); }
});

test("Canvas does not accept login, challenge, public, or foreign pages as authenticated", async () => {
  const page = await browser.newPage();
  try {
    for (const sample of [
      { url: LOGIN_URL, html: dashboard },
      { url: new URL("/login/mfa", LOGIN_URL).href, html: dashboard },
      { url: new URL("/", LOGIN_URL).href, html: dashboard + '<input type="password">' },
      { url: new URL("/", LOGIN_URL).href, html: dashboard + '<input autocomplete="one-time-code">' },
      { url: new URL("/", LOGIN_URL).href, html: '<main><h1>Dashboard</h1></main>' },
      { url: "https://unapproved.example/", html: dashboard },
    ]) {
      await page.unroute("**/*");
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: sample.html }));
      await page.goto(sample.url);
      await assert.rejects(confirmLogin(page, undefined, 100), /CONFIRMATION:/);
    }
  } finally { await page.close(); }
});

test("Canvas confirmation reports safe diagnostics for login, challenge, and layout failures", async () => {
  const page = await browser.newPage();
  try {
    for (const sample of [
      { url: LOGIN_URL, html: form, code: "LOGIN_FORM_PRESENT" },
      { url: LOGIN_URL, html: form + '<div role="alert">Incorrect username or password: synthetic-private-user</div>', code: "LOGIN_REJECTED" },
      { url: new URL("/login/mfa", LOGIN_URL).href, html: '<input autocomplete="one-time-code">', code: "CHALLENGE_PRESENT" },
      { url: new URL("/", LOGIN_URL).href, html: '<section role="region" aria-label="Global Navigation"><button>Account</button></section>', code: "DASHBOARD_MARKER_MISSING" },
      { url: new URL("/", LOGIN_URL).href, html: '<main><h1>Dashboard</h1></main>', code: "ACCOUNT_MARKER_MISSING" },
      { url: "https://unapproved.example/?token=synthetic-private-token", html: dashboard, code: "UNEXPECTED_ORIGIN" },
    ]) {
      await page.unroute("**/*");
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: sample.html }));
      await page.goto(sample.url);
      await assert.rejects(confirmLogin(page, undefined, 100), (error: Error) => {
        assert.match(error.message, new RegExp(`CONFIRMATION: ${sample.code}`));
        assert.doesNotMatch(error.message, /synthetic-private|https:\/\//);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  } finally { await page.close(); }
});

test("Canvas refuses wrong-origin pages or form destinations before filling credentials", async () => {
  const page = await browser.newPage();
  try {
    for (const sample of [
      { url: "https://unapproved.example/login/canvas", html: form },
      { url: LOGIN_URL, html: form.replace('action="/login/canvas"', 'action="https://unapproved.example/login"') },
      { url: LOGIN_URL, html: form.replace('<button>', '<button formaction="https://unapproved.example/login">') },
    ]) {
      await page.unroute("**/*");
      await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: sample.html }));
      await page.goto(sample.url);
      await assert.rejects(submitLogin(page, "synthetic-parent", "synthetic-password", undefined, 100), /credentials were not submitted/);
      assert.equal(await page.getByRole("textbox", { name: "Login", exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
    }
  } finally { await page.close(); }
});

test("Canvas login diagnostics distinguish blocked navigation without leaking credentials or redirect queries", async testContext => {
  const context = await browser.newContext();
  const forwarded: string[] = [];
  try {
    await context.route("**/*", route => {
      forwarded.push(new URL(route.request().url()).hostname);
      if (route.request().method() === "POST") {
        return route.fulfill({ contentType: "text/html", body: '<script>location.assign("https://unapproved.example/?token=synthetic-private-token")</script>' });
      }
      return route.fulfill({ contentType: "text/html", body: form });
    });
    await restrictPortalNavigation(context, new URL(LOGIN_URL).origin);
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    const removedListeners = testContext.mock.method(page, "off");
    await assert.rejects(submitLogin(page, "synthetic-private-user", "synthetic-private-password", undefined, 500), (error: Error) => {
      assert.match(error.message, /CONFIRMATION: NAVIGATION_FAILED/);
      assert.match(error.message, /CANVAS_CONNECTION:/);
      assert.match(error.message, /"destinationHost":"unapproved.example"/);
      assert.match(error.message, /"loginRequests":1/);
      assert.match(error.message, /"loginStatus":200/);
      assert.doesNotMatch(error.message, /synthetic-private|https:\/\/|token=/);
      return true;
    });
    for (const event of ["request", "response", "requestfailed"]) {
      assert(removedListeners.mock.calls.some(call => call.arguments[0] === event));
    }
    assert(forwarded.every(host => host === new URL(LOGIN_URL).hostname));
  } finally { await context.close(); }
});

test("Canvas supports bounded manual headed login and consumes only its own credential variables", () => {
  const environment = { CANVAS_USERNAME: "synthetic-parent", CANVAS_PASSWORD: "synthetic-password", SKYWARD_USERNAME: "other-parent" };
  const settings = readLoginSettings(canvasLogin, environment);
  assert.equal(settings.username, "synthetic-parent");
  assert.equal(settings.password, "synthetic-password");
  assert.equal(settings.manual, false);
  assert.equal(settings.timeout, 30_000);
  assert.equal(environment.CANVAS_USERNAME, undefined);
  assert.equal(environment.CANVAS_PASSWORD, undefined);
  assert.equal(environment.SKYWARD_USERNAME, "other-parent");
  const manual = readLoginSettings(canvasLogin, { CANVAS_HEADED: "1" });
  assert.equal(manual.manual, true);
  assert.equal(manual.timeout, 120_000);
  assert.throws(() => readLoginSettings(canvasLogin, { CANVAS_HEADED: "1", CANVAS_USERNAME: "synthetic-parent" }), /CONFIGURATION:/);
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/canvas-login.ts")], {
    encoding: "utf8", env: { ...process.env, CANVAS_USERNAME: "", CANVAS_PASSWORD: "", CANVAS_HEADED: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Export CANVAS_USERNAME and CANVAS_PASSWORD/);
  assert.doesNotMatch(result.stderr, /synthetic-password|\bat /);
});