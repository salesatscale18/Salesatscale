import { expect, test } from "@playwright/test";
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
test("check models (free Models API)", async ({ page }) => {
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
  await page.getByRole("button", { name: /Check models/i }).click();
  await page.waitForTimeout(8000);
  await page.reload();
  const text = await page.locator("main").innerText();
  console.log("=== OPERATIONS ===\n" + text.slice(0, 3000));
  await page.screenshot({ path: "/tmp/claude-0/-home-user-Salesatscale/128c37fd-ff81-50fe-9c82-7ecbacf0855c/scratchpad/rehearsal/ops-models.png", fullPage: true });
  expect(text.length).toBeGreaterThan(0);
});
