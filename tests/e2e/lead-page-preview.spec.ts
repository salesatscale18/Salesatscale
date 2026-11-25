/**
 * The add/edit form's live preview in a real browser: the real form shell, address slots, banner field
 * and preview (served from tests/fixtures/lead-page-preview-harness.tsx by tests/e2e/helpers/harness.ts),
 * with stand-in preview data. The server's data (the real opener, texts, voice gate) is checked on PGlite
 * in tests/integration/lead-pages-preview.test.tsx.
 *
 * Checks: the preview follows the fields, the language and the connection without saving; a tab keeps its
 * place while the form changes, and a change to another tab puts a dot on it until it is opened; the chosen
 * banner file shows on the hand-over before upload (whole, at most 40% of the frame); nothing in the frame
 * can be focused or used; the address field's keyboard order follows what shows; on a phone the preview
 * opens from a "Preview" button as a sheet, with no sideways scrolling.
 */
import { expect, test, type Page } from "@playwright/test";
import { startHarness, type Harness } from "./helpers/harness";

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness("tests/fixtures/lead-page-preview-harness.tsx", [
    "components/sas/sas.css", "app/chat/[token]/chat.css", "app/p/[key]/lead-page.css", "app/app/[account]/lead-pages/lead-pages.css",
  ]);
});
test.afterAll(async () => { await harness?.close(); });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const open = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(harness.url);
  await page.locator("[data-preview-panel]").waitFor();
};
const screen = (page: Page) => page.locator(".lpv-screen");
const tab = (page: Page, t: string) => page.locator(`[data-preview-tab="${t}"]`);

test("follows the fields, the language and the connection as they are edited", async ({ page }) => {
  await open(page);
  await expect(screen(page)).toContainText("Full name");
  await expect(screen(page).locator('input[name="company"]')).toHaveCount(0);
  await page.getByLabel("Company").check();
  await expect(screen(page).locator('input[name="company"]')).toHaveCount(1);
  await expect(screen(page).locator('input[name="consent"]')).toBeChecked();
  await page.getByLabel("Tick the consent box").uncheck();
  await expect(screen(page).locator('input[name="consent"]')).not.toBeChecked();
  await expect(page.locator("[data-preview-note]")).toHaveText("On your page it takes your page's font.");
  await page.getByLabel("Language").selectOption("he");
  await expect(screen(page).locator('[lang="he"][dir="rtl"]')).toHaveCount(1);
  await expect(screen(page)).toContainText("שם מלא");
  // A market without a notice in this language: no privacy link.
  await page.getByLabel("Language").selectOption("en");
  await expect(screen(page).locator(".lp-link")).toHaveCount(1);
  await page.getByLabel("Market").selectOption("m2");
  await expect(screen(page).locator(".lp-link")).toHaveCount(0);
  await page.getByLabel("Your own form").check();
  await expect(screen(page)).toHaveText("Your own form stays as it is.");
  await expect(page.locator("[data-preview-after]:visible")).toHaveText("You get your form's address when you save.");
  await page.getByLabel("Button or link").check();
  await expect(screen(page).locator(".lp-tile")).toHaveText("PD");
  // First message: the topic and the language chosen.
  await tab(page, "first").click();
  await expect(screen(page).locator("[data-preview-opener]")).toHaveText("en: opener fridges");
  await page.getByLabel("Opening topic").selectOption("1");
  await expect(screen(page).locator("[data-preview-opener]")).toHaveText("en: opener cold rooms");
});

test("a tab keeps its place while the form changes; a change to another tab puts a dot on it until it is opened", async ({ page }) => {
  await open(page);
  await tab(page, "handover").click();
  await expect(tab(page, "handover")).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Email").check();
  // Still on the hand-over; the form changed: a dot on Form only.
  await expect(tab(page, "handover")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "form")).toHaveAttribute("data-dot", "");
  await expect(tab(page, "form")).toHaveAccessibleName("Form (changed)");
  await expect(tab(page, "first")).not.toHaveAttribute("data-dot", "");
  await tab(page, "form").click();
  await expect(tab(page, "form")).not.toHaveAttribute("data-dot", "");
  // On Form (our form on your page, no banner there): a banner marks the hand-over only.
  await page.locator('input[type="file"][name="banner"]').setInputFiles({ name: "offer.png", mimeType: "image/png", buffer: PNG });
  await expect(tab(page, "handover")).toHaveAttribute("data-dot", "");
  await expect(tab(page, "first")).not.toHaveAttribute("data-dot", "");
  await expect(tab(page, "form")).toHaveAttribute("aria-selected", "true");
  // The topic marks First message.
  await page.getByLabel("Opening topic").selectOption("");
  await expect(tab(page, "first")).toHaveAttribute("data-dot", "");
  // Arrow keys move between the tabs.
  await tab(page, "form").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "handover")).toBeFocused();
  await expect(tab(page, "handover")).toHaveAttribute("aria-selected", "true");
});

test("the chosen banner file shows on the hand-over before upload: whole, at most 40% of the frame, nothing over it", async ({ page }) => {
  await open(page);
  await tab(page, "handover").click();
  await expect(screen(page).locator(".lp-tile")).toHaveCount(1);
  await page.locator('input[type="file"][name="banner"]').setInputFiles({ name: "offer.png", mimeType: "image/png", buffer: PNG });
  const img = screen(page).locator(".lp-banner img");
  await expect(img).toHaveAttribute("src", /^blob:/);
  const shown = await img.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fit: s.objectFit, max: s.maxHeight, siblings: el.parentElement!.children.length };
  });
  expect(shown).toEqual({ fit: "contain", max: "240px", siblings: 1 });
  await expect(screen(page).locator(".lp-tile")).toHaveCount(0);
  await expect(screen(page)).toContainText("Thanks, Dana");
  await expect(screen(page).locator("[data-handover-talk]")).toBeEnabled();
  await expect(screen(page).locator("[data-handover-write]")).toBeEnabled();
  // "Don't use it": the tile again.
  await page.getByRole("button", { name: "Don't use it" }).click();
  await expect(screen(page).locator(".lp-tile")).toHaveCount(1);
});

test("nothing in the frame can be focused or used; the address's keyboard order follows what shows", async ({ page }) => {
  await open(page);
  await page.getByLabel("Button or link").check();
  // Inert: no focus, a click does nothing.
  await screen(page).locator('input[name="name"]').evaluate((el: HTMLInputElement) => el.focus());
  expect(await page.evaluate(() => document.activeElement?.closest(".lpv-screen") ?? null)).toBeNull();
  await screen(page).locator(".lp-btn").click({ force: true });
  await expect(page).toHaveURL(harness.url);
  // Button or link: Name, Market, Language, then the address.
  await page.locator('form input[name="name"]').focus();
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => (document.activeElement as HTMLInputElement).name));
  }
  expect(order).toEqual(["marketId", "language", "address"]);
  // What was typed moves with it.
  await page.locator('input[name="address"]').fill("example.com/offer");
  await page.getByLabel("Our form on your page").check();
  await expect(page.locator('input[name="address"]')).toHaveValue("example.com/offer");
  await page.locator('form input[name="name"]').focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).name)).toBe("address");
});

test("on a phone the preview opens from a Preview button as a sheet; no sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness.url);
  const toggle = page.locator("[data-preview-toggle]");
  await expect(toggle).toBeVisible();
  await expect(page.locator("[data-preview-sheet]")).toBeHidden();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await toggle.click();
  await expect(page.getByRole("dialog", { name: "Preview" })).toBeVisible();
  await expect(page.locator("[data-preview-close]")).toBeFocused();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await tab(page, "handover").click();
  await expect(screen(page)).toContainText("Thanks, Dana");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-preview-sheet]")).toBeHidden();
  await expect(toggle).toBeFocused();
});
