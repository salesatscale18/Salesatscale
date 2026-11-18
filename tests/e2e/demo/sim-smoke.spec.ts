import { expect, test } from "@playwright/test";
// Free check of the buyer simulator on prod: demo account → simulated buyer → Start conversation (fixed opener, no model call) → buyer page shows it. Never types as the buyer (that would call the model).
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "/tmp/claude-0/-home-user-Salesatscale/128c37fd-ff81-50fe-9c82-7ecbacf0855c/scratchpad/rehearsal";
test("simulator smoke (free)", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const base = new URL(test.info().project.use.baseURL ?? "https://salesatscale18.vercel.app");
  const onApp = (u: URL) => u.host === base.host;
  await page.goto("/app");
  await page.waitForLoadState("networkidle");
  if (!onApp(new URL(page.url()))) {
    await page.locator('input[name="identifier"]').fill(EMAIL);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((u) => onApp(u) || /client-trust|factor-two|verify/.test(u.pathname), { timeout: 60_000 });
    if (!onApp(new URL(page.url()))) {
      const code = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
      await page.waitForLoadState("networkidle"); await code.waitFor(); await page.waitForTimeout(1500);
      await code.pressSequentially("424242");
      await page.waitForURL(onApp, { timeout: 60_000 });
    }
  }
  await page.goto("/sadmin/accounts");
  await page.getByRole("button", { name: /Create demo account/i }).click();
  await page.waitForURL(/\/sadmin\/accounts\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const adminUrl = page.url();
  console.log("DEMO ADMIN:", adminUrl);
  console.log("NOTE:", (await page.locator("main").innerText()).slice(0, 600));
  await page.getByRole("button", { name: "Enter account" }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  const appBase = new URL(page.url()).pathname;
  console.log("APP:", appBase);
  await page.goto(`${appBase}/leads`);
  await page.getByRole("link", { name: /Rina Cohen/ }).first().click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/);
  const leadUrl = page.url();
  console.log("LEAD:", leadUrl);
  await expect(page.getByText("SIM-0001").first()).toBeVisible();
  await page.getByRole("button", { name: "Start conversation" }).click();
  await page.waitForLoadState("networkidle");
  const chatHref = await page.getByRole("link", { name: "Open buyer chat" }).first().getAttribute("href");
  console.log("CHAT:", chatHref);
  const buyer = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await buyer.goto(new URL(chatHref!, base).toString());
  await expect(buyer.getByText("the automated assistant of").first()).toBeVisible({ timeout: 20_000 });
  await expect(buyer.getByText("Simulated chat.").first()).toBeVisible();
  await buyer.screenshot({ path: `${SHOTS}/sim-smoke-buyer.png` });
  await page.screenshot({ path: `${SHOTS}/sim-smoke-lead.png`, fullPage: true });
});
