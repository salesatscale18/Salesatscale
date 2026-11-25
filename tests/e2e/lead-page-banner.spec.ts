/**
 * The add/edit form's banner field in a real browser (owner test, 25 Nov: "after Choose image
 * the placeholder stays empty", and the image was gone after the form came back with errors).
 * Runs the real form shell and BannerField (served from tests/fixtures/lead-page-banner-harness.tsx by
 * tests/e2e/helpers/harness.ts, through vitest's Vite API: no reliance on a transitive package)
 * with a stand-in action that refuses an empty name, not the Next app (that needs a database
 * and Clerk). The server action's own checks are covered on PGlite in
 * tests/integration/lead-pages-seller.test.tsx.
 *
 * Checks: the chosen image shows at once with its name and size; a wrong type and a too-large
 * file are refused with a message and never sent; after a save refused for an empty name the
 * error shows and the image is still chosen (the file input keeps its file); fixing the name
 * saves with the banner. Set LP_SHOTS_DIR to also save screenshots.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/harness";

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness("tests/fixtures/lead-page-banner-harness.tsx", ["components/sas/sas.css", "app/app/[account]/lead-pages/lead-pages.css"]);
});
test.afterAll(async () => { await harness?.close(); });

// A real 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("choose image → preview; wrong type and too large refused; kept through a refused save; saved once the name is fixed", async ({ page }) => {
  await page.goto(harness.url);
  await page.locator('input[type="file"][name="banner"]').waitFor({ state: "attached" });
  const file = page.locator('input[type="file"][name="banner"]');
  const shots = process.env.LP_SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });

  // A wrong type: refused with a message, the input emptied, nothing previewed.
  await file.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator("[data-banner-problem]")).toHaveText("This file is not a JPG, PNG or WebP image. Choose another one.");
  expect(await file.evaluate((i: HTMLInputElement) => i.files?.length ?? 0)).toBe(0);
  await expect(page.locator("[data-banner-preview]")).toHaveCount(0);

  // Too large: refused with its size.
  await file.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024, 1) });
  await expect(page.locator("[data-banner-problem]")).toHaveText("This image is 3.0 MB. Choose one up to 2 MB.");
  expect(await file.evaluate((i: HTMLInputElement) => i.files?.length ?? 0)).toBe(0);

  // A good image: previewed at once, with its name and size.
  await file.setInputFiles({ name: "offer-banner.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("[data-banner-problem]")).toHaveCount(0);
  await expect(page.locator('[data-banner="chosen"] img[data-banner-preview]')).toBeVisible();
  await expect(page.locator("[data-banner-chosen]")).toHaveText(`Chosen: offer-banner.png, 1 KB. It is saved when you save the page.`);
  expect(await page.locator("[data-banner-preview]").evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("contain");
  await expect(page.locator(".lpg-file")).toContainText("Replace");
  if (shots) await page.screenshot({ path: join(shots, "banner-chosen.png") });

  // Save with an empty name (and "Button or link"): refused before sending; the error shows, the image is still chosen.
  await page.getByLabel("Button or link").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator('[data-field-error="name"]')).toHaveText("Enter a name for the page.");
  await expect(page.getByLabel("Name")).toBeFocused();
  await expect(page.locator("[data-form-errors]")).toHaveText("Check the fields marked below.");
  expect(await file.evaluate((i: HTMLInputElement) => i.files?.[0]?.name ?? null)).toBe("offer-banner.png");
  await expect(page.locator("[data-banner-preview]")).toBeVisible();
  await expect(page.locator("[data-banner-again]")).toHaveCount(0);
  expect(await page.locator('input[name="connection"]:checked').getAttribute("value")).toBe("link");
  if (shots) await page.screenshot({ path: join(shots, "banner-after-error.png") });

  // Fix the name and save: the banner goes with it.
  await page.getByLabel("Name").fill("Spring offer");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-saved", "banner:offer-banner.png");
  const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
  expect(sent).toEqual([
    { name: "Spring offer", connection: "link", banner: { name: "offer-banner.png", size: PNG.length } },
  ]);
});

test("errors arriving with a fresh form (file gone, card back to the default): the card is checked again and the image asked for again", async ({ page }) => {
  await page.goto(harness.url);
  await page.locator('input[type="file"][name="banner"]').waitFor({ state: "attached" });
  const file = page.locator('input[type="file"][name="banner"]');
  await file.setInputFiles({ name: "offer-banner.png", mimeType: "image/png", buffer: PNG });
  await page.getByLabel("Button or link").check();
  await page.getByLabel("Name").fill("Server says no");
  await page.getByRole("button", { name: "Save draft" }).click();
  // While the save runs, simulate what a full page load leaves: no file, the default card checked.
  await page.evaluate(() => {
    (document.querySelector('input[name="banner"]') as HTMLInputElement).value = "";
    (document.querySelector('input[name="connection"][value="snippet"]') as HTMLInputElement).checked = true;
  });
  await expect(page.locator('[data-field-error="name"]')).toBeVisible();
  await expect(page.locator("[data-banner-again]")).toHaveText("The image was not kept. Choose it again.");
  expect(await page.locator('input[name="connection"]:checked').getAttribute("value")).toBe("link");
  // Choosing it again clears the message.
  await file.setInputFiles({ name: "offer-banner.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("[data-banner-again]")).toHaveCount(0);
});

test("Don't use it clears the chosen image", async ({ page }) => {
  await page.goto(harness.url);
  await page.locator('input[type="file"][name="banner"]').waitFor({ state: "attached" });
  const file = page.locator('input[type="file"][name="banner"]');
  await file.setInputFiles({ name: "a.webp", mimeType: "image/webp", buffer: PNG });
  await expect(page.locator("[data-banner-chosen]")).toBeVisible();
  await page.getByRole("button", { name: "Don't use it" }).click();
  await expect(page.locator("[data-banner-chosen]")).toHaveCount(0);
  await expect(page.locator('[data-banner="none"]')).toBeVisible();
  expect(await file.evaluate((i: HTMLInputElement) => i.files?.length ?? 0)).toBe(0);
});
