import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canvasLogin } from "../src/canvas-login";
import { confirmLogin as confirmSkywardLogin, LOGIN_URL as SKYWARD_LOGIN_URL, submitLogin as submitSkywardLogin } from "../src/skyward-login";
import { prepareAuthDirectory, readLoginSettings, restrictPortalNavigation, saveVerifiedSession, type LoginPortal } from "../src/portal-session";
import { readSkywardSession, withSkywardCollection } from "../src/skyward";
import { readPortalSession } from "../src/portal-collection";
import type { SqliteMessageStore } from "@schoolhawk/storage/sqlite";
import { setupDatabase } from "../../../scripts/setup-database";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }); });
after(async () => { await browser?.close(); });
const skywardLogin: LoginPortal = { id: "skyward", name: "Skyward", loginUrl: SKYWARD_LOGIN_URL,
  submit: submitSkywardLogin, confirm: confirmSkywardLogin };
const canvasDashboard = '<section role="region" aria-label="Global Navigation"><button>Account</button></section><main><h1>Dashboard</h1></main>';

async function mockDashboard(context: BrowserContext, html: string): Promise<void> {
  await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
}

test("both portals save separate private session files only after fresh-context reuse", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-login-"));
  try {
    for (const portal of [skywardLogin, canvasLogin]) {
      const html = portal.id === "canvas" ? canvasDashboard : '<a href="/logout">Sign Out</a>';
      const entry = new URL(portal.id === "canvas" ? "/" : "/lkwash/Home", portal.loginUrl).href;
      const context = await browser.newContext();
      try {
        await mockDashboard(context, html);
        const page = await context.newPage();
        await page.goto(entry);
        await context.addCookies([{ name: "synthetic-session", value: "synthetic-token", url: entry }]);
        const verificationContexts: BrowserContext[] = [];
        const verificationBrowser = { async newContext(options: Parameters<Browser["newContext"]>[0]) {
          const verification = await browser.newContext(options);
          verificationContexts.push(verification);
          assert.notEqual(verification, context);
          assert.equal((await verification.cookies(entry))[0].value, "synthetic-token");
          await mockDashboard(verification, html);
          return verification;
        } };
        const otherFile = path.join(directory, portal.id === "canvas" ? "skyward.json" : "canvas.json");
        const otherContents = existsSync(otherFile) ? readFileSync(otherFile) : undefined;
        await saveVerifiedSession(verificationBrowser, context, page, portal, { directory, timeout: 500 });
        const file = path.join(directory, `${portal.id}.json`);
        const state = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(state.entryUrl, entry);
        assert.equal(state.cookies[0].value, "synthetic-token");
        assert.equal(statSync(directory).mode & 0o777, 0o700);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(verificationContexts.length, 1);
        assert.equal(browser.contexts().includes(verificationContexts[0]), false);
        assert.equal(JSON.stringify(state).includes("synthetic-password"), false);
        if (otherContents) assert.deepEqual(readFileSync(otherFile), otherContents);
      } finally { await context.close(); }
    }
    assert.deepEqual(readdirSync(directory).sort(), ["canvas.json", "skyward.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed reuse preserves the existing session and closes the verification context", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-failed-login-"));
  const file = path.join(directory, "canvas.json");
  const original = '{"saved":"synthetic-existing-session"}';
  writeFileSync(file, original, { mode: 0o600 });
  const context = await browser.newContext();
  const contextsBefore = browser.contexts().length;
  try {
    await mockDashboard(context, canvasDashboard);
    const page = await context.newPage();
    await page.goto(new URL("/", canvasLogin.loginUrl).href);
    const verificationBrowser = { async newContext(options: Parameters<Browser["newContext"]>[0]) {
      const verification = await browser.newContext(options);
      await mockDashboard(verification, '<main>Verification required</main><input type="password">');
      return verification;
    } };
    await assert.rejects(saveVerifiedSession(verificationBrowser, context, page, canvasLogin, { directory, timeout: 1_000 }), /SESSION_REUSE:/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(readdirSync(directory), ["canvas.json"]);
    assert.equal(browser.contexts().length, contextsBefore);
  } finally { await context.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("private session directories reject symbolic links and Skyward keeps its credential requirement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-auth-path-"));
  try {
    const realDirectory = path.join(root, "real");
    const link = path.join(root, "link");
    mkdirSync(realDirectory, { mode: 0o700 });
    symlinkSync(realDirectory, link);
    await assert.rejects(prepareAuthDirectory(link));
    assert.throws(() => readLoginSettings(skywardLogin, { SKYWARD_HEADED: "1" }), /Export SKYWARD_USERNAME and SKYWARD_PASSWORD/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portal guards reject unexpected navigation and credential posts", async () => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const intercepted: string[] = [];
  try {
    await context.route("**/*", route => {
      intercepted.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "Synthetic page" });
    });
    const origin = new URL(canvasLogin.loginUrl).origin;
    for (const invalid of ["http://sso.canvaslms.com", "https://sso.canvaslms.com/login", "https://sso.canvaslms.com?token=synthetic"]) {
      await assert.rejects(restrictPortalNavigation(context, origin, [invalid]), /exact HTTPS origins/);
    }
    await restrictPortalNavigation(context, origin);
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const posted = await page.evaluate(async () => {
      try { await fetch("https://unapproved.example/collect", { method: "POST", body: "synthetic-value" }); return true; }
      catch { return false; }
    });
    assert.equal(posted, false);
    await assert.rejects(page.goto("https://unapproved.example/"));
    assert.deepEqual(intercepted, [`${origin}/`]);
  } finally { await context.close(); }
});

test("Canvas permits its SSO handoff during login and reuse but only saves the district dashboard", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "schoolhawk-canvas-sso-"));
  const origin = new URL(canvasLogin.loginUrl).origin;
  const ssoOrigin = "https://sso.canvaslms.com";
  const destinations: string[] = [];
  const installRoutes = async (context: BrowserContext) => {
    let handoffStarted = false;
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      destinations.push(url.origin);
      if (url.origin === ssoOrigin) {
        return route.fulfill({ contentType: "text/html", body: url.pathname === "/fake-dashboard" ? canvasDashboard :
          `<script>location.assign(${JSON.stringify(`${origin}/?login_success=1`)})</script>` });
      }
      if (url.pathname === "/login/canvas" && request.method() === "GET") {
        return route.fulfill({ contentType: "text/html", body: '<form method="post" action="/login/canvas"><label>Login<input name="login"></label><label>Password *<input type="password" name="password"></label><button>Log In</button></form>' });
      }
      if (!handoffStarted) {
        handoffStarted = true;
        return route.fulfill({ contentType: "text/html", body: `<script>location.assign(${JSON.stringify(`${ssoOrigin}/synthetic-login`)})</script>` });
      }
      return route.fulfill({ contentType: "text/html", body: canvasDashboard });
    });
  };
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await installRoutes(context);
    await restrictPortalNavigation(context, origin, canvasLogin.authenticationOrigins);
    const page = await context.newPage();
    await page.goto(canvasLogin.loginUrl);
    await canvasLogin.submit(page, "synthetic-parent", "synthetic-password", undefined, 2_000);
    assert.equal(new URL(page.url()).origin, origin);
    const verificationBrowser = { async newContext(options: Parameters<Browser["newContext"]>[0]) {
      const verification = await browser.newContext(options);
      await installRoutes(verification);
      return verification;
    } };
    await saveVerifiedSession(verificationBrowser, context, page, canvasLogin, { directory, timeout: 2_000 });
    const file = path.join(directory, "canvas.json");
    const saved = readFileSync(file, "utf8");
    assert.equal(new URL(JSON.parse(saved).entryUrl).origin, origin);
    assert.equal(destinations.filter(destination => destination === ssoOrigin).length, 2);
    assert(destinations.every(destination => destination === origin || destination === ssoOrigin));
    await page.goto(`${ssoOrigin}/fake-dashboard`);
    await assert.rejects(canvasLogin.confirm(page, undefined, 500), /UNEXPECTED_ORIGIN/);
    await assert.rejects(saveVerifiedSession(verificationBrowser, context, page, canvasLogin, { directory, timeout: 500 }), /UNEXPECTED_ORIGIN/);
    assert.equal(readFileSync(file, "utf8"), saved);
    const allowedRequestCount = destinations.length;
    for (const forbidden of ["https://unapproved.example/", "https://sso.canvaslms.com.unapproved.example/", "https://other.canvaslms.com/"]) {
      const forbiddenPage = await context.newPage();
      try { await assert.rejects(forbiddenPage.goto(forbidden)); }
      finally { await forbiddenPage.close(); }
    }
    assert.equal(destinations.length, allowedRequestCount);
  } finally { await context.close(); rmSync(directory, { recursive: true, force: true }); }
  const collection = await browser.newContext();
  try {
    await collection.route("**/*", route => route.fulfill({ body: "Synthetic page" }));
    await restrictPortalNavigation(collection, origin);
    const page = await collection.newPage();
    await assert.rejects(page.goto(`${ssoOrigin}/synthetic-login`));
  } finally { await collection.close(); }
});

test("Skyward session loading rejects other portals, login paths, malformed state, and unsafe files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-session-load-"));
  try {
    const auth = path.join(root, "playwright/.auth");
    mkdirSync(auth, { recursive: true, mode: 0o700 });
    const file = path.join(auth, "skyward.json");
    const session = { entryUrl: "https://www.q.wa-k12.net/lkwash/Home?synthetic=1", cookies: [], origins: [] };
    writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
    const loaded = readSkywardSession(root);
    assert.equal(loaded.entry.href, session.entryUrl);
    assert.deepEqual(loaded.state, { cookies: [], origins: [] });
    for (const entryUrl of [canvasLogin.loginUrl, SKYWARD_LOGIN_URL, "https://www.q.wa-k12.net/lkwash-other/Home",
      "https://synthetic-user@www.q.wa-k12.net/lkwash/Home", "http://www.q.wa-k12.net/lkwash/Home"]) {
      writeFileSync(file, JSON.stringify({ ...session, entryUrl }));
      assert.throws(() => readSkywardSession(root));
    }
    writeFileSync(file, JSON.stringify({ ...session, cookies: null }));
    assert.throws(() => readSkywardSession(root));
    writeFileSync(file, JSON.stringify(session));
    chmodSync(file, 0o644);
    assert.throws(() => readSkywardSession(root), /private/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Canvas collection uses only its own protected dashboard session", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-canvas-session-"));
  try {
    const auth = path.join(root, "playwright/.auth");
    mkdirSync(auth, { recursive: true, mode: 0o700 });
    const file = path.join(auth, "canvas.json");
    writeFileSync(file, JSON.stringify({ entryUrl: "https://lwsd414.instructure.com/", cookies: [], origins: [] }), { mode: 0o600 });
    assert.equal(readPortalSession("canvas", root).entry.origin, "https://lwsd414.instructure.com");
    assert.throws(() => readSkywardSession(root));
    for (const entryUrl of ["https://www.q.wa-k12.net/lkwash/Home", "https://lwsd414.instructure.com/login/canvas", "https://lwsd414.instructure.com/api/v1/courses"]) {
      writeFileSync(file, JSON.stringify({ entryUrl, cookies: [], origins: [] }));
      assert.throws(() => readPortalSession("canvas", root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared Skyward runtime checks storage before launch and cleans up on success and failure", async testContext => {
  const root = mkdtempSync(path.join(tmpdir(), "schoolhawk-runtime-"));
  const launch = chromium.launch.bind(chromium);
  const launched: Browser[] = [];
  const stores: SqliteMessageStore[] = [];
  testContext.mock.method(chromium, "launch", async (options: Parameters<typeof chromium.launch>[0]) => {
    assert.equal(options?.chromiumSandbox, true);
    const instance = await launch(options);
    launched.push(instance);
    const newContext = instance.newContext.bind(instance);
    testContext.mock.method(instance, "newContext", async (settings: Parameters<Browser["newContext"]>[0]) => {
      assert.equal(settings?.acceptDownloads, false);
      assert.equal(settings?.serviceWorkers, "block");
      const context = await newContext(settings);
      await mockDashboard(context, '<a href="/logout">Sign Out</a>');
      return context;
    });
    return instance;
  });
  try {
    const auth = path.join(root, "playwright/.auth");
    mkdirSync(auth, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(auth, "skyward.json"), JSON.stringify({
      entryUrl: "https://www.q.wa-k12.net/lkwash/Home", cookies: [], origins: [],
    }), { mode: 0o600 });
    await assert.rejects(withSkywardCollection(async () => assert.fail("Missing storage must not launch collection"), { root }));
    assert.equal(launched.length, 0);
    setupDatabase(root);
    const result = await withSkywardCollection(async (page, store) => {
      stores.push(store);
      assert.deepEqual(page.viewportSize(), { width: 1440, height: 1000 });
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "America/Los_Angeles");
      assert.deepEqual(store.listRuns("parent"), []);
      return "collected";
    }, { root });
    assert.deepEqual(result, { result: "collected", database: "data/database/schoolhawk.sqlite" });
    await assert.rejects(withSkywardCollection(async (_page, store) => {
      stores.push(store);
      throw new Error("Synthetic collection failure");
    }, { root }), /Synthetic collection failure/);
    assert.equal(launched.length, 2);
    assert(launched.every(instance => !instance.isConnected()));
    for (const store of stores) assert.throws(() => store.listRuns("parent"));
  } finally {
    for (const instance of launched) if (instance.isConnected()) await instance.close();
    rmSync(root, { recursive: true, force: true });
  }
});