/**
 * Full use case, end to end in a real browser (docs/e2e-simulation.md):
 * platform admin sets up a seller → the seller configures catalog, knowledge,
 * playbook and order form → leads come in → quotes → buyers sign and pay
 * (card, decline then success; bank transfer; price change) → the seller sees
 * the orders paid. Outside connectors (WhatsApp, a real payment provider,
 * email) are replaced by the test channel and the fake payment provider.
 *
 * The live agent chat runs only with E2E_AGENT=1 (it calls the real model).
 */
import { expect, test, devices, type Browser, type Page } from "@playwright/test";

const RUN = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SELLER = `E2E Polar ${RUN}`;

test.describe.configure({ mode: "serial" });
test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD (a super-admin test user) to run the simulation.");

let page: Page;
let appBase = ""; // /app/<slug>
const links: Record<string, string> = {};

async function signIn(p: Page) {
  await p.goto("/app");
  await p.waitForURL(/sign-in|\/app/);
  if (!/sign-in/.test(p.url())) return;
  await p.locator('input[name="identifier"]').fill(EMAIL);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  await p.locator('input[name="password"]').fill(PASSWORD);
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  // Dev instances may ask for an email code on a new device; +clerk_test addresses accept 424242.
  const code = p.locator('input[autocomplete="one-time-code"]').first();
  if (await code.isVisible({ timeout: 5000 }).catch(() => false)) await code.pressSequentially("424242");
  await p.waitForURL(/salesatscale18|localhost|\/app|\/sadmin/, { timeout: 60_000 });
}

async function buyerPage(browser: Browser, url: string) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const p = await ctx.newPage();
  await p.goto(url);
  return p;
}

async function noHorizontalScroll(p: Page) {
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signIn(page);
});

test("1. Platform admin creates the seller account", async () => {
  await page.goto("/sadmin/accounts/new");
  await page.locator("#tradeName").fill(SELLER);
  await page.locator("#legalName").fill(`${SELLER} Ltd`);
  await page.locator("#companyId").fill("515550123");
  await page.locator('input[name="languages"][value="he"]').check();
  await page.locator("#monthlySpendCap").fill("500");
  await page.locator("#ownerName").fill("E2E Owner");
  await page.locator("#ownerEmail").fill(EMAIL);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/invite/i).first()).toBeVisible();
  await page.goto("/sadmin/accounts");
  await page.getByRole("link", { name: SELLER }).first().click();
  await page.getByRole("button", { name: "Enter account" }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  appBase = new URL(page.url()).pathname;
});

test("2. Catalog: products, tiers, fit rule, publish", async () => {
  await page.goto(`${appBase}/setup/catalog`);
  const product = async (p: { sku: string; name: string; unit: string; price: string; monthly?: boolean; tiers?: [string, string][] }) => {
    await page.getByRole("link", { name: "Add product" }).click();
    await page.locator("#ci-sku").fill(p.sku);
    if (p.monthly) await page.locator("#ci-charge").selectOption("recurring");
    await page.locator("#ci-name").fill(p.name);
    await page.locator("#ci-unit").fill(p.unit);
    await page.locator("#ci-price").fill(p.price);
    for (const [qty, price] of p.tiers ?? []) {
      await page.getByRole("button", { name: "Add tier" }).click();
      const rows = page.locator('input[id^="pt-q-"]');
      await rows.last().fill(qty);
      await page.locator('input[id^="pt-p-"]').last().fill(price);
    }
    await page.getByRole("button", { name: "Save to draft" }).click();
    await expect(page.getByText("Saved to the draft")).toBeVisible();
  };
  await product({ sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "590", tiers: [["10", "550"]] });
  await product({ sku: "GW-10", name: "Site gateway", unit: "site", price: "660" });
  await product({ sku: "PLAN-M", name: "Monitoring plan", unit: "site", price: "90", monthly: true });
  // Fit rule: a sensor needs a gateway per site.
  await page.locator('select[name="kind"]').selectOption("requires");
  await page.locator('select[name="sku"]').selectOption("SNS-200");
  await page.locator('input[name="oneOf"]').fill("GW-10");
  await page.locator('input[name="perSite"]').check();
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByText("SNS-200 needs one GW-10 per site.")).toBeVisible();
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();
  await expect(page.getByText(/is live|published/i).first()).toBeVisible();
});

test("3. Company, knowledge, playbook and agent version", async () => {
  await page.goto(`${appBase}/setup/company`);
  await page.locator("#co-ad").fill("12 HaMelacha St, Tel Aviv");
  await page.locator("#co-sup").fill("support@e2e-polar.test · 03 555 0142");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Company details saved.")).toBeVisible();

  await page.goto(`${appBase}/setup/knowledge`);
  await page.locator("#kf-new-topic").fill("Warranty");
  await page.locator("#kf-statement").fill("Sensors have a 24-month warranty.");
  await page.locator("#kf-source").fill("Product sheet p.2");
  await page.getByRole("button", { name: "Add fact" }).last().click();
  await expect(page.getByText("Fact added. The agent can use it now.")).toBeVisible();
  await expect(page.getByText("Sensors have a 24-month warranty.")).toBeVisible();

  await page.goto(`${appBase}/setup/playbook`);
  await page.locator("#pb-maxDiscount").fill("10");
  await page.getByRole("button", { name: "Save draft" }).first().click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();

  await page.goto(`${appBase}/setup/test-lab`);
  await page.getByRole("button", { name: /^Publish draft v\d+$/ }).click();
  await expect(page.getByText(/is live/)).toBeVisible();
});

test("4. Order form: legal text EN/HE, fields, payment methods", async () => {
  await page.goto(`${appBase}/setup/order-form`);
  await page.getByRole("button", { name: "Add sample sections to edit" }).click();
  await expect(page.getByText("Sales terms").first()).toBeVisible();
  await page.locator("#of-bank").fill("Test Bank · branch 800 · account 123456");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Order form settings saved.")).toBeVisible();
  // Live preview switches to Hebrew, right to left.
  await page.getByRole("button", { name: "עברית" }).click();
  await expect(page.locator('[dir="rtl"]').first()).toBeVisible();
});

test("4b. Test lab hand-off without the model, settings, go live", async () => {
  await page.goto(`${appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/test-lab\?c=/);
  await page.getByRole("button", { name: "Take over chat" }).click();
  await page.getByRole("textbox", { name: /Reply as/ }).fill("Hi, Danny from the team here. How can I help?");
  await page.locator('form:has(textarea[id^="reply-"])').getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Hi, Danny from the team here. How can I help?")).toBeVisible();
  await page.getByRole("button", { name: "Hand back to agent" }).click();
  await expect(page.getByRole("button", { name: "Take over chat" })).toBeVisible();

  await page.goto(`${appBase}/settings?section=hours`);
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Contact hours saved.")).toBeVisible();
  await page.goto(`${appBase}/settings?section=users`);
  await expect(page.getByText("Owner").first()).toBeVisible();

  await page.goto(`${appBase}/setup/go-live`);
  await expect(page.getByText(/You can go live/)).toBeVisible();
  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText(/Live since|You are live/).first()).toBeVisible();
});

async function addLead(name: string, phone: string, language: "en" | "he", company: string) {
  await page.goto(`${appBase}/leads?add=1`);
  await page.locator("#fullName").fill(name);
  await page.locator("#company").fill(company);
  await page.locator("#phone").fill(phone);
  await page.locator("#language").selectOption(language);
  await page.locator('input[name="consent"]').check();
  await page.locator("#consentSource").fill("E2E web form");
  await page.getByRole("button", { name: "Save lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname;
}

async function createQuote(leadPath: string, lines: [string, number][], opts: { sites?: number; discount?: string } = {}) {
  await page.goto(`${leadPath}/quote`);
  for (const [sku, qty] of lines) {
    await page.locator("#qe-add").selectOption(sku);
    await page.locator(`[id="q-${sku}"]`).fill(String(qty));
  }
  if (opts.sites) await page.locator("#q-sites").fill(String(opts.sites));
  if (opts.discount) await page.locator("#q-disc").fill(opts.discount);
  const submit = page.locator('button[type="submit"]').last();
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL(/\/orders\?quote=/);
  return new URL(page.url()).searchParams.get("quote")!;
}

async function sendForm(): Promise<string> {
  await page.getByRole("button", { name: /Send order form|New link/ }).click();
  await expect(page.getByText("Order form link created.")).toBeVisible();
  return (await page.getByRole("link", { name: "Open link" }).getAttribute("href"))!;
}

test("5. Lead 1 (EN): quote with a fit fix, order form, decline then card payment", async ({ browser }) => {
  const lead = await addLead("Rina Cohen", `05255${RUN.slice(-5)}`, "en", "Rina's Kitchen");
  await page.goto(`${lead}/quote`);
  await page.locator("#qe-add").selectOption("SNS-200");
  await page.locator('[id="q-SNS-200"]').fill("6");
  await page.locator("#q-sites").fill("2");
  // Red fit check with a one-click fix.
  const fix = page.getByRole("button", { name: /Add 2 × Site gateway/ });
  await expect(fix).toBeVisible();
  await fix.click();
  await page.locator("#qe-add").selectOption("PLAN-M");
  await page.locator('[id="q-PLAN-M"]').fill("2");
  await expect(page.getByText("Due on signing")).toBeVisible();
  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/orders\?quote=/);
  links.l1 = await sendForm();

  const buyer = await buyerPage(browser, links.l1);
  await expect(buyer.getByText("Test payment. No real card is charged.")).toBeVisible();
  await expect(buyer.getByText(/here is your order/)).toBeVisible();
  await noHorizontalScroll(buyer);
  await buyer.getByRole("link", { name: "עב" }).click();
  await expect(buyer.locator('.b-root[dir="rtl"]')).toBeVisible();
  await buyer.getByRole("link", { name: "EN" }).click();
  // Missing fields are refused.
  await buyer.getByRole("button", { name: "Sign and continue to payment" }).click();
  await expect(buyer.getByText("Please confirm you agree to the terms.")).toBeVisible();
  await buyer.locator("#f-company_id").fill("512345678");
  await buyer.locator("#f-billing_address").fill("8 Dizengoff St, Tel Aviv");
  await buyer.locator("#f-delivery_address").fill("8 Dizengoff St, Tel Aviv").catch(() => undefined);
  await buyer.locator("#f-invoice_email").fill("rina@kitchen.test");
  await buyer.locator("#f-role").fill("Owner").catch(() => undefined);
  await buyer.locator('input[name="agreed"]').check();
  await buyer.getByRole("button", { name: "Sign and continue to payment" }).click();
  await expect(buyer.getByText(/Signed by Rina Cohen/)).toBeVisible();
  await buyer.getByRole("button", { name: "Simulate declined payment" }).click();
  await expect(buyer.getByText("Your bank declined the payment")).toBeVisible();
  await buyer.getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(buyer.getByText("Payment received")).toBeVisible();
  await buyer.getByRole("link", { name: "Signed form" }).click();
  await expect(buyer.getByText(/Document fingerprint/)).toBeVisible();
  await buyer.context().close();

  // Seller sees it paid.
  await page.reload();
  await expect(page.getByText("Paid").first()).toBeVisible();
  await page.goto(lead);
  await expect(page.getByText("Won").first()).toBeVisible();
  await expect(page.getByText("Order paid")).toBeVisible();
});

test("6. Lead 2 (HE): discount above the limit, approval, bank transfer marked received", async ({ browser }) => {
  const lead = await addLead("Yossi Levi", `05256${RUN.slice(-5)}`, "he", "Cafe Yossi");
  const quoteId = await createQuote(lead, [["SNS-200", 2], ["GW-10", 1]], { sites: 1, discount: "15" });
  expect(quoteId).toBeTruthy();
  // A person's quote above the limit is approved by them, with the reason logged.
  await expect(page.getByText(/Approved by .*discount/i)).toBeVisible();
  links.l2 = await sendForm();

  const buyer = await buyerPage(browser, links.l2);
  await expect(buyer.locator('.b-root[dir="rtl"]')).toBeVisible();
  await buyer.locator("#f-company_id").fill("512345679");
  await buyer.locator("#f-billing_address").fill("רחוב הרצל 1, חיפה");
  await buyer.locator("#f-delivery_address").fill("רחוב הרצל 1, חיפה").catch(() => undefined);
  await buyer.locator("#f-invoice_email").fill("yossi@cafe.test");
  await buyer.locator("#f-role").fill("בעלים").catch(() => undefined);
  await buyer.locator('input[name="agreed"]').check();
  await buyer.getByRole("button", { name: "חתימה והמשך לתשלום" }).click();
  await buyer.getByRole("link", { name: "העברה בנקאית" }).click();
  await buyer.getByRole("button", { name: "אשלם בהעברה בנקאית" }).click();
  await expect(buyer.getByText("ממתינים להעברה שלך")).toBeVisible();
  await buyer.context().close();

  await page.goto(appBase);
  await expect(page.getByText("Confirm bank transfer")).toBeVisible();
  await page.goto(`${appBase}/orders?quote=${quoteId}`);
  await expect(page.getByText("Bank transfer expected").first()).toBeVisible();
  await page.getByRole("button", { name: "Mark payment received" }).click();
  await expect(page.getByText("Payment recorded. The order is paid.")).toBeVisible();
});

test("7. Lead 3: the price changes before signing; the buyer accepts the new total", async ({ browser }) => {
  const lead = await addLead("Dana Mizrahi", `05257${RUN.slice(-5)}`, "en", "Dana Deli");
  await createQuote(lead, [["SNS-200", 1], ["GW-10", 1]], { sites: 1 });
  links.l3 = await sendForm();
  // Change the gateway price and publish.
  await page.goto(`${appBase}/setup/catalog`);
  await page.getByRole("link", { name: "Site gateway" }).click();
  await page.locator("#ci-price").fill("700");
  await page.getByRole("button", { name: "Save to draft" }).click();
  await page.getByRole("button", { name: /^Publish v\d+$/ }).click();

  const buyer = await buyerPage(browser, links.l3);
  await expect(buyer.getByText("The price has changed")).toBeVisible();
  await buyer.getByRole("button", { name: "Accept new total and continue" }).click();
  await expect(buyer.getByText(/here is your order/)).toBeVisible();
  const newUrl = buyer.url();
  expect(newUrl).not.toBe(links.l3);
  // The old link now says the offer was updated.
  await buyer.goto(links.l3);
  await expect(buyer.getByText("The offer was updated")).toBeVisible();
  await buyer.context().close();
});

test("8. Opt-out is respected", async () => {
  const lead = await addLead("Opt Out", `05258${RUN.slice(-5)}`, "en", "No Thanks Ltd");
  await page.goto(lead);
  await page.getByRole("button", { name: "Mark as opted out" }).click();
  await page.getByRole("group", { name: "Mark as opted out" }).getByRole("button", { name: "Mark as opted out" }).click();
  await expect(page.getByText("Opted out").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Create quote" })).toHaveCount(0);
});

test("9. Orders, overview and admin activity add up", async () => {
  await page.goto(`${appBase}/orders?tab=orders`);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody").getByText("Paid")).toHaveCount(2);
  await page.goto(appBase);
  await expect(page.getByText("Nothing needs you right now.").or(page.getByText("Order form not signed"))).toBeVisible();
  await page.goto(`/sadmin`);
  await expect(page.getByText("account.went_live").or(page.getByText(/went live/i)).first()).toBeVisible();
});

test("10. Agent in the test lab (live model, opt-in)", async () => {
  test.skip(process.env.E2E_AGENT !== "1", "E2E_AGENT=1 runs the live agent (uses the Anthropic API).");
  await page.goto(`${appBase}/setup/test-lab`);
  await page.getByRole("button", { name: "Start" }).click();
  const send = async (text: string) => {
    await page.locator("#lab-text").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("The agent is replying…")).toHaveCount(0, { timeout: 180_000 });
  };
  await send("Hi, we run 2 restaurant kitchens with 6 fridges. How much would monitoring cost?");
  await expect(page.locator(".sas-msg--agent").last()).toBeVisible();
  await send("Business type: restaurant, 2 sites, I am the owner and decide. Please send the order form.");
  await expect(page.getByText(/order_form\.send|quote\.create/).first()).toBeVisible();
});
