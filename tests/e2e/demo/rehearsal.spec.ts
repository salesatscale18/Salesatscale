/**
 * Demo rehearsal: sets up ONE seller account, "Polar Demo", on a deployed
 * site through the real UI, ready for a live WhatsApp demo.
 *
 *   E2E_BASE_URL=https://salesatscale18.vercel.app \
 *   E2E_EMAIL=... E2E_PASSWORD=... \
 *   npx playwright test -c tests/e2e/demo/playwright.config.ts
 *
 * PAID: step "P1 Analyze sources" spends money on the Anthropic API (one
 * analysis run). It runs only with REHEARSAL_PAID=1, and at most once per
 * state file: the click is recorded before it happens, so a re-run never
 * starts a second analysis. Everything else is free (no test-lab messages,
 * no E2E_AGENT).
 *
 * Serial and resumable: each step records itself as done in
 * test-results/rehearsal-state.json (override with REHEARSAL_STATE), and a
 * re-run skips the steps already done, so a failed step can be re-run
 * without creating a second account. Screenshots and page text go to
 * REHEARSAL_SHOTS (default test-results/rehearsal-shots).
 *
 * Helpers are copied from tests/e2e/simulation/uat-round2.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const PAID = process.env.REHEARSAL_PAID === "1";
const ROOT = path.resolve(__dirname, "../../..");
const STATE_FILE = process.env.REHEARSAL_STATE ?? path.join(ROOT, "test-results", "rehearsal-state.json");
const SHOTS = process.env.REHEARSAL_SHOTS ?? path.join(ROOT, "test-results", "rehearsal-shots");

const SELLER = "Polar Demo";
const WA_NUMBER = "+972535634674";
const LEAD_PHONE = "+972545650090";

type State = {
  accountId: string;
  appBase: string; // /app/<slug>
  priceList: string;
  done: Record<string, boolean>;
  notes: Record<string, unknown>;
  analysis: { clicked: boolean; estimate?: string; confirm?: string; runs?: string[]; finished?: boolean; error?: string };
};

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    const s: State = { accountId: "", appBase: "", priceList: "", done: {}, notes: {}, analysis: { clicked: false } };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    return s;
  }
}
const S = loadState();
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));
const note = (k: string, v: unknown) => {
  S.notes[k] = v;
  save();
};

test.describe.configure({ mode: "serial" });
test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD (a super-admin test user).");
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
  if (!onApp(new URL(p.url()))) {
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
    await p.waitForURL(onApp, { timeout: 60_000 });
  }
}

/** Full-page screenshot plus the page's text, for the report. */
async function shot(id: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${id}.png`), fullPage: true });
  const text = await page.locator("main").first().innerText().catch(() => page.locator("body").innerText());
  fs.writeFileSync(path.join(SHOTS, `${id}.txt`), `${page.url()}\n\n${text}`);
}

const visible = (l: ReturnType<Page["locator"]>, timeout = 2500) => l.isVisible({ timeout }).catch(() => false);

/** One resumable step: skipped when an earlier run finished it. */
function step(name: string, fn: () => Promise<void>, needs: () => string[] = () => [S.appBase]) {
  test(name, async () => {
    test.skip(!!S.done[name], "Done in an earlier run.");
    test.skip(needs().some((x) => !x), "An earlier step this one depends on did not finish.");
    await fn();
    S.done[name] = true;
    save();
  });
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  await signIn(page);
});

// ───────────────────────── Account ─────────────────────────

/** The row of exactly "Polar Demo" in Platform admin › Accounts (the link name also holds market and status). */
const accountLink = () => page.locator("a.sas-list__row").filter({ has: page.locator("strong", { hasText: /^Polar Demo$/ }) }).first();

step("A1 Create the account", async () => {
  // Never a second "Polar Demo": if one exists and this state file does not know it, stop.
  await page.goto("/sadmin/accounts");
  if (await visible(accountLink())) {
    throw new Error(`An account named "${SELLER}" already exists. Put its id in ${STATE_FILE} (accountId) instead of creating another.`);
  }
  await page.goto("/sadmin/accounts/new");
  await page.locator("#tradeName").fill(SELLER);
  await page.locator("#legalName").fill(`${SELLER} Ltd`);
  await page.locator("#market").selectOption("IL");
  await page.locator("#countries").fill("");
  await page.locator('input[name="languages"][value="en"]').check();
  await page.locator('input[name="languages"][value="he"]').check();
  await page.locator("#currency").selectOption("ILS");
  await page.locator("#plan").selectOption("pilot");
  await page.locator("#monthlySpendCap").fill("500");
  await page.locator("#ownerName").fill("Demo Owner");
  await page.locator("#ownerEmail").fill(EMAIL);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Account created")).toBeVisible();
  await shot("A1-created");
  await page.goto("/sadmin/accounts");
  await accountLink().click();
  await page.waitForURL(/\/sadmin\/accounts\/[0-9a-f-]{36}/);
  S.accountId = new URL(page.url()).pathname.split("/").pop()!;
  save();
}, () => ["x"]);

step("A2 Enter the account", async () => {
  await page.goto(`/sadmin/accounts/${S.accountId}`);
  await page.getByRole("button", { name: "Enter account" }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  S.appBase = new URL(page.url()).pathname;
  save();
  await expect(page.getByText(`You are acting as ${SELLER}.`, { exact: false })).toBeVisible();
}, () => [S.accountId]);

/** Each run starts a new browser session; enter the account again so "acting as" holds. */
async function enter() {
  await page.goto(`/sadmin/accounts/${S.accountId}`);
  const btn = page.getByRole("button", { name: "Enter account" });
  if (await visible(btn, 5000)) {
    await btn.click();
    await page.waitForURL(/\/app\/[^/]+$/);
  }
}
test("A3 Re-enter the account (each run)", async () => {
  test.skip(!S.accountId || !S.done["A2 Enter the account"], "No account yet.");
  await enter();
});

// ───────────────────────── Company ─────────────────────────

step("B1 Company and delivery", async () => {
  await page.goto(`${S.appBase}/setup/company`);
  await page.locator("#co-ad").fill("12 HaMelacha St, Tel Aviv");
  await page.locator("#co-sup").fill("support@polar-demo.example · 03 555 0142");
  await page.locator("#co-bc").fill("#0e6fb8");
  await page.locator('input[name="minDays"]').fill("5");
  await page.locator('input[name="maxDays"]').fill("10");
  await page.locator('input[name="businessDays"]').check();
  await page.locator("form#company-form button[type=submit]").last().click();
  await expect(page.getByText("Company details saved.")).toBeVisible();
  await expect(page.locator('input[name="minDays"]')).toHaveValue("5");
  await expect(page.locator('input[name="maxDays"]')).toHaveValue("10");
  await shot("B1-company");
});

// ───────────────────────── Catalog ─────────────────────────

step("B2 Catalog, rules, publish", async () => {
  await page.goto(`${S.appBase}/setup/catalog`);
  const item = async (p: { sku: string; name: string; unit: string; kind?: "product" | "service" }) => {
    if (await visible(page.locator("tr", { hasText: p.sku }).first(), 1500)) return;
    await page.getByRole("link", { name: "Add item" }).first().click();
    await page.locator(`input[name="kind"][value="${p.kind ?? "product"}"]`).check();
    await page.locator("#ci-sku").fill(p.sku);
    await page.locator("#ci-name").fill(p.name);
    await page.locator("#ci-unit").selectOption(p.unit);
    await page.getByRole("button", { name: "Save to draft" }).click();
    await expect(page.getByText("Saved to the draft").first()).toBeVisible();
  };
  await item({ sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" });
  await item({ sku: "GW-10", name: "Site gateway", unit: "site" });
  await item({ sku: "INST-1", name: "Installation", unit: "site", kind: "service" });
  await expect(page.locator("tr", { hasText: "SNS-200" })).toContainText("Product · per device");
  await expect(page.locator("tr", { hasText: "GW-10" })).toContainText("Product · per site");
  await expect(page.locator("tr", { hasText: "INST-1" })).toContainText("Service · per site");

  if (!(await visible(page.getByText("SNS-200 needs one GW-10 per site."), 1500))) {
    await page.locator("#r-kind").selectOption("requires");
    await page.locator("#r-sku").selectOption("SNS-200");
    await page.locator("#r-oneof").fill("GW-10");
    await page.locator('input[name="perSite"]').check();
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText("SNS-200 needs one GW-10 per site.")).toBeVisible();
  }
  if (!(await visible(page.getByText(/When a quote has GW-10, add INST-1/).first(), 1500))) {
    await page.locator("#r-kind").selectOption("auto_add");
    await page.locator("#r-sku").selectOption("INST-1");
    await page.locator('input[name="whenAnyOf"][value="GW-10"]').check();
    await page.locator('input[name="qty"][value="sites"]').check();
    await page.locator('input[name="removable"]').check();
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText("Check the rule:")).toHaveCount(0);
    await expect(page.getByText(/When a quote has GW-10, add INST-1/).first()).toBeVisible();
  }
  await shot("B2-catalog-draft");
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByText(/v\d+ live|is published|is live/i).first()).toBeVisible();
  await shot("B2-catalog-published");
});

// ───────────────────────── Price list ─────────────────────────

step("B3 Home price list, publish", async () => {
  await page.goto(`${S.appBase}/setup/price-lists`);
  await page.locator('.sas-list__row a[href*="/setup/price-lists/"]').first().click();
  await page.waitForURL(/\/setup\/price-lists\/[0-9a-f-]{36}/);
  S.priceList = new URL(page.url()).pathname;
  save();
  note("vat", {
    rate: await page.locator("#pl-meta-tax").inputValue(),
    pricesIncludeTax: await page.locator('form:has(#pl-meta-tax) input[name="pricesIncludeTax"]').isChecked().catch(() => null),
  });
  await expect(page.locator("#pl-meta-tax")).toHaveValue("18");
  const price = async (p: { sku: string; oneTime: string; tier?: [string, string]; monthly?: string }) => {
    await page.goto(`${S.priceList}?sku=${encodeURIComponent(p.sku)}`);
    await page.locator('input[name="sold"][value="yes"]').check();
    await page.locator('input[name="oneTimeCharged"]').check();
    await page.locator("#pe-ot").fill(p.oneTime);
    if (p.tier) {
      const block = page.locator("#ot-block");
      if ((await block.locator('input[data-tier="qty"]').count()) === 0) await block.getByRole("button", { name: "Add tier" }).click();
      await block.locator('input[data-tier="qty"]').last().fill(p.tier[0]);
      await block.locator('input[data-tier="price"]').last().fill(p.tier[1]);
      await expect(block.getByText(`1–${Number(p.tier[0]) - 1}:`)).toBeVisible();
    }
    const rc = page.locator('input[name="recurringCharged"]');
    if (p.monthly) {
      await rc.check();
      await page.locator("#pe-rc").fill(p.monthly);
      await page.locator("#pe-rp").selectOption("month");
    } else await rc.uncheck();
    await page.getByRole("button", { name: "Save to draft" }).click();
    await expect(page.getByText("Saved to the draft").first()).toBeVisible();
  };
  await price({ sku: "SNS-200", oneTime: "590", tier: ["10", "550"] });
  await price({ sku: "GW-10", oneTime: "660", monthly: "90" });
  await price({ sku: "INST-1", oneTime: "250" });
  await page.goto(S.priceList);
  await expect(page.locator("tr", { hasText: "SNS-200" })).toContainText("590");
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByText(/Version \d+ is live/)).toBeVisible();
  await shot("B3-price-list");
}, () => [S.appBase]);

// ───────────────────────── Order form ─────────────────────────

step("B4 Order form", async () => {
  await page.goto(`${S.appBase}/setup/order-form`);
  const sample = page.getByRole("button", { name: "Add sample sections to edit" });
  if (await visible(sample, 4000)) {
    await sample.click();
    await expect(page.getByText("Sales terms").first()).toBeVisible();
  }
  await page.locator("#of-bank").fill("Test Bank · branch 800 · account 123456");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Order form settings saved.")).toBeVisible();
  await shot("B4-order-form");
});

// ───────────────────────── Sources ─────────────────────────

const FACTS = `Polar Demo sells wireless temperature monitoring for restaurants and food businesses.
The SNS-200 wireless fridge sensor measures from -40°C to +60°C with an accuracy of ±0.3°C.
Alerts go out by WhatsApp, SMS and email after a delay the customer configures (for example 15 minutes out of range).
One GW-10 site gateway handles up to 30 sensors within about 50 m indoors.
The sensor battery lasts about 3 years, and the app warns 30 days before it runs out.
The daily temperature log is ready for health inspectors and is kept for 2 years.
Sensors and gateways have a 24-month warranty.
The monthly monitoring plan (per gateway) includes the app and all alerts.
Installation takes about 1 hour per site.
Buyers can also install the system themselves with remote help from our support team.`;

const POLICY = `Prices are in ILS and do not include VAT (18%).
The sensor costs 590 ILS, or 550 ILS each from 10 sensors.
Every site needs one gateway (660 ILS plus 90 ILS per month for monitoring) and installation (250 ILS per site).
We can waive installation for 3 sites or more.
Discounts above 5% need manager approval.`;

const TRANSCRIPT = `00:00 Rep: Hi Dana, this is Avi from Polar Demo. Thanks for taking the call.
00:06 Buyer: Sure. We have three cafés, in Tel Aviv and Ramat Gan, so I have about ten minutes.
00:14 Rep: Great. How do you check the fridges today?
00:19 Buyer: The shift manager writes the temperature on a paper sheet, morning and evening. Sometimes they forget.
00:31 Rep: And at night, or on Shabbat, when nobody is there?
00:36 Buyer: Nobody checks. We find out in the morning.
00:41 Rep: Has that ever gone wrong? What did the last failure cost you?
00:47 Buyer: Last summer a fridge in Ramat Gan died on a Friday night. We threw away about 6,000 shekels of stock and closed the kitchen for half a day.
01:02 Rep: That is exactly what our sensors are for. Each fridge gets a wireless sensor, and you get a WhatsApp alert when it goes out of range.
01:12 Buyer: We already pay for an alarm company.
01:16 Rep: I understand. But an alarm covers doors, not temperature. It won't tell you the fridge is at 9 degrees.
01:25 Buyer: Fair point. How many sensors would we need?
01:29 Rep: One per fridge or freezer, and one gateway per site. How many fridges does each café have?
01:35 Buyer: About five each, so fifteen in total.
01:40 Rep: So fifteen sensors and three gateways. The sensor is 590 shekels, 550 from ten units, and the gateway is 660 plus 90 a month for the monitoring plan.
01:55 Buyer: And installation?
01:58 Rep: Normally 250 per site, but for three sites I can waive the installation fee.
02:06 Buyer: Okay. Can we show the logs to the health inspector?
02:11 Rep: Yes, the daily log is ready for inspectors and kept for two years.
02:18 Buyer: Send me the order form and I'll talk to my partner.
02:22 Rep: Will do. Thanks, Dana.`;

step("C1 Sources: two notes and a call transcript", async () => {
  await page.goto(`${S.appBase}/setup/sources`);
  const note = async (title: string, body: string) => {
    if (await visible(page.getByRole("link", { name: title, exact: true }), 1500)) return;
    await page.locator("#src-note-title").fill(title);
    await page.locator("#src-note-body").fill(body);
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Note saved.")).toBeVisible();
  };
  await note("Polar Demo – product facts", FACTS);
  await note("Pricing and policy", POLICY);
  const callTitle = "Discovery call – café chain, 3 sites";
  if (!(await visible(page.getByRole("link", { name: callTitle, exact: true }), 1500))) {
    await page.locator("#src-call-name").fill(callTitle);
    await page.locator("#src-call-rep").fill("Avi");
    await page.locator("#src-call-date").fill("2026-11-10");
    await page.locator("#src-call-text").fill(TRANSCRIPT);
    await page.locator('form:has(#src-call-text) input[name="consent"]').check();
    await page.getByRole("button", { name: "Add transcript" }).click();
    await page.waitForLoadState("networkidle");
  }
  await page.goto(`${S.appBase}/setup/sources`);
  await expect(page.getByRole("link", { name: callTitle, exact: true })).toBeVisible();
  // Wait until no source is still being read.
  for (let i = 0; i < 20 && (await visible(page.getByText(/Reading|Processing/i).first(), 500)); i++) {
    await page.waitForTimeout(3000);
    await page.reload();
  }
  await shot("C1-sources");
});

// ───────────────────────── PAID: analysis ─────────────────────────

const runRows = async () => {
  const panel = page.locator("section:has(#an-h)");
  return (await panel.locator("tbody tr").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
};

step("P1 Analyze sources (PAID, once)", async () => {
  test.skip(!PAID && !S.analysis.clicked, "REHEARSAL_PAID=1 runs the paid analysis (Anthropic API).");
  test.setTimeout(14 * 60_000);
  const sources = `${S.appBase}/setup/sources`;
  if (!S.analysis.clicked) {
    await page.goto(sources);
    const panel = page.locator("section:has(#an-h)");
    S.analysis.estimate = (await panel.locator('p[aria-live="polite"]').innerText()).trim();
    save();
    await panel.getByRole("link", { name: "Analyze sources" }).click();
    await page.waitForURL(/analyze=confirm/);
    const confirm = page.locator("form:has(button:text('Start analysis'))");
    S.analysis.confirm = (await confirm.innerText()).replace(/\s+/g, " ").trim();
    await shot("P1-confirm");
    // Recorded before the click: a re-run never starts a second paid analysis.
    S.analysis.clicked = true;
    save();
    await confirm.getByRole("button", { name: "Start analysis" }).click();
    await page.waitForLoadState("networkidle");
  }
  // Poll every ~15 s, up to 10 minutes.
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    await page.goto(sources);
    const rows = await runRows();
    S.analysis.runs = rows;
    save();
    const running = await visible(page.getByText("Analyzing your sources.", { exact: false }), 1000);
    // Only the newest analysis (its two stage rows, listed first) counts; older failed runs stay in the list.
    const latest = rows.slice(0, 2);
    const bad = latest.find((r) => /Failed|Stopped at spend cap/.test(r));
    if (bad) {
      S.analysis.error = bad;
      S.analysis.finished = true;
      await shot("P1-failed");
      throw new Error(`Analysis failed: ${bad}`);
    }
    if (!running && latest.length > 0 && latest.every((r) => /Completed/.test(r))) break;
    if (Date.now() > until) {
      await shot("P1-timeout");
      throw new Error(`Analysis still not finished after 10 minutes: ${rows.join(" | ")}`);
    }
    await page.waitForTimeout(15_000);
  }
  S.analysis.finished = true;
  await shot("P1-runs");
});

// ───────────────────────── Knowledge ─────────────────────────

const summary = async () => (await page.locator("main header > span.sas-small").first().innerText()).replace(/\s+/g, " ").trim();

step("D1 Knowledge: resolve contradictions, approve all", async () => {
  await page.goto(`${S.appBase}/setup/knowledge`);
  note("knowledge.before", await summary());
  await shot("D1-knowledge-before");
  const resolved: string[] = [];
  for (let i = 0; i < 20; i++) {
    const form = page.locator('form:has(input[name="choice"])').first();
    if (!(await visible(form, 1500))) break;
    const title = (await form.locator("h2").innerText()).trim();
    const first = (await form.locator("label:has(input[name=choice]) strong").first().innerText()).trim();
    await form.locator('input[name="choice"]').first().check();
    await form.getByRole("button", { name: "Save choice" }).click();
    await page.waitForLoadState("networkidle");
    resolved.push(`${title} → ${first}`);
    await page.goto(`${S.appBase}/setup/knowledge`);
  }
  note("knowledge.contradictions", resolved);
  const all = page.getByRole("button", { name: /^Approve all suggested/ }).first();
  if (await visible(all, 3000)) {
    note("knowledge.approveAllButton", await all.innerText());
    await all.click();
    await expect(page.getByText(/facts approved\./)).toBeVisible();
    note("knowledge.approveAllResult", await page.getByText(/facts approved\./).innerText());
  }
  await page.goto(`${S.appBase}/setup/knowledge`);
  note("knowledge.after", await summary());
  await shot("D1-knowledge-after");
}, () => [S.appBase, S.analysis.finished && !S.analysis.error ? "ok" : ""]);

// ───────────────────────── Playbook draft ─────────────────────────

step("D2 Playbook draft: accept, approve limits, save", async () => {
  const here = `${S.appBase}/setup/playbook/draft`;
  await page.goto(here);
  note("draft.before", (await page.locator("h1 + .sas-small").first().innerText().catch(() => "")).trim());
  await shot("D2-draft-before");
  const log: string[] = [];
  const act = async (btn: ReturnType<Page["locator"]>) => {
    const label = (await btn.getAttribute("aria-label")) ?? (await btn.innerText());
    await btn.click();
    await page.waitForURL(/[?&](done|error)=/);
    const msg = await page.locator("main .sas-alert").first().innerText().catch(() => "");
    log.push(`${label.trim()} → ${msg.trim()}`);
    await page.goto(here);
  };
  for (let i = 0; i < 60; i++) {
    const all = page.getByRole("button", { name: /^Accept all \d+$/ }).first();
    if (await visible(all, 1500)) { await act(all); continue; }
    const one = page.getByRole("button", { name: /^Accept: / }).first();
    if (await visible(one, 1000)) { await act(one); continue; }
    break;
  }
  for (let i = 0; i < 20; i++) {
    const rule = page.getByRole("button", { name: /^Approve rule: / }).first();
    if (!(await visible(rule, 1500))) break;
    await act(rule);
  }
  note("draft.actions", log);
  note("draft.after", (await page.locator("h1 + .sas-small").first().innerText().catch(() => "")).trim());
  await shot("D2-draft-reviewed");
  await page.getByRole("button", { name: /^Save as agent draft v\d+$/ }).click();
  await expect(page.getByText(/accepted items saved to agent draft v\d+/)).toBeVisible();
  note("draft.saved", await page.getByText(/accepted items saved to agent draft v\d+/).innerText());
  await shot("D2-draft-saved");
}, () => [S.appBase, S.done["D1 Knowledge: resolve contradictions, approve all"] ? "ok" : ""]);

step("D3 Playbook: agent name and discount limit", async () => {
  await page.goto(`${S.appBase}/setup/playbook`);
  note("playbook.discountBefore", await page.locator("#pb-maxDiscount").inputValue());
  await page.locator("#pb-agentName").fill("Maya");
  await page.locator("#pb-maxDiscount").fill("5");
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText(/^Draft saved/)).toBeVisible();
  await page.reload();
  await expect(page.locator("#pb-agentName")).toHaveValue("Maya");
  await shot("D3-playbook");
}, () => [S.appBase, S.done["D2 Playbook draft: accept, approve limits, save"] ? "ok" : ""]);

// ───────────────────────── Publish, test lab, go live ─────────────────────────

step("E1 Publish the agent version", async () => {
  await page.goto(`${S.appBase}/setup/test-lab`);
  await page.getByRole("button", { name: /^Publish draft v\d+$/ }).click();
  await expect(page.getByText(/Version \d+ is live\./)).toBeVisible();
  note("agent.published", await page.getByText(/Version \d+ is live\./).innerText());
  await shot("E1-published");
}, () => [S.appBase, S.done["D3 Playbook: agent name and discount limit"] ? "ok" : ""]);

step("E2 Start a test chat (no message: free)", async () => {
  await page.goto(`${S.appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/test-lab\?c=/);
  await shot("E2-test-lab");
}, () => [S.appBase, S.done["E1 Publish the agent version"] ? "ok" : ""]);

async function goLive(tag: string) {
  await page.goto(`${S.appBase}/setup/go-live`);
  const checks = await page.locator("li[data-check][data-state]").evaluateAll((els) =>
    els.map((e) => `${e.getAttribute("data-check")}=${e.getAttribute("data-state")}: ${(e as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`),
  );
  note(`golive.${tag}.checks`, checks);
  await shot(`E3-go-live-${tag}`);
  if (await visible(page.getByText(/Live since/).first(), 1500)) {
    note("golive.result", "already live");
    return true;
  }
  const btn = page.getByRole("button", { name: "Go live" });
  if (!(await btn.isEnabled().catch(() => false))) {
    note("golive.result", `blocked (${tag})`);
    return false;
  }
  await btn.click();
  await expect(page.getByText(/Live since/).first()).toBeVisible();
  note("golive.result", `live (${tag}): ${await page.getByText(/Live since/).first().innerText()}`);
  await shot(`E3-live-${tag}`);
  return true;
}

step("E3 Go live", async () => {
  // Go live needs a company ID; the brief gives none, so a fictional one is filled in when it is empty.
  await page.goto(`${S.appBase}/setup/company`);
  if (!(await page.locator("#co-id").inputValue())) {
    await page.locator("#co-id").fill("515550142");
    await page.locator("form#company-form button[type=submit]").last().click();
    await expect(page.getByText("Company details saved.")).toBeVisible();
    note("company.idAdded", "515550142 (fictional, needed by the go-live check)");
  }
  await goLive("first");
}, () => [S.appBase, S.done["E2 Start a test chat (no message: free)"] ? "ok" : ""]);

// ───────────────────────── WhatsApp ─────────────────────────

step("F1 Settings › WhatsApp: add the number", async () => {
  await page.goto(`${S.appBase}/settings?section=whatsapp`);
  const listed = page.locator(".sas-list__row").filter({ hasText: WA_NUMBER });
  if (!(await visible(listed, 2000))) {
    await page.locator("#wa-sender").fill(WA_NUMBER);
    await page.locator("#wa-name").fill(SELLER);
    const market = page.locator("#wa-market");
    if (await visible(market, 1000)) {
      const home = await market.locator("option").nth(1).textContent();
      await market.selectOption({ index: 1 });
      note("whatsapp.market", home);
    } else note("whatsapp.market", "no market choice offered (one market: the number serves all markets)");
    await page.getByRole("button", { name: "Add number" }).click();
    await page.waitForURL(/[?&](saved|error)=/);
    note("whatsapp.addResult", await page.locator("main .sas-alert").first().innerText());
  }
  const section = page.locator("section:has(#wa-h)");
  note("whatsapp.provider", await section.locator(".sas-pill").first().innerText());
  note("whatsapp.webhook", await section.locator("code").first().innerText());
  note("whatsapp.numberRow", (await listed.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim());
  note("whatsapp.templates", (await page.locator("section:has(#wa-tpl-h)").innerText()).replace(/\s+/g, " ").trim().slice(0, 600));
  note("whatsapp.url", `${S.appBase}/settings?section=whatsapp`);
  await shot("F1-whatsapp");
});

step("F2 Go live again if it was blocked", async () => {
  if (S.notes["golive.result"] && !String(S.notes["golive.result"]).startsWith("blocked")) return;
  await goLive("after-whatsapp");
}, () => [S.appBase, S.done["F1 Settings › WhatsApp: add the number"] && S.done["E3 Go live"] ? "ok" : ""]);

// ───────────────────────── Lead ─────────────────────────

step("G1 Add the demo lead", async () => {
  await page.goto(`${S.appBase}/leads?add=1`);
  await page.locator("#fullName").fill("Eyal Demo");
  await page.locator("#company").fill("Café Demo");
  await page.locator("#phone").fill(LEAD_PHONE);
  await page.locator("#language").selectOption("en");
  await page.locator('input[name="consent"]').check();
  await page.locator("#consentSource").fill("Demo, agreed in person");
  await page.getByRole("button", { name: "Save lead" }).click();
  const dup = page.getByRole("alert").filter({ hasText: "already exists" });
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30_000 }).catch(() => undefined);
  if (!/\/leads\/[0-9a-f-]{36}/.test(page.url())) {
    if (await visible(dup, 1000)) {
      await dup.getByRole("link", { name: "Open the lead" }).click();
      await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
      note("lead.duplicate", true);
    } else {
      await shot("G1-lead-error");
      throw new Error(`Lead not saved: ${await page.getByRole("alert").first().innerText().catch(() => "no message")}`);
    }
  }
  note("lead.url", new URL(page.url()).pathname);
  await expect(page.getByText("Eyal Demo").first()).toBeVisible();
  await shot("G1-lead");
  await page.goto(`${S.appBase}/conversations`);
  note("conversations.url", `${S.appBase}/conversations`);
  await shot("G2-conversations");
});
