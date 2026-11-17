import { expect, test } from "@playwright/test";
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "/tmp/claude-0/-home-user-Salesatscale/128c37fd-ff81-50fe-9c82-7ecbacf0855c/scratchpad/rehearsal";
test("switch Polar Demo to the Twilio WhatsApp sandbox number", async ({ page }) => {
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
  // Enter the account as super admin.
  await page.goto("/sadmin/accounts/8a53bd0b-11e0-4508-8547-0d480125dec4");
  await page.getByRole("button", { name: "Enter account" }).click();
  await page.waitForURL(/\/app\/polar-demo/);
  await page.goto("/app/polar-demo/settings?section=whatsapp");
  // Remove the +972 number (not a WhatsApp sender in Twilio). Rows are listed in order; +972 is first.
  const before = await page.locator("main").innerText();
  if (before.includes("+972535634674")) {
    await page.locator('form:has(input[name="connectionId"])').filter({ has: page.getByRole("button", { name: "Remove" }) }).first().getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState("networkidle");
  }
  const text = await page.locator("main").innerText();
  console.log("FINAL:", text.slice(0, 2000));
  await page.screenshot({ path: `${SHOTS}/F9-sandbox.png`, fullPage: true });
  expect(text).toContain("+14155238886");
  expect(text).not.toContain("+972535634674");
});
