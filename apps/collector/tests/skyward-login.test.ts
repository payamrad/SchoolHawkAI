import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { confirmLogin, loginStep, LOGIN_URL, submitLogin } from "../src/skyward-login";
import portalConfig from "../../../config/portals.json";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
});
after(async () => { await browser?.close(); });

test("submits the form and verifies an authenticated page", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", async (route) => {
      const dashboard = new URL(route.request().url()).pathname === "/family";
      await route.fulfill({ contentType: "text/html", body: dashboard
        ? '<a href="/logout">Sign Out</a>'
        : '<form action="/family"><label>Username<input name="username"></label>' +
          '<label>Password<input type="password" name="password"></label>' +
          '<button>Sign In</button></form>' });
    });
    await page.goto(LOGIN_URL);
    await submitLogin(page, "synthetic-parent", "synthetic-password", undefined, 1000);
    assert.equal(new URL(page.url()).pathname, "/family");
  } finally { await page.close(); }
});

test("rejects a login form even if a sign-out marker is present", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<button>Sign Out</button><input type="password">',
    }));
    await page.goto(LOGIN_URL);
    await assert.rejects(confirmLogin(page, undefined, 300), /CONFIRMATION: Marker found/);
  } finally { await page.close(); }
});

test("rejects redirects without authenticated evidence", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<h1>Verification required</h1>',
    }));
    await page.goto("https://www.q.wa-k12.net/family");
    await assert.rejects(confirmLogin(page, undefined, 300), /CONFIRMATION: No visible authenticated-page marker/);
  } finally { await page.close(); }
});

test("reports a remaining password form without exposing its contents", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<input type="password" value="synthetic-secret">',
    }));
    await page.goto(LOGIN_URL);
    await assert.rejects(confirmLogin(page, undefined, 300), /CONFIRMATION: A password form is still visible/);
  } finally { await page.close(); }
});

test("uses configured inbox and rejects configured login-service subpages", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<button>Sign Out</button>',
    }));
    await page.goto(portalConfig.portals.skyward.urls.messages.inbox);
    await confirmLogin(page, undefined, 300);
    await page.goto(`${LOGIN_URL}/Account/Challenge`);
    await assert.rejects(confirmLogin(page, undefined, 300), /CONFIRMATION: Marker found/);
  } finally { await page.close(); }
});

test("replaces raw operation errors with a safe step diagnostic", async () => {
  await assert.rejects(loginStep("FORM: Failed.", async () => {
    throw new Error("synthetic-secret https://example.test/?token=private");
  }), (error: Error) => {
    assert.equal(error.message, "FORM: Failed.");
    assert.equal(error.cause, undefined);
    return true;
  });
});