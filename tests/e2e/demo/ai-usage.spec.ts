import { test } from "@playwright/test";
// Free: read this month's AI usage from Admin › Operations (estimated from token counts, as the budget guard counts it).
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD.");
test("AI usage this month (free)", async ({ page }) => {
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
  await page.goto("/sadmin/operations");
  await page.waitForLoadState("networkidle");
  const text = await page.locator("body").innerText();
  for (const line of text.split("\n")) if (/\$|budget|usage|AI|model/i.test(line)) console.log("OPS:", line.trim());
});
