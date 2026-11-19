/**
 * UAT round 2, step by step (A1 … G4), against a deployed site.
 *
 *   E2E_BASE_URL=https://salesatscale18.vercel.app \
 *   E2E_EMAIL=e2e+clerk_test@example.com E2E_PASSWORD=... \
 *   npx playwright test -c playwright.sim.config.ts tests/e2e/simulation/uat-round2.spec.ts
 *
 * One test per checklist step, named by its id. Each test asserts the step's
 * "Expect" text. The run creates its own seller account ("UAT2 <run id>",
 * home market Israel + Cyprus) and its own data, so run it only where test
 * data is acceptable (today: production, decision D9).
 *
 * The steps build on each other. Tests run in order on one worker; when a
 * test fails, Playwright starts a new worker, so the run's state (account,
 * leads, links) is kept in test-results/uat2-state.json and reloaded.
 *
 * Options:
 * - E2E_AGENT=1 runs the steps that need the live model (F1, F4, B4's
 *   test-lab introduction). They cost money, so they are off by default.
 * - UAT_SHOTS=<dir> is where the screenshots for the user go
 *   (default test-results/uat-shots).
 * - UAT_STATE=<file> keeps the run's state elsewhere, to re-run single steps
 *   with --grep against the account of an earlier run.
 *
 * Helpers are copied from full-use-case.spec.ts (signIn, buyerPage, noHorizontalScroll).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, devices, type Browser, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const AGENT = process.env.E2E_AGENT === "1";
const SHOTS = process.env.UAT_SHOTS ?? path.join("test-results", "uat-shots");
const STATE_FILE = process.env.UAT_STATE ?? path.join("test-results", "uat2-state.json");

type State = {
  run: string;
  appBase: string; // /app/<slug>
  accountId: string;
  priceList: string; // path of "Israel and Cyprus prices"
  euList: string; // path of "EU prices"
  leads: Record<string, string>; // name → lead path
  quotes: Record<string, string>; // name → quote id
  links: Record<string, string>; // name → buyer link
  inviteUrl: string;
  templateHeader?: string;
  supportOnReview?: boolean;
};

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    const s: State = {
      run: new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""),
      appBase: "", accountId: "", priceList: "", euList: "", leads: {}, quotes: {}, links: {}, inviteUrl: "",
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
    return s;
  }
}
const S = loadState();
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));
const RUN = S.run;
const SELLER = `UAT2 ${RUN}`;
const HOME = "Israel and Cyprus";
const HOME_LIST = "Israel and Cyprus prices";
const tail = RUN.slice(-5);
const phone = (n: number) => `0526${n}${tail}`; // Israeli mobile, unique per run
const OWNER_EMAIL = `uat2-owner-${RUN}+clerk_test@example.com`;
const SECOND_EMAIL = `uat2-seller-${RUN}+clerk_test@example.com`;

test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD (a super-admin test user) to run the UAT checks.");
test.afterEach(() => save());

let page: Page;

async function signIn(p: Page) {
  const base = new URL(test.info().project.use.baseURL ?? "https://salesatscale18.vercel.app");
  const onApp = (u: URL) => u.host === base.host;
  await p.goto("/app");
  await p.waitForLoadState("networkidle");
  if (onApp(new URL(p.url()))) return;
  await p.locator('input[name="identifier"]').fill(EMAIL);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  await p.locator('input[name="password"]').fill(PASSWORD);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  // Clerk asks for an email code on a new device ("client trust"); +clerk_test addresses accept 424242.
  await p.waitForURL((u) => onApp(u) || /client-trust|factor-two|verify/.test(u.pathname), { timeout: 60_000 });
  if (!onApp(new URL(p.url()))) await enterCode(p, onApp);
}

async function enterCode(p: Page, done: (u: URL) => boolean) {
  const code = p.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
  await p.waitForLoadState("networkidle");
  await code.waitFor();
  await p.waitForTimeout(1500);
  await code.pressSequentially("424242");
  const notSent = p.getByText("You need to send a verification code");
  if (await notSent.isVisible({ timeout: 4000 }).catch(() => false)) {
    await p.getByRole("button", { name: /Resend/ }).click();
    await p.waitForTimeout(2500);
    await code.click();
    await code.pressSequentially("424242");
  }
  await p.waitForURL(done, { timeout: 60_000 });
}

/** A buyer on a phone (no seller session). */
async function buyerPage(browser: Browser, url: string) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"], deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(url);
  return p;
}

async function noHorizontalScroll(p: Page) {
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll on ${p.url()}`).toBe(true);
}

/** The same seller session on a phone-sized screen: the page must not scroll sideways. */
async function phoneCheck(browser: Browser, url: string) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"], deviceScaleFactor: 2, storageState: await page.context().storageState() });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForLoadState("networkidle");
  await noHorizontalScroll(p);
  await ctx.close();
}

async function shot(p: Page, id: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${id}.png`), fullPage: true });
}

const need = (...v: string[]) => test.skip(v.some((x) => !x), "An earlier step this one depends on did not finish.");

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
  await signIn(page);
});

// ───────────────────────── A. Platform admin ─────────────────────────

test("A1 Create a seller account", async () => {
  await page.goto("/sadmin/accounts/new");
  await page.locator("#tradeName").fill(SELLER);
  await page.locator("#legalName").fill(`${SELLER} Ltd`);
  await page.locator("#companyId").fill("515550124");
  await page.locator("#market").selectOption("IL");
  await page.locator("#countries").fill("CY");
  await page.locator('input[name="languages"][value="en"]').check();
  await page.locator('input[name="languages"][value="he"]').check();
  await page.locator("#currency").selectOption("ILS");
  await page.locator("#plan").selectOption("pilot");
  await page.locator("#monthlySpendCap").fill("500");
  await page.locator("#ownerName").fill("UAT Owner");
  await page.locator("#ownerEmail").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Account created")).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy link/ })).toBeVisible();
  await expect(page.getByText(/It works once/)).toBeVisible();
  await page.goto("/sadmin/accounts");
  const row = page.locator("tr, li").filter({ has: page.getByRole("link", { name: SELLER }) }).first();
  await expect(row.getByText("Setting up")).toBeVisible();
  await page.getByRole("link", { name: SELLER }).first().click();
  await page.waitForURL(/\/sadmin\/accounts\/[0-9a-f-]{36}/);
  S.accountId = new URL(page.url()).pathname.split("/").pop()!;
  // The home market and the empty draft price list are checked from inside the account (A3).
});

test("A2 Check the account page", async () => {
  need(S.accountId);
  await page.goto("/sadmin/accounts");
  await page.getByRole("link", { name: SELLER }).first().click();
  await expect(page.getByText("Pilot").first()).toBeVisible();
  await expect(page.getByText(OWNER_EMAIL).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create new link" })).toBeVisible();
  await expect(page.getByText(/^[01] of 9 setup steps done$/)).toBeVisible();
  await expect(page.getByText("Prices", { exact: true })).toBeVisible();
  await expect(page.getByText("account.created").first()).toBeVisible();
});

test("A3 Enter the account", async () => {
  need(S.accountId);
  await page.goto(`/sadmin/accounts/${S.accountId}`);
  await page.getByRole("button", { name: "Enter account" }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  S.appBase = new URL(page.url()).pathname;
  await expect(page.getByText(`You are acting as ${SELLER}. Every change is logged.`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Exit account" })).toBeVisible();
  // A1's expectation: a home market "Israel and Cyprus" and an empty draft price list.
  await page.goto(`${S.appBase}/markets`);
  await expect(page.locator("[data-market-row]").filter({ hasText: HOME })).toHaveCount(1);
  await page.goto(`${S.appBase}/setup/price-lists`);
  const list = page.locator(".sas-list__row").filter({ hasText: HOME_LIST });
  await expect(list).toHaveCount(1);
  await expect(list.getByText("Draft")).toBeVisible();
});

// ───────────────────────── B. Seller setup ─────────────────────────

test("B1 Company", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/company`);
  await page.locator("#co-ad").fill("12 HaMelacha St, Tel Aviv");
  await page.locator("#co-sup").fill("support@uat-polar.test · 03 555 0142");
  await page.locator("#co-bc").fill("#0e7c66");
  await page.locator("form#company-form button[type=submit]").last().click();
  await expect(page.getByText("Company details saved.")).toBeVisible();
});

test("B1 Company step shows a check in the steps bar", async () => {
  // Fixed (Lane F): the Company page passes the real setup progress to its steps bar.
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/company`);
  await expect(page.locator('a.sas-steps__step--done[href$="/setup/company"]')).toBeVisible({ timeout: 5000 });
});

test("B2 Catalog without prices", async ({ browser }) => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/catalog`);
  const item = async (p: { sku: string; name: string; unit: string; kind?: "product" | "service"; custom?: Record<string, [string, string]> }) => {
    await page.getByRole("link", { name: "Add item" }).first().click();
    await page.locator(`input[name="kind"][value="${p.kind ?? "product"}"]`).check();
    await page.locator("#ci-sku").fill(p.sku);
    await page.locator("#ci-name").fill(p.name);
    await page.locator("#ci-unit").selectOption(p.unit);
    for (const [l, [one, other]] of Object.entries(p.custom ?? {})) {
      await page.locator(`#ci-u1-${l}`).fill(one);
      await page.locator(`#ci-u2-${l}`).fill(other);
    }
    // No price fields on an item.
    await expect(page.locator('aside input[name*="price" i]')).toHaveCount(0);
    await page.getByRole("button", { name: "Save to draft" }).click();
    await expect(page.getByText("Saved to the draft").first()).toBeVisible();
  };
  await item({ sku: "SNS-200", name: "Wireless sensor", unit: "device" });
  await item({ sku: "GW-10", name: "Site gateway", unit: "site" });
  await item({ sku: "INST-1", name: "Installation", unit: "site", kind: "service" });
  // "Custom unit…" once, singular and plural in each selling language. This item gets no price (B2b "not sold", D1a).
  await item({ sku: "PRB-5", name: "Probe", unit: "custom", custom: { en: ["probe", "probes"], he: ["גשש", "גששים"] } });
  // Kind and unit in the list.
  await expect(page.locator("tr", { hasText: "SNS-200" })).toContainText("Product · per device");
  await expect(page.locator("tr", { hasText: "GW-10" })).toContainText("Product · per site");
  await expect(page.locator("tr", { hasText: "INST-1" })).toContainText("Service · per site");
  await expect(page.locator("tr", { hasText: "PRB-5" })).toContainText("per probe");
  // Rule: the sensor needs one gateway per site.
  await page.locator("#r-kind").selectOption("requires");
  await page.locator("#r-sku").selectOption("SNS-200");
  await page.locator("#r-oneof").fill("GW-10");
  await page.locator('input[name="perSite"]').check();
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByText("SNS-200 needs one GW-10 per site.")).toBeVisible();
  // The item's Prices box points to price lists.
  await page.locator("tr", { hasText: "SNS-200" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Prices" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit in price lists" })).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "B2");
  await phoneCheck(browser, page.url());
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByText("v1 live")).toBeVisible();
});

test("B2a Automatic setup fee", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/catalog`);
  await page.locator("#r-kind").selectOption("auto_add");
  await page.locator("#r-sku").selectOption("INST-1");
  await page.locator('input[name="whenAnyOf"][value="GW-10"]').check();
  await page.locator('input[name="qty"][value="sites"]').check();
  await expect(page.locator('input[name="removable"]')).not.toBeChecked();
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByText("Check the rule:")).toHaveCount(0);
  // Plain words. The checklist's example is "Add one INST-1 per site with GW-10"; the app says:
  await expect(page.getByText("When a quote has GW-10, add INST-1 × number of sites.")).toBeVisible();
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByText("v2 live")).toBeVisible();
});

test("B2b Price list", async ({ browser }) => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/price-lists`);
  await page.getByRole("link", { name: HOME_LIST }).click();
  await page.waitForURL(/\/setup\/price-lists\/[0-9a-f-]{36}/);
  S.priceList = new URL(page.url()).pathname;
  // Settings: starts at the home country's standard rate (18% for Israel).
  await expect(page.locator("#pl-meta-tax")).toHaveValue("18");
  await expect(page.locator('form:has(#pl-meta-tax) input[name="pricesIncludeTax"]')).toBeVisible();
  const price = async (p: { sku: string; oneTime?: string; tiers?: string; monthly?: string }) => {
    await page.goto(`${S.priceList}?sku=${encodeURIComponent(p.sku)}`);
    await page.locator('input[name="sold"][value="yes"]').check();
    const ot = page.locator('input[name="oneTimeCharged"]');
    if (p.oneTime !== undefined) {
      await ot.check();
      await page.locator("#pe-ot").fill(p.oneTime);
      if (p.tiers) {
        // Structured tier editor (price-list item panel): Add tier, then quantity and unit price.
        const [from, price] = p.tiers.split(":").map((x) => x.trim());
        const block = page.locator("#ot-block");
        await block.getByRole("button", { name: "Add tier" }).click();
        await block.locator('input[data-tier="qty"]').last().fill(from);
        await block.locator('input[data-tier="price"]').last().fill(price);
      }
    } else await ot.uncheck();
    const rc = page.locator('input[name="recurringCharged"]');
    if (p.monthly) {
      await rc.check();
      await page.locator("#pe-rc").fill(p.monthly);
      await page.locator("#pe-rp").selectOption("month");
    } else await rc.uncheck();
    await page.getByRole("button", { name: "Save to draft" }).click();
    await expect(page.getByText("Saved to the draft").first()).toBeVisible();
  };
  // "Add a price" on a row opens the entry form.
  await page.goto(S.priceList);
  await expect(page.locator("tr", { hasText: "SNS-200" }).getByRole("link", { name: "Add a price" })).toBeVisible();
  await price({ sku: "SNS-200", oneTime: "590", tiers: "10: 550" });
  await price({ sku: "GW-10", oneTime: "660", monthly: "90" });
  await price({ sku: "INST-1", oneTime: "" }); // charged, price left for later → missing
  await page.goto(S.priceList);
  // Each row shows its state: priced, not charged, missing, not sold.
  await expect(page.locator("tr", { hasText: "SNS-200" })).toContainText("590");
  await expect(page.locator("tr", { hasText: "SNS-200" })).toContainText("No recurring price");
  await expect(page.locator("tr", { hasText: "INST-1" })).toContainText("Price missing");
  await expect(page.locator("tr", { hasText: "PRB-5" })).toContainText("Price missing");
  await noHorizontalScroll(page);
  await shot(page, "B2b-states");
  // Publishing with a missing price is refused.
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Add the missing price, or mark that part as not charged, to publish this price list." })).toBeVisible();
  await expect(page.getByText(/Version \d+ is live/)).toHaveCount(0);
  await price({ sku: "INST-1", oneTime: "250" });
  await page.goto(S.priceList);
  await page.getByRole("button", { name: "Publish v1" }).click();
  await expect(page.getByText(/^Version 1 is live/)).toBeVisible();
  await shot(page, "B2b");
  await phoneCheck(browser, page.url());
  await page.goto(`${S.appBase}/setup/price-lists`);
  const row = page.locator(".sas-list__row").filter({ hasText: HOME_LIST });
  await expect(row.getByText("Live", { exact: true })).toBeVisible();
  await expect(row.getByText(`Used by ${HOME}`)).toBeVisible();
  await expect(row.getByText(/missing price/)).toHaveCount(0);
  await expect(page.locator('a.sas-steps__step--done[href$="/setup/price-lists"]')).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "B2b-list");
  await phoneCheck(browser, page.url());
});

test("B2c Copy and adjust", async ({ browser }) => {
  need(S.appBase, S.priceList);
  await page.goto(`${S.appBase}/setup/price-lists`);
  await page.getByRole("link", { name: "Copy and adjust" }).first().click();
  await expect(page.locator("#pc-src option:checked")).toContainText(HOME_LIST);
  await page.locator("#pl-copy-name").fill("EU prices");
  await page.locator("#pl-copy-cur").selectOption("EUR");
  await page.getByLabel("By factor").check();
  await page.locator("#pc-amt").fill("0.25");
  await page.locator("#pc-round").selectOption("whole");
  await noHorizontalScroll(page);
  await shot(page, "B2c-form");
  await phoneCheck(browser, page.url());
  await page.getByRole("button", { name: "Copy price list" }).click();
  await page.waitForURL(/\/setup\/price-lists\/[0-9a-f-]{36}\?copied=/);
  S.euList = new URL(page.url()).pathname;
  await expect(page.getByText(/^Copied 3 prices into a new draft/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "EU prices" })).toBeVisible();
  // 590 × 0.25 = 147.50 → a whole euro amount; 660 × 0.25 = 165; 90 × 0.25 = 22.50 → whole; 250 × 0.25 = 62.50 → whole.
  const sns = page.locator("tr", { hasText: "SNS-200" });
  await expect(sns).toContainText(/€14[78]\.00/);
  await expect(page.locator("tr", { hasText: "GW-10" })).toContainText("€165.00");
  await expect(page.locator("tr", { hasText: "GW-10" })).toContainText(/€2[23]\.00/);
  await expect(page.locator("tr", { hasText: "INST-1" })).toContainText(/€6[23]\.00/);
  await expect(page.getByText("Not used by a market yet")).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "B2c");
  await phoneCheck(browser, page.url());
});

test("B2c Copy keeps the source list's VAT handling", async () => {
  // Fixed (Lane F): Copy and adjust starts from the source list's currency, VAT setting and rate,
  // so copying "Israel and Cyprus prices" (without VAT) keeps "EU prices" without VAT.
  need(S.euList);
  await page.goto(S.euList);
  await expect(page.getByText(/prices without VAT/).first()).toBeVisible({ timeout: 5000 });
});

test("B3 Knowledge", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/knowledge`);
  await page.locator("#kf-new-topic").fill("Warranty");
  await page.locator("#kf-statement").fill("Sensors have a 24-month warranty.");
  await page.locator("#kf-source").fill("Product sheet p.2");
  await page.getByRole("button", { name: "Add fact" }).last().click();
  await expect(page.getByText("Fact added. The agent can use it now.")).toBeVisible();
  // Edit it once.
  await page.getByRole("link", { name: "Edit" }).or(page.getByRole("button", { name: "Edit" })).first().click();
  await page.locator("#kf-e-statement").fill("Sensors have a 24-month warranty, gateways 12 months.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Fact saved.")).toBeVisible();
  await expect(page.getByText("Sensors have a 24-month warranty, gateways 12 months.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Warranty.*1/ }).first()).toBeVisible();
  await expect(page.getByText("Product sheet p.2").first()).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});

test("B4 Playbook", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/playbook`);
  await expect(page.locator("#pb-agentName")).toHaveValue(`${SELLER} assistant`);
  // An empty label shows an error on that row (a row left fully empty is dropped on save, by design).
  await page.getByRole("button", { name: "Add question" }).click();
  const rows = page.locator('input[id^="pb-field."][id$=".label"]');
  const n = await rows.count();
  await page.locator(`[id="pb-field.${n - 1}.example"]`).fill("How many fridges do you have?");
  await page.getByRole("button", { name: "Save to draft" }).first().click();
  await expect(page.locator(`[id="pb-field.${n - 1}.label-error"]`)).toHaveText("Give this field a name, or remove the row.");
  // A duplicate label shows an error on that row.
  const first = await page.locator('[id="pb-field.0.label"]').inputValue();
  await page.locator(`[id="pb-field.${n - 1}.label"]`).fill(first);
  await page.getByRole("button", { name: "Save to draft" }).first().click();
  await expect(page.locator(`[id="pb-field.${n - 1}.label-error"]`)).toContainText("appears twice");
  // Then a valid row. The agent name is typed after the refused saves (see "B4 Edits survive a refused save").
  await page.locator("#pb-agentName").fill("Maya");
  await page.locator(`[id="pb-field.${n - 1}.label"]`).fill("Number of fridges");
  await page.locator(`[id="pb-field.${n - 1}.stage"]`).selectOption({ label: "Needed for the quote" });
  await page.locator(`[id="pb-field.${n - 1}.example"]`).fill("How many fridges do you have?");
  await page.getByRole("button", { name: "Add objection" }).click();
  const o = (await page.locator('input[id^="pb-objection."][id$=".objection"]').count()) - 1;
  await page.locator(`[id="pb-objection.${o}.objection"]`).fill("It is too expensive");
  await page.locator(`[id="pb-objection.${o}.answer"]`).fill("One spoiled fridge costs more than a year of monitoring.");
  await page.locator("#pb-maxDiscount").fill("10");
  await page.getByRole("button", { name: "Save to draft" }).first().click();
  await expect(page.getByText(/^Draft saved/)).toBeVisible();
  // Rows keep their order.
  await page.reload();
  await expect(page.locator(`[id="pb-field.${n - 1}.label"]`)).toHaveValue("Number of fridges");
  await expect(page.locator("#pb-agentName")).toHaveValue("Maya");
  // Setup → Company shows the agent preview with the new name.
  await page.goto(`${S.appBase}/setup/company`);
  // Round 4 (A5): Company shows the real opener, built like the agent's, with "automated assistant".
  await expect(page.getByText(/Maya.*automated assistant/).first()).toBeVisible();
});

test("B4 Edits survive a refused save", async () => {
  // Fixed (Lane F): a refused save returns the submitted values, which the inputs show again.
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/playbook`);
  await page.locator("#pb-agentName").fill("Noa");
  await page.getByRole("button", { name: "Add question" }).click();
  const n = await page.locator('input[id^="pb-field."][id$=".label"]').count();
  await page.locator(`[id="pb-field.${n - 1}.example"]`).fill("Only an example");
  await page.getByRole("button", { name: "Save to draft" }).first().click();
  await expect(page.locator(`[id="pb-field.${n - 1}.label-error"]`)).toBeVisible();
  await expect(page.locator("#pb-agentName")).toHaveValue("Noa", { timeout: 5000 });
});

test("B5 Publish the agent version", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Publish draft v1" }).click();
  await expect(page.getByText("Version 1 is live.")).toBeVisible();
  await expect(page.locator("li, tr").filter({ hasText: "v1" }).filter({ hasText: "Live" }).first()).toBeVisible();
});

test("B4 Agent introduces itself by name (live model)", async () => {
  test.skip(!AGENT, "E2E_AGENT=1 runs the live agent (uses the Anthropic API).");
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/test-lab\?c=/);
  await labSend("Hi, who am I talking to?");
  const reply = page.locator(".sas-msg--agent").last();
  await expect(reply).toContainText("Maya");
  await expect(reply).toContainText(/automated/i);
});

test("B6 Order form", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/order-form`);
  await page.getByRole("button", { name: "Add sample sections to edit" }).click();
  await expect(page.getByText("Sales terms").first()).toBeVisible();
  const sales = page.locator("li").filter({ has: page.getByText("Sales terms", { exact: true }) }).first();
  await sales.getByRole("link", { name: "HE v1" }).click();
  await page.locator("#ls-body").fill("תנאי מכירה מעודכנים לבדיקה.\n\n1. ההזמנה מחייבת לאחר חתימה.");
  await page.getByRole("button", { name: "Save as version 2" }).click();
  await expect(page.getByText(/^Saved as version 2/)).toBeVisible();
  const salesAfter = page.locator("li").filter({ has: page.getByText("Sales terms", { exact: true }) }).first();
  await expect(salesAfter.getByRole("link", { name: "EN v1" })).toBeVisible();
  await expect(salesAfter.getByRole("link", { name: "HE v2" })).toBeVisible();
  await page.locator("#of-bank").fill("Test Bank · branch 800 · account 123456");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Order form settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "עברית" }).click();
  await expect(page.locator('[dir="rtl"]').first()).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
});

test("B7 Settings", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/settings?section=users`);
  await page.locator("#iu-name").fill("Second Seller");
  await page.locator("#iu-email").fill(SECOND_EMAIL);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText(`Invite link for Second Seller (${SECOND_EMAIL})`)).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy/ })).toBeVisible();
  S.inviteUrl = await page.locator("#invite-url").inputValue();
  expect(S.inviteUrl).toContain("/invite/");
  // Shown once: after a reload the link is gone, the invite is pending.
  await page.reload();
  await expect(page.locator("#invite-url")).toHaveCount(0);
  await expect(page.getByText("Pending invites")).toBeVisible();
  // Nobody can remove themselves or the last owner (the owner invite is still pending, so no Remove at all).
  await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);

  await page.goto(`${S.appBase}/settings?section=notifications`);
  await page.locator('input[name="order_paid_email"]').setChecked(false);
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Notifications saved.")).toBeVisible();
  await expect(page.locator('input[name="order_paid_email"]')).not.toBeChecked();

  await page.goto(`${S.appBase}/settings?section=hours`);
  await page.locator('input[name="fri_on"]').check();
  await page.locator('input[name="fri_from"]').fill("09:00");
  await page.locator('input[name="fri_to"]').fill("13:00");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Contact hours saved.")).toBeVisible();
});

test("B8 Go live", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/go-live`);
  // Before a test chat: the test-lab check fails with a fix button, Go live is disabled.
  const lab = page.locator('[data-check="test_lab"]');
  if ((await lab.getAttribute("data-state")) === "fail") {
    await expect(lab.getByRole("link", { name: "Open test lab" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go live" })).toBeDisabled();
  }
  for (const failing of await page.locator('li[data-state="fail"]').all()) {
    await expect(failing.getByRole("link")).toBeVisible();
  }
  // Markets: each market with its checks and a link to it.
  const markets = page.locator("[data-golive-markets]");
  await expect(markets.getByText(HOME)).toBeVisible();
  await expect(markets.getByRole("link", { name: "Open market" }).first()).toBeVisible();
  // F1 needs the model; a test chat started without it is enough for the check.
  await page.goto(`${S.appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/test-lab\?c=/);
  await page.goto(`${S.appBase}/setup/go-live`);
  await expect(page.getByText(/You can go live/)).toBeVisible();
  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText(/Live since/).first()).toBeVisible();
  await page.goto(`/sadmin/accounts/${S.accountId}`);
  await expect(page.locator(".sas-page-head").getByText("Live", { exact: true }).first()).toBeVisible();
});

// ───────────────────────── M. Markets ─────────────────────────

const homeRow = () => page.locator("[data-market-row]").filter({ hasText: HOME });

test("M1 Home market", async ({ browser }) => {
  need(S.appBase);
  await page.goto(`${S.appBase}/settings`);
  await page.getByRole("link", { name: "Markets" }).first().click();
  await page.waitForURL(/\/markets/);
  await homeRow().getByRole("link").click();
  const d = page.locator("[data-market-detail]");
  await expect(d.getByRole("heading", { name: new RegExp(HOME) })).toBeVisible();
  await expect(d.locator(".sas-chip", { hasText: "Home" })).toBeVisible();
  await expect(d.locator(".sas-pill").first()).toBeVisible(); // status
  await expect(d.locator("#where")).toContainText("Israel, Cyprus"); // app shows names, not IL / CY
  await expect(d).toContainText("+972");
  await expect(d).toContainText("+357");
  // The dropdown names the live list; no line repeats it under the dropdown.
  await expect(d.locator("#mk-pl option:checked")).toContainText(`${HOME_LIST} · ILS · live v1`);
  await expect(d).not.toContainText("Selling from");
  await expect(homeRow()).toContainText(/Leads: \d+/);
  await expect(d.locator("[data-check]").first()).toBeVisible();
  // Every setting reads "Same as account default" (Holidays has no account default: "None").
  await expect(d.locator('[data-source="market"]')).toHaveCount(0);
  await expect(d.locator('[data-setting] [data-source="account"]')).toHaveCount(6); // + Delivery › Lead time
  await expect(d.locator('[data-setting="holidays"]')).toContainText("None");
  await noHorizontalScroll(page);
  await shot(page, "M1");
  await phoneCheck(browser, page.url());
});

test("M2 Change for this market, edit and reset", async ({ browser }) => {
  need(S.appBase);
  await page.goto(`${S.appBase}/markets`);
  await homeRow().getByRole("link").click();
  const row = () => page.locator('[data-setting="paymentMethods"]');
  // An invalid value shows an error.
  await row().getByRole("link", { name: "Change for this market" }).click();
  const form = page.locator('[data-override-form="paymentMethods"]');
  await form.locator('input[name="card"]').uncheck();
  await form.locator('input[name="bankTransfer"]').uncheck();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Turn on card or bank transfer." })).toBeVisible();
  // Set for this market: bank transfer only.
  await page.locator('[data-override-form="paymentMethods"] input[name="card"]').uncheck();
  await page.locator('[data-override-form="paymentMethods"] input[name="bankTransfer"]').check();
  await page.locator('[data-override-form="paymentMethods"]').getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(row().locator('[data-source="market"]')).toHaveText("Set for this market");
  await expect(row()).toContainText("Bank transfer");
  await expect(row()).not.toContainText("Card");
  await noHorizontalScroll(page);
  await shot(page, "M2");
  await phoneCheck(browser, page.url());
  // Edit opens the same form with the market's value.
  await row().getByRole("link", { name: "Edit" }).click();
  await expect(page.locator('[data-override-form="paymentMethods"] input[name="card"]')).not.toBeChecked();
  await expect(page.locator('[data-override-form="paymentMethods"] input[name="bankTransfer"]')).toBeChecked();
  // Reset.
  await row().getByRole("button", { name: "Reset" }).click();
  await expect(page.getByText("This setting follows the account default again.")).toBeVisible();
  await expect(row().locator('[data-source="account"]')).toHaveText("Same as account default");
});

test("M3 Second market", async ({ browser }) => {
  need(S.appBase, S.euList);
  await page.goto(`${S.appBase}/markets`);
  await page.getByRole("link", { name: "Add market" }).click();
  const f = page.locator('[data-where-form="new"]');
  await f.locator("#mk-name").fill("Europe");
  await f.locator("#mk-countries").fill("DE, AT");
  await f.getByRole("button", { name: "Add market" }).click();
  await expect(page.getByText("Market added. It starts in Setting up.")).toBeVisible();
  const d = page.locator("[data-market-detail]");
  await expect(d.getByRole("heading", { name: /Europe/ })).toBeVisible();
  await expect(d).toContainText("+49");
  // "EU prices" is still a draft here (published in D1a, to see the quote editor without a live list first).
  await d.locator("#mk-pl").selectOption({ label: "EU prices · EUR · draft" });
  await d.getByRole("button", { name: "Save price list" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-market-row]").filter({ hasText: "Europe" })).toContainText("EU prices");
  await expect(d).toContainText("This price list has no live version yet.");
  // Going live is blocked until its checks pass.
  await expect(d.locator('[data-check="price_list"]')).toHaveAttribute("data-ok", "false");
  await expect(d.locator('[data-check="legal_texts"]')).toBeVisible();
  await expect(d.locator('[data-check="payment_methods"]')).toBeVisible();
  await expect(d.getByRole("button", { name: "Go live" })).toBeDisabled();
  await noHorizontalScroll(page);
  await shot(page, "M3");
  await phoneCheck(browser, page.url());
});

test("M4 Legal texts per market", async ({ browser }) => {
  need(S.appBase);
  await page.goto(`${S.appBase}/setup/order-form`);
  await page.locator("[data-market-switcher]").getByRole("link", { name: "Europe" }).click();
  const legal = page.locator("[data-market-legal]");
  await legal.locator('[data-section="sales_terms.en"]').getByRole("link", { name: "Change for this market" }).click();
  await page.locator("#ms-body").fill("EUROPE ONLY: German and Austrian sales terms for this test.");
  await page.getByRole("button", { name: "Save for Europe" }).click();
  await expect(page.getByText(/^Saved for this market as version/)).toBeVisible();
  await expect(legal.locator('[data-section="sales_terms.en"]')).toContainText("Set for this market");
  for (const s of ["sales_terms.he", "privacy_notice.en", "privacy_notice.he"]) {
    await expect(legal.locator(`[data-section="${s}"]`)).toContainText("Same as account default");
  }
  await noHorizontalScroll(page);
  await shot(page, "M4");
  await phoneCheck(browser, page.url());
  // Home-market buyers still see the account default (the home editor's text is unchanged).
  await page.goto(`${S.appBase}/setup/order-form?edit=sales_terms&lang=en`);
  await expect(page.locator("#ls-body")).not.toContainText("EUROPE ONLY");
  await expect(page.locator("#ls-body")).toContainText("SAMPLE TEXT");
});

// ───────────────────────── C. Leads ─────────────────────────

async function addLead(o: { name: string; phone: string; language: "en" | "he"; company: string; consent?: boolean; market?: string; source?: string }) {
  await page.goto(`${S.appBase}/leads?add=1`);
  await page.locator("#fullName").fill(o.name);
  await page.locator("#company").fill(o.company);
  await page.locator("#phone").fill(o.phone);
  await page.locator("#language").selectOption(o.language);
  if (o.market) await page.locator("#marketId").selectOption({ label: o.market });
  if (o.consent !== false) await page.locator('input[name="consent"]').check();
  await page.locator("#consentSource").fill(o.source ?? "UAT web form");
  await page.getByRole("button", { name: "Save lead" }).click();
}

test("C1 Add an English lead", async () => {
  need(S.appBase);
  // Saving without consent is refused.
  await addLead({ name: "Rina Cohen", phone: phone(1), language: "en", company: "Rina's Kitchen", consent: false, source: "" });
  await expect(page.getByText("Tick the consent box and say how this person agreed. Without it the lead can't be saved.")).toBeVisible();
  await page.locator('input[name="consent"]').check();
  await page.locator("#consentSource").fill("UAT web form");
  await page.getByRole("button", { name: "Save lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  S.leads.en = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: /Rina Cohen/ })).toBeVisible();
  // Masked phone: the full number is not shown.
  await expect(page.getByText(phone(1).slice(1))).toHaveCount(0);
  await expect(page.getByText(/\*|•/).first()).toBeVisible();
  await expect(page.getByText("Lead added")).toBeVisible();
  await expect(page.getByText("Consent recorded")).toBeVisible();
  await expect(page.getByTestId("lead-market")).toContainText(`Market: ${HOME}`);
  await page.goto(`${S.appBase}/leads`);
  await expect(page.getByRole("columnheader", { name: "Market" })).toBeVisible();
  await expect(page.locator("tr", { hasText: "Rina Cohen" })).toContainText(HOME);
});

test("C1 Consent box left unticked is refused even with How they agreed filled", async () => {
  // Fixed (Lane F): the manual form needs the box ticked AND a source (CSV and the webhook keep their rules).
  need(S.appBase);
  await addLead({ name: "No Tick", phone: phone(9), language: "en", company: "No Tick Ltd", consent: false });
  await expect(page.getByText("Tick the consent box and say how this person agreed. Without it the lead can't be saved.")).toBeVisible({ timeout: 8000 });
});

test("C2 Add a Hebrew lead", async () => {
  need(S.appBase);
  await addLead({ name: "Yossi Levi", phone: phone(2), language: "he", company: "קפה יוסי" });
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  S.leads.he = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: /Yossi Levi · קפה יוסי/ })).toBeVisible();
  // Same phone again: refused as a duplicate, with a link to the existing lead, which is not changed.
  await addLead({ name: "Yossi Again", phone: phone(2), language: "he", company: "Dup" });
  const dup = page.getByRole("alert").filter({ hasText: "A lead with this phone number already exists." });
  await expect(dup).toBeVisible();
  await expect(dup.getByRole("link", { name: "Open the lead" })).toHaveAttribute("href", S.leads.he);
  expect(new URL(page.url()).pathname).toBe(`${S.appBase}/leads`);
  await page.goto(`${S.appBase}/leads`);
  await expect(page.locator("tbody tr").filter({ hasText: /Yossi/ })).toHaveCount(1);
});

test("C2 Adding the same phone again keeps the existing lead's name", async () => {
  // Fixed (Lane F): a manual add of an existing phone no longer overwrites the lead.
  need(S.leads.he ?? "");
  await page.goto(S.leads.he);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Yossi Levi · קפה יוסי/, { timeout: 5000 });
});

test("C2a Lead market", async () => {
  need(S.appBase);
  await addLead({ name: "Klaus Berger", phone: `+49151${tail}12`, language: "en", company: "Berger Kühlung" });
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  S.leads.de = new URL(page.url()).pathname;
  await expect(page.getByTestId("lead-market")).toContainText("Market: Europe");
  // Change the market of another lead from its card.
  await addLead({ name: "Moshe Market", phone: phone(3), language: "en", company: "Mover Ltd" });
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  S.leads.mover = new URL(page.url()).pathname;
  await page.getByRole("combobox", { name: "Market" }).selectOption({ label: "Europe" });
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByText("Market changed.")).toBeVisible();
  await expect(page.getByTestId("lead-market")).toContainText("Market: Europe");
  await expect(page.getByText("Market changed", { exact: true })).toBeVisible();
});

test("C3 Import from CSV", async () => {
  need(S.appBase);
  await page.goto(`${S.appBase}/leads/import`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download template" }).click()]);
  const template = fs.readFileSync((await dl.path())!, "utf8");
  const header = template.split(/\r?\n/)[0];
  // The checklist's optional country column: add it when the template has none.
  const cols = header.split(",");
  const withCountry = cols.includes("country") ? cols : [...cols, "country"];
  const row = (v: Record<string, string>) => withCountry.map((c) => (v[c] ?? "").includes(",") ? `"${v[c]}"` : v[c] ?? "").join(",");
  const consent = { consent_source: "Signed sheet, UAT expo", consent_text: "I agree to be contacted on WhatsApp", consent_at: "2026-11-10T09:00:00Z" };
  S.leads.importedPhone = `+97252${tail}44`;
  const csv = [
    withCountry.join(","),
    row({ full_name: "Imported Ilana", phone: S.leads.importedPhone, language: "en", business: "Ilana Foods", ...consent }),
    row({ full_name: "Bad Phone", phone: "not-a-phone", language: "en", business: "Nope", ...consent }),
    row({ full_name: "Imported Hans", phone: `+4917${tail}55`, language: "en", business: "Hans GmbH", country: "DE", ...consent }),
  ].join("\n");
  await page.locator("#file").setInputFiles({ name: "uat-import.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Import" }).click();
  const tiles = page.locator(".sas-tile");
  await expect(tiles.nth(0)).toContainText("2");
  await expect(tiles.nth(2)).toContainText("1");
  await expect(page.locator("tr", { hasText: "Bad Phone" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download rejected rows" })).toBeVisible();
  // The DE row lands in Europe.
  await page.goto(`${S.appBase}/leads`);
  await expect(page.locator("tr", { hasText: "Imported Hans" })).toContainText("Europe");
  S.templateHeader = header;
});

test("C3 Template has the optional country column", async () => {
  // Fixed (Lane F): the template download is generated from CSV_TEMPLATE_HEADER.
  need(S.templateHeader ?? "");
  expect((S.templateHeader ?? "").split(",")).toContain("country");
});

test("C4 Opt out", async () => {
  need(S.appBase, S.leads.importedPhone);
  await page.goto(`${S.appBase}/leads`);
  await page.getByRole("link", { name: /Imported Ilana/ }).first().click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Mark as opted out" }).click();
  await page.getByRole("group", { name: "Mark as opted out" }).getByRole("button", { name: "Mark as opted out" }).click();
  await expect(page.getByText("Opted out").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Create quote" })).toHaveCount(0);
  // Importing that phone again is refused.
  await page.goto(`${S.appBase}/leads/import`);
  const csv = "full_name,phone,language,consent_source,consent_text\n" + `Imported Ilana,${S.leads.importedPhone},en,UAT,I agree`;
  await page.locator("#file").setInputFiles({ name: "again.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.locator(".sas-tile").nth(2)).toContainText("1");
  await expect(page.locator("tr", { hasText: "Imported Ilana" })).toBeVisible();
});

// ───────────────────────── D. Quotes ─────────────────────────

test("D1 Quote with a fit fix", async ({ browser }) => {
  need(S.appBase, S.leads.en);
  await page.goto(S.leads.en);
  await page.getByRole("link", { name: "Create quote" }).click();
  await page.waitForURL(/\/quote$/);
  await expect(page.getByText(`Prices come from ${HOME_LIST} v1 for the ${HOME} market, in ILS.`, { exact: false })).toBeVisible();
  // The picker shows each item's price.
  await expect(page.locator("#qe-add option", { hasText: "SNS-200" })).toContainText("590");
  await expect(page.locator("#qe-add option", { hasText: "GW-10" })).toContainText("660");
  await page.locator("#qe-add").selectOption("SNS-200");
  await page.locator('[id="q-SNS-200"]').fill("6");
  await page.locator("#q-sites").fill("2");
  const fix = page.getByRole("button", { name: "Add 2 × Site gateway" });
  await expect(fix).toBeVisible();
  await expect(page.locator(".sas-alert--danger").first()).toBeVisible();
  await fix.click();
  await expect(fix).toHaveCount(0);
  const gw = page.locator("tbody tr", { hasText: "GW-10" }).first();
  await expect(gw).toContainText("One-time");
  await expect(gw).toContainText("Monthly");
  await expect(gw).toContainText("₪660.00");
  await expect(gw).toContainText("₪90.00");
  const inst = page.locator('tr[data-auto-added="true"]', { hasText: "INST-1" });
  await expect(inst).toContainText("Added automatically");
  await expect(inst).toContainText("2");
  await expect(page.getByText("One-time items").first()).toBeVisible();
  await expect(page.getByText("Due on signing")).toBeVisible();
  await expect(page.locator(".sas-kv dt", { hasText: /^Monthly( total)?$/ })).toBeVisible(); // checklist says "Monthly total"; the editor says "Monthly"
  await noHorizontalScroll(page);
  await shot(page, "D1");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/orders\?quote=/);
  S.quotes.en = new URL(page.url()).searchParams.get("quote")!;
  await phoneCheck(browser, `${S.leads.en}/quote`);
});

test("D1a Not sold in this market", async ({ browser }) => {
  need(S.appBase, S.leads.de, S.euList);
  // Without a live price list the page says so, with a link to Price lists.
  await page.goto(`${S.leads.de}/quote`);
  await expect(page.getByText("This lead's market has no live price list yet.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open price lists" })).toBeVisible();
  // Publish EU prices, then quote in EUR.
  await page.goto(S.euList);
  await page.getByRole("button", { name: "Publish v1" }).click();
  await expect(page.getByText(/^Version 1 is live/)).toBeVisible();
  await page.goto(`${S.leads.de}/quote`);
  await expect(page.getByText("EU prices v1 for the Europe market, in EUR.", { exact: false })).toBeVisible();
  await expect(page.locator("#qe-add option", { hasText: "SNS-200" })).toContainText("€");
  const probe = page.locator("#qe-add option", { hasText: "PRB-5" });
  await expect(probe).toContainText("Not sold in this market");
  await expect(probe).toBeDisabled();
  await page.locator("#qe-add").selectOption("GW-10");
  await expect(page.locator("tbody tr", { hasText: "GW-10" }).first()).toContainText("€165.00");
  await expect(page.getByText("Due on signing")).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "D1a");
  await phoneCheck(browser, page.url());
});

test("D2 Discount above the limit", async () => {
  need(S.appBase, S.leads.he);
  await page.goto(`${S.leads.he}/quote`);
  await page.locator("#qe-add").selectOption("SNS-200");
  await page.locator('[id="q-SNS-200"]').fill("2");
  await page.locator("#qe-add").selectOption("GW-10");
  await page.locator("#q-sites").fill("1");
  await page.locator("#q-disc").fill("15");
  await expect(page.locator(".sas-alert--warning", { hasText: "Needs approval" })).toBeVisible();
  const submit = page.getByRole("button", { name: "Approve and send" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL(/\/orders\?quote=/);
  S.quotes.he = new URL(page.url()).searchParams.get("quote")!;
  // The checklist says "Approved by you: discount 15% above the 10% limit"; the app names the user:
  await expect(page.getByText(/Approved by .+: Discount 15\.0% is above the 10\.0% limit\./)).toBeVisible();
});

test("D3 New version", async () => {
  need(S.appBase, S.quotes.en);
  await page.goto(`${S.appBase}/orders?quote=${S.quotes.en}`);
  await page.getByRole("link", { name: "Create new version" }).click();
  await page.waitForURL(/\/quote\?from=/);
  await page.locator('[id="q-SNS-200"]').fill("8");
  const submit = page.locator('button[type="submit"]').last();
  await expect(submit).toBeEnabled();
  // "What changed" is required.
  await submit.click();
  await expect(page).toHaveURL(/\/quote\?from=/);
  await expect(page.getByText("Say what changed in this version.")).toBeVisible();
  await page.locator("#q-note").fill("8 sensors instead of 6");
  await submit.click();
  await page.waitForURL(/\/orders\?quote=/);
  await expect(page.getByText(/v2/).first()).toBeVisible();
  await page.goto(S.leads.en);
  await expect(page.locator(".sas-list__row", { hasText: /Q-\d+ v2/ }).first()).toBeVisible();
  await expect(page.getByText("Show v1")).toBeVisible();
});

// ───────────────────────── E. Buyer ─────────────────────────

async function sendForm(): Promise<string> {
  await page.getByRole("button", { name: /Send order form|New link/ }).click();
  await expect(page.getByText(/^Order form link created/)).toBeVisible();
  return (await page.getByRole("link", { name: "Open link" }).getAttribute("href"))!;
}

async function fillAndSign(buyer: Page, o: { id: string; address: string; email: string; role: string; button: string }) {
  await buyer.locator("#f-company_id").fill(o.id);
  await buyer.locator("#f-billing_address").fill(o.address);
  await buyer.locator("#f-delivery_address").fill(o.address).catch(() => undefined);
  await buyer.locator("#f-invoice_email").fill(o.email);
  await buyer.locator("#f-role").fill(o.role).catch(() => undefined);
  await buyer.locator('input[name="agreed"]').check();
  await buyer.getByRole("button", { name: o.button }).click();
}

test("E1 Review and sign (English)", async ({ browser }) => {
  need(S.appBase, S.quotes.en);
  await page.goto(`${S.appBase}/orders?quote=${S.quotes.en}`);
  S.links.en = await sendForm();
  const buyer = await buyerPage(browser, S.links.en);
  // The test banner shows only on the payment and paid pages (round 3, B6).
  await expect(buyer.getByText("Test payment. No real card is charged.")).toHaveCount(0);
  await expect(buyer.locator(".b-root")).toHaveAttribute("style", /--brand:\s*#0e7c66/i);
  await expect(buyer.getByRole("heading", { name: /here is your order/ })).toBeVisible();
  S.supportOnReview = await buyer.getByText("support@uat-polar.test · 03 555 0142").first().isVisible();
  // Lines: One-time and Monthly; units read like "₪590.00 per device"; Due today and Monthly total.
  await expect(buyer.locator('[data-charge="one_time"]', { hasText: "SNS-200" })).toContainText("₪590.00 per device");
  await expect(buyer.locator('[data-charge="one_time"]').first()).toContainText("One-time");
  await expect(buyer.locator('[data-charge="recurring"]').first()).toContainText("Monthly");
  await expect(buyer.getByText("Due today")).toBeVisible();
  await expect(buyer.getByText("Monthly incl. VAT")).toBeVisible();
  // The home price list is without VAT (B2b), so VAT rows show.
  await expect(buyer.getByText("One-time before VAT")).toBeVisible();
  await expect(buyer.getByText("Monthly before VAT")).toBeVisible();
  await expect(buyer.getByText("Prices are before VAT. VAT is added in the totals.")).toBeVisible();
  // Terms with versions; home-market buyers see the account default (M4).
  await expect(buyer.locator("summary", { hasText: "Sales terms" })).toContainText("v1");
  await buyer.locator("summary", { hasText: "Sales terms" }).click();
  await expect(buyer.getByText("SAMPLE TEXT").first()).toBeVisible();
  await expect(buyer.getByText("EUROPE ONLY")).toHaveCount(0);
  await noHorizontalScroll(buyer);
  await shot(buyer, "E1");
  // EN / עב switch.
  await buyer.getByRole("link", { name: "עב" }).click();
  await expect(buyer.locator('.b-root[dir="rtl"]')).toBeVisible();
  // Legal titles follow the page language (Hebrew version's title).
  await expect(buyer.locator("summary", { hasText: "תנאי מכירה" })).toBeVisible();
  await noHorizontalScroll(buyer);
  await shot(buyer, "E1-he");
  await buyer.getByRole("link", { name: "EN" }).click();
  // Errors on missing fields.
  await buyer.getByRole("button", { name: "Sign and continue to payment" }).click();
  await expect(buyer.getByText("Please confirm you agree to the terms.")).toBeVisible();
  await fillAndSign(buyer, { id: "512345678", address: "8 Dizengoff St, Tel Aviv", email: "rina@kitchen.test", role: "Owner", button: "Sign and continue to payment" });
  await expect(buyer.getByText(/Signed by Rina Cohen/)).toBeVisible();
  await noHorizontalScroll(buyer);
  await shot(buyer, "E1-signed");
  await buyer.context().close();
  await page.reload();
  await expect(page.getByText(/Opened by the buyer/)).toBeVisible();
  await expect(page.getByText(/Signed by Rina Cohen/)).toBeVisible();
});

test("E1 Support contact on the review page", async () => {
  // Fixed (Lane F): the support contact shows, subtly, while the buyer reviews, signs and pays.
  need(S.links.en ?? "");
  // Seen by E1 on the review page, before signing.
  expect(S.supportOnReview).toBe(true);
});

test("E2 Declined, then paid by card", async ({ browser }) => {
  need(S.links.en);
  const buyer = await buyerPage(browser, S.links.en);
  await buyer.getByRole("button", { name: "Simulate declined payment" }).click();
  await expect(buyer.getByText("Your bank declined the payment")).toBeVisible();
  await expect(buyer.getByText("Your signed order is saved")).toBeVisible();
  await buyer.getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(buyer.getByText("Payment received")).toBeVisible();
  await expect(buyer.getByText(/Order .+ is confirmed/)).toBeVisible();
  await expect(buyer.getByText("support@uat-polar.test · 03 555 0142").first()).toBeVisible();
  await noHorizontalScroll(buyer);
  await shot(buyer, "E2");
  await buyer.getByRole("link", { name: "Signed form" }).click();
  await expect(buyer.getByText(/Document fingerprint \(SHA-256\): [0-9a-f]{64}/)).toBeVisible();
  await expect(buyer.getByText(/IP address .+ · form version/)).toBeVisible();
  await expect(buyer.getByText(/Sales terms.*v1/).first()).toBeVisible();
  await expect(buyer.getByText("512345678")).toBeVisible();
  await buyer.context().close();
});

test("E3 Bank transfer (Hebrew)", async ({ browser }) => {
  need(S.appBase, S.quotes.he);
  await page.goto(`${S.appBase}/orders?quote=${S.quotes.he}`);
  S.links.he = await sendForm();
  const buyer = await buyerPage(browser, S.links.he);
  await expect(buyer.locator('.b-root[dir="rtl"]')).toBeVisible();
  await fillAndSign(buyer, { id: "512345679", address: "רחוב הרצל 1, חיפה", email: "yossi@cafe.test", role: "בעלים", button: "חתימה והמשך לתשלום" });
  await buyer.getByRole("link", { name: "העברה בנקאית" }).click();
  await buyer.getByRole("button", { name: "אשלם בהעברה בנקאית" }).click();
  await expect(buyer.getByText("ממתינים להעברה שלך")).toBeVisible();
  await expect(buyer.getByText(/Test Bank · branch 800 · account 123456/)).toBeVisible();
  await noHorizontalScroll(buyer);
  await shot(buyer, "E3");
  await buyer.context().close();
});

test("E4 Mark the transfer received", async () => {
  need(S.appBase, S.quotes.he);
  await page.goto(S.appBase);
  await page.getByText("Confirm bank transfer").first().locator("xpath=ancestor::li[1]").getByRole("link").first().click().catch(async () => {
    await page.goto(`${S.appBase}/orders?quote=${S.quotes.he}`);
  });
  await page.getByRole("button", { name: "Mark payment received" }).click();
  await expect(page.getByText("Payment recorded. The order is paid.")).toBeVisible();
  await expect(page.getByText("Paid").first()).toBeVisible();
  await page.goto(S.leads.he);
  await expect(page.getByText("Won").first()).toBeVisible();
  await page.goto(S.appBase);
  await expect(page.getByText("Confirm bank transfer")).toHaveCount(0);
});

test("E5 Price changes after sending", async ({ browser }) => {
  need(S.appBase, S.priceList);
  await addLead({ name: "Dana Mizrahi", phone: phone(4), language: "en", company: "Dana Deli" });
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  S.leads.dana = new URL(page.url()).pathname;
  await page.goto(`${S.leads.dana}/quote`);
  await page.locator("#qe-add").selectOption("SNS-200");
  await page.locator('[id="q-SNS-200"]').fill("1");
  await page.locator("#qe-add").selectOption("GW-10");
  await page.locator("#q-sites").fill("1");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/orders\?quote=/);
  S.links.dana = await sendForm();
  await page.goto(`${S.priceList}?sku=GW-10`);
  await page.locator("#pe-ot").fill("700");
  await page.getByRole("button", { name: "Save to draft" }).click();
  await expect(page.getByText("Saved to the draft").first()).toBeVisible();
  await page.goto(S.priceList);
  await page.getByRole("button", { name: "Publish v2" }).click();
  await expect(page.getByText(/^Version 2 is live/)).toBeVisible();

  const buyer = await buyerPage(browser, S.links.dana);
  await expect(buyer.getByText("The price has changed")).toBeVisible();
  await expect(buyer.getByText("Before").first()).toBeVisible();
  await expect(buyer.getByText("Now").first()).toBeVisible();
  await expect(buyer.getByText(/660/).first()).toBeVisible();
  await expect(buyer.getByText(/700/).first()).toBeVisible();
  await noHorizontalScroll(buyer);
  await shot(buyer, "E5");
  await buyer.getByRole("button", { name: "Accept new total and continue" }).click();
  await expect(buyer.getByRole("heading", { name: /here is your order/ })).toBeVisible();
  expect(buyer.url()).not.toBe(S.links.dana);
  await buyer.goto(S.links.dana);
  await expect(buyer.getByText("The offer was updated")).toBeVisible();
  await buyer.context().close();
});

test("E6 Bad link", async ({ browser }) => {
  need(S.links.en);
  const u = new URL(S.links.en);
  const token = u.pathname.split("/").pop()!;
  const last = token.slice(-1);
  u.pathname = `/f/${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
  const buyer = await buyerPage(browser, u.toString());
  await expect(buyer.getByText("This link is not valid")).toBeVisible();
  await expect(buyer.getByText("Rina")).toHaveCount(0);
  await expect(buyer.getByText(/₪/)).toHaveCount(0);
  await buyer.context().close();
});

// ───────────────────────── F. Conversations ─────────────────────────

async function newTestChat(scenario?: string) {
  await page.goto(`${S.appBase}/setup/test-lab`);
  if (scenario) await page.locator("#lab-scenario").selectOption({ label: scenario });
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/test-lab\?c=/);
}

test("F1 Test chat with a scenario", async () => {
  test.skip(!AGENT, "E2E_AGENT=1 runs the live agent (uses the Anthropic API).");
  need(S.appBase);
  await newTestChat("Ready buyer");
  // The scenario fills in its first message.
  await labSend(await page.locator("#lab-text").inputValue());
  await expect(page.locator(".sas-msg--agent").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Show raw" }).first()).toBeVisible();
  await expect(page.locator("[data-scenario-result]").first()).toBeVisible();
});

/** Sends a buyer message in the test lab and waits for the server to answer (it redirects to #end). */
async function labSend(text: string, reload = true) {
  await page.locator("#lab-text").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL(/#end|error=/, { timeout: 180_000 });
  // See "F2 Reply shows without reloading": the first reply in a new chat only shows after a reload.
  if (reload) await page.reload();
}

test("F2 Safety scenarios", async () => {
  need(S.appBase);
  await newTestChat();
  await labSend("STOP");
  await expect(page.getByText("Understood. We won't contact you again. Have a good day.")).toBeVisible();
  await expect(page.getByText("This chat is closed (the buyer opted out).")).toBeVisible();

  await newTestChat();
  await labSend("My card is 4111 1111 1111 1111");
  await expect(page.getByText("My card is [card number removed …1111]")).toBeVisible();
  await expect(page.getByText("4111 1111 1111 1111")).toHaveCount(0);
  await expect(page.getByText("For your security, please don't send card details here.", { exact: false })).toBeVisible();
});

test("F2 Reply shows without reloading", async () => {
  // Fixed (Lane F): Send (and take over / hand back from the lab) revalidate the test-lab page.
  need(S.appBase);
  await newTestChat();
  await labSend("STOP", false);
  await expect(page.getByText("Understood. We won't contact you again. Have a good day.")).toBeVisible({ timeout: 8000 });
});

test("F3 Take over and hand back", async () => {
  need(S.appBase);
  await newTestChat();
  await page.getByRole("button", { name: "Take over chat" }).click();
  // While a person holds the chat, a buyer message gets no agent reply (and needs no model).
  await labSend("Hello, is anyone there?");
  await expect(page.getByText("Hello, is anyone there?")).toBeVisible();
  await expect(page.locator(".sas-msg--agent")).toHaveCount(0);
  await page.getByRole("textbox", { name: /Reply as/ }).fill("Hi, Danny from the team here. How can I help?");
  await page.locator('form:has(textarea[id^="reply-"])').getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Hi, Danny from the team here. How can I help?")).toBeVisible();
  await page.getByRole("button", { name: "Hand back to agent" }).click();
  await expect(page.getByRole("button", { name: "Take over chat" })).toBeVisible();
  // "The same controls work on the lead card": a lead card only has them once a real chat exists (WhatsApp, later phase).
});

test("F4 Question the agent can't answer", async () => {
  test.skip(!AGENT, "E2E_AGENT=1 runs the live agent (uses the Anthropic API).");
  need(S.appBase);
  await newTestChat();
  await labSend("Do your sensors work at minus 40 degrees in a blast freezer?");
  await expect(page.locator(".sas-msg--agent").last()).toContainText(/check|team/i);
  await page.goto(`${S.appBase}/setup/knowledge`);
  await expect(page.getByText(/Questions we couldn't answer · [1-9]/)).toBeVisible();
});

// ───────────────────────── G. Day-to-day ─────────────────────────

test("G1 Overview", async () => {
  need(S.appBase);
  await page.goto(S.appBase);
  await page.getByRole("link", { name: "Last 7 days" }).click();
  await expect(page.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Test leads not counted")).toBeVisible();
  await page.getByRole("link", { name: "Last 30 days" }).click();
  await expect(page.getByRole("link", { name: "Last 30 days" })).toHaveAttribute("aria-current", "page");
  const kpi = page.locator(".sas-metric, .sas-tile").filter({ hasText: "Leads received" }).first();
  // The same number as the Leads list (test-lab leads are not counted).
  const kpiText = await kpi.innerText();
  await page.goto(`${S.appBase}/leads`);
  const listed = await page.locator("tbody tr").count();
  expect(kpiText.match(/\d+/)?.[0], `Leads received (${kpiText}) vs the Leads list`).toBe(String(listed));
  await page.goto(S.appBase);
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
});

test("G2 Orders and timeline", async () => {
  need(S.appBase, S.leads.en);
  await page.goto(`${S.appBase}/orders?tab=orders`);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody").getByText("Paid")).toHaveCount(2);
  await page.goto(S.leads.en);
  const titles = await page.locator("ol.sas-tl .sas-tl__title").allInnerTexts();
  const text = titles.join("\n");
  const at = (s: string) => text.indexOf(s);
  for (const s of ["Order form sent", "Order form opened", "Order form signed", "Order paid"]) expect(at(s), s).toBeGreaterThan(-1);
  // Newest first or oldest first, the four must be in order.
  const order = ["Order form sent", "Order form opened", "Order form signed", "Order paid"].map(at);
  const asc = order.every((v, i) => i === 0 || v > order[i - 1]);
  const desc = order.every((v, i) => i === 0 || v < order[i - 1]);
  expect(asc || desc, `timeline order: ${order.join(",")}`).toBe(true);
});

test("G3 Seller sees only their account", async ({ browser }) => {
  test.skip(process.env.UAT_SIGNUP !== "1", "Clerk refuses an automated sign-up of a new user (\"We couldn't complete this request\", bot protection), so the second person can't be signed up from a script. Check G3 by hand; UAT_SIGNUP=1 tries anyway.");
  need(S.inviteUrl);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const host = new URL(test.info().project.use.baseURL ?? "https://salesatscale18.vercel.app").host;
  const onApp = (u: URL) => u.host === host;
  await p.goto(S.inviteUrl);
  await p.waitForLoadState("networkidle");
  // Clerk: sign up with the invited +clerk_test email (code 424242).
  await p.getByRole("link", { name: /Sign up/ }).click();
  await p.locator('input[name="emailAddress"]').fill(SECOND_EMAIL);
  const pw = p.locator('input[name="password"]');
  if (await pw.isVisible({ timeout: 2000 }).catch(() => false)) await pw.fill(`Uat2-${RUN}-Seller!`);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  await enterCode(p, onApp);
  if (!/\/invite\//.test(p.url())) await p.goto(S.inviteUrl);
  await p.getByRole("button", { name: "Accept invite" }).click();
  await p.waitForURL(/\/app\/[^/]+$/);
  expect(new URL(p.url()).pathname).toBe(S.appBase);
  await expect(p.getByText(/You are acting as/)).toHaveCount(0);
  await p.goto("/app");
  await p.waitForURL(/\/app\/[^/]+$/); // no account picker: straight into UAT2
  expect(new URL(p.url()).pathname).toBe(S.appBase);
  const r = await p.goto("/sadmin");
  expect(r?.status()).toBe(404);
  await ctx.close();
});

test("G4 Admin activity", async () => {
  need(S.appBase, S.accountId);
  await page.goto(S.appBase);
  await page.getByRole("link", { name: "Exit account" }).click();
  await page.goto("/sadmin");
  const filters = page.getByRole("form", { name: "Filter activity" }).or(page.locator("form.sas-filters"));
  await filters.locator('select[name="account"]').selectOption({ label: SELLER });
  await filters.locator('select[name="action"]').selectOption("order.");
  await filters.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/action=order/);
  const rows = page.locator("tbody tr").filter({ hasText: /order\./ });
  await expect(rows.first()).toBeVisible();
  const all = page.locator("table").first().locator("tbody tr");
  for (const r of await all.all()) {
    await expect(r).toContainText(SELLER);
    await expect(r).toContainText(/order\./);
  }
  await expect(all.filter({ hasText: "Acting as" }).first()).toBeVisible();
  // Newest first.
  const times = (await all.locator("td:first-child").allInnerTexts()).map((s) => Date.parse(s.replace(",", "")));
  for (let i = 1; i < times.length; i++) if (!Number.isNaN(times[i]) && !Number.isNaN(times[i - 1])) expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
});
