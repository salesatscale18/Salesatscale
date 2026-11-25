/**
 * The lead form snippet (public/lp/v1.js) on a seller's page served from another
 * origin than our app. Runs against two small local servers started here, not the
 * Next app (that needs a database): an "app" stub serving the real v1.js, a config
 * built from the real buyer strings (lib/lead-pages/form-text.ts, the same function
 * the config endpoint uses), a submit that answers like ours, and a hand-over page;
 * and a "seller" host page (tests/fixtures/lead-page-host.html) with a serif font and
 * hostile global CSS. The endpoints' own logic (CORS, origins, drafts, preview) is
 * covered on PGlite in tests/integration/lead-pages-snippet.test.ts.
 *
 * Checks: the form takes the page's font, the page's CSS does not leak in, a submit
 * tells the page's own pixel and moves the top page to the hand-over, a placeholder
 * added later still gets the form, and "denied" from the cookie banner sends no counts.
 * Set LP_SHOTS_DIR to also save screenshots (English and Hebrew).
 */
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { translator } from "../../lib/i18n";
import { aboutLine, leadFormText } from "../../lib/lead-pages/form-text";
import { leadPageConsentLine } from "../../lib/leads/consent-line";

const ROOT = join(__dirname, "..", "..");
const KEY_EN = "abcABC123456";
const KEY_HE = "hebHEB123456";
const HANDOVER = "/h/AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

type Hit = { path: string; origin: string | undefined; body: string };
let app: Server, host: Server;
let appUrl = "", hostUrl = "";
const hits: Hit[] = [];

const configFor = (key: string) => {
  const lang = key === KEY_HE ? "he" : "en";
  const tr = translator(lang);
  return {
    v: 1, lang, dir: lang === "he" ? "rtl" : "ltr", preview: false,
    text: leadFormText(tr),
    about: aboutLine(tr, { en: "Fridge monitoring", he: "ניטור מקררים" }, lang),
    fields: { company: true, email: false, sites: false },
    consent: { line: leadPageConsentLine(lang, lang === "he" ? "פולאר דמו" : "Polar Demo", lang === "he" ? "מאיה" : "Maya"), ticked: lang === "he" },
    privacyUrl: `${appUrl}/p/${key}/privacy`,
    brand: { "--brand": "#0f6b5a", "--brand-on": "#ffffff", "--brand-text": "#0f6b5a" },
    ft: "abc.AAAAAAAAAAAAAAAAAAAAAA",
    tracking: { tellPagePixel: true, carryAdDetails: true },
  };
};

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
}

async function appHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", appUrl);
  const body = await read(req);
  hits.push({ path: url.pathname, origin: req.headers.origin, body });
  // Like ours: the host page's origin only, echoed, never credentials.
  const cors = req.headers.origin === hostUrl ? { "Access-Control-Allow-Origin": hostUrl, Vary: "Origin" } : {};
  if (url.pathname === "/lp/v1.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(readFileSync(join(ROOT, "public/lp/v1.js")));
    return;
  }
  const m = /^\/api\/lp\/([0-9A-Za-z]{12})\/(config|submit|e)$/.exec(url.pathname);
  if (m && req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
  if (m?.[2] === "config") { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(configFor(m[1]))); return; }
  if (m?.[2] === "e") { res.writeHead(204, cors); res.end(); return; }
  if (m?.[2] === "submit") {
    const data = JSON.parse(body || "{}");
    if (String(data.name ?? "").trim().length < 2) { res.writeHead(422, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid", fields: ["name"] })); return; }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ handover: HANDOVER, eventId: "11111111-2222-3333-4444-555555555555" }));
    return;
  }
  if (url.pathname === HANDOVER) { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Hand-over</title><h1>Thanks</h1>"); return; }
  res.writeHead(404); res.end();
}

const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

test.beforeAll(async () => {
  app = createServer((req, res) => void appHandler(req, res));
  host = createServer((req, res) => {
    const url = new URL(req.url ?? "/", hostUrl);
    const key = url.searchParams.get("lang") === "he" ? KEY_HE : KEY_EN;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "tests/fixtures/lead-page-host.html"), "utf8").replaceAll("{{APP}}", appUrl).replaceAll("{{KEY}}", key));
  });
  // Two origins: the app on "localhost", the seller's page on "127.0.0.1", each on its own port.
  appUrl = `http://localhost:${await listen(app)}`;
  hostUrl = `http://127.0.0.1:${await listen(host)}`;
});
test.afterAll(async () => { app?.close(); host?.close(); });
test.beforeEach(() => { hits.length = 0; });

const form = (page: import("@playwright/test").Page, nth = 0) => page.locator("sas-lead-form").nth(nth);

test("takes the page's serif font; the page's hostile CSS does not reach the form", async ({ page }) => {
  await page.goto(`${hostUrl}/offer?utm_source=facebook&utm_campaign=spring`);
  const f = form(page);
  await expect(f.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(f.getByText("About: Fridge monitoring")).toBeVisible();
  const style = await f.locator("input[name=name]").evaluate((el) => {
    const label = el.closest("label")!;
    const s = getComputedStyle(label), i = getComputedStyle(el);
    return { font: s.fontFamily, spacing: s.letterSpacing, transform: s.textTransform, labelSize: s.fontSize, inputBg: i.backgroundColor, inputBorder: i.borderTopStyle, shadow: i.boxShadow };
  });
  expect(style.font).toContain("Georgia");
  expect(style).toMatchObject({ spacing: "normal", transform: "none", labelSize: "15px", inputBg: "rgb(255, 255, 255)", inputBorder: "solid", shadow: "none" });
  const button = await f.getByRole("button", { name: "Send" }).evaluate((el) => getComputedStyle(el).display);
  expect(button).toBe("flex");
  // One config fetch from the page's origin, and a view count (no cookie banner said no).
  await expect.poll(() => hits.filter((h) => h.path.endsWith("/e")).map((h) => JSON.parse(h.body).t)).toEqual(["view"]);
  expect(hits.find((h) => h.path.endsWith("/config"))?.origin).toBe(hostUrl);
  await page.context().clearCookies();
  expect(await page.evaluate(() => [document.cookie, localStorage.length, sessionStorage.length])).toEqual(["", 0, 0]);
});

test("a submit tells the page's own pixel and moves the page to the hand-over", async ({ page }) => {
  await page.goto(`${hostUrl}/offer?utm_source=facebook&gclid=G1`);
  const f = form(page);
  await f.getByLabel("Full name").fill("Rina Mizrahi");
  await f.getByLabel("Mobile number").fill("054 555 0142");
  await f.getByRole("checkbox").check();
  await expect.poll(() => hits.filter((h) => h.path.endsWith("/e")).map((h) => JSON.parse(h.body).t).sort()).toEqual(["open", "view"]);
  await Promise.all([page.waitForURL(`${appUrl}${HANDOVER}`), f.getByRole("button", { name: "Send" }).click()]);
  const sent = JSON.parse(hits.find((h) => h.path.endsWith("/submit"))!.body);
  expect(sent).toMatchObject({ name: "Rina Mizrahi", phone: "054 555 0142", consent: "on", sas_url: "", ft: "abc.AAAAAAAAAAAAAAAAAAAAAA", page_url: `${hostUrl}/offer`, utm_source: "facebook", gclid: "G1" });
  expect(hits.find((h) => h.path.endsWith("/submit"))!.origin).toBe(hostUrl);
});

test("the pixel is told before leaving the page", async ({ page }) => {
  await page.goto(`${hostUrl}/offer`);
  // Keep the page: the hand-over link is opened by the test, not followed.
  await page.route(`${appUrl}${HANDOVER}`, (r) => r.fulfill({ status: 204 }));
  const f = form(page);
  await f.getByLabel("Full name").fill("Rina Mizrahi");
  await f.getByLabel("Mobile number").fill("0545550142");
  await f.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fbqCalls: unknown[] }).__fbqCalls)).toEqual([["track", "Lead", {}, { eventID: "11111111-2222-3333-4444-555555555555" }]]);
});

test("field errors stay in the form; a placeholder added later gets its own form", async ({ page }) => {
  await page.goto(`${hostUrl}/offer`);
  const f = form(page);
  await f.getByRole("button", { name: "Send" }).click();
  await expect(f.getByText("Enter your name.")).toBeVisible();
  await expect(f.getByText("Enter a valid mobile number.")).toBeVisible();
  expect(hits.some((h) => h.path.endsWith("/submit"))).toBe(false);
  await page.evaluate((key) => {
    const d = document.createElement("div");
    d.setAttribute("data-sas-lead-form", key);
    document.getElementById("late-spot")!.appendChild(d);
  }, KEY_EN);
  await expect(form(page, 1).getByRole("button", { name: "Send" })).toBeVisible();
});

test("a cookie banner's \"denied\" sends no counts; the form still works", async ({ page }) => {
  await page.goto(`${hostUrl}/offer?deny=1`);
  const f = form(page);
  await f.getByLabel("Full name").fill("Rina Mizrahi");
  await expect(f.getByRole("button", { name: "Send" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(hits.filter((h) => h.path.endsWith("/e"))).toEqual([]);
});

test("Hebrew: right to left with the Hebrew texts", async ({ page }) => {
  await page.goto(`${hostUrl}/offer?lang=he`);
  const f = form(page);
  await expect(f.getByRole("button", { name: "שליחה" })).toBeVisible();
  expect(await f.locator("[data-sas-form]").getAttribute("dir")).toBe("rtl");
  await expect(f.getByText("בנושא: ניטור מקררים")).toBeVisible();
});

test("screenshots for the visual check (only with LP_SHOTS_DIR)", async ({ browser }) => {
  const dir = process.env.LP_SHOTS_DIR;
  test.skip(!dir, "LP_SHOTS_DIR not set");
  mkdirSync(dir!, { recursive: true });
  for (const lang of ["en", "he"]) {
    for (const width of [390, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      await p.goto(`${hostUrl}/offer?lang=${lang}`);
      await expect(p.locator("sas-lead-form").locator("button")).toBeVisible();
      if (lang === "en") await p.locator("sas-lead-form").locator("button").click();
      await p.waitForTimeout(150);
      await p.screenshot({ path: join(dir!, `snippet-${lang}-${width}.png`), fullPage: true });
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await ctx.close();
    }
  }
});
