import { expect, test } from "@playwright/test";

// Needs Clerk keys (a Clerk development instance) in the environment: every
// page sits under ClerkProvider. CI runs this job only when they are set.

test("landing page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
});

test("terms page renders", async ({ page }) => {
  const res = await page.goto("/terms");
  expect(res?.status()).toBe(200);
});

test("design preview is not shown to signed-out visitors", async ({ page }) => {
  await page.goto("/sadmin/design");
  await expect(page.getByRole("heading", { name: "Design system" })).toHaveCount(0);
});
