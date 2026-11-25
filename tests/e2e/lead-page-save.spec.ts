/**
 * Lead pages › Add a page: a save never looks silent (owner, 25 Nov: "I tried to save a lead draft and it
 * didn't work": the default card needs an address, the save was refused, and nothing moved at the bottom of
 * the form). Runs the real form shell, Save foot, field errors, address slots and preview (served from
 * tests/fixtures/lead-page-save-harness.tsx by tests/e2e/helpers/harness.ts) with a stand-in action, at a
 * laptop's 1366×657 and a phone's 390 px. The server action itself is covered on PGlite
 * (tests/integration/lead-pages-save-feedback.test.tsx).
 *
 * Checks: Save pressed at the bottom with an empty address brings the address field into view and focuses
 * it, with a line next to the buttons and a read-out; the line jumps back to the field; a refusal from the
 * server does the same, after a "Saving…" state with the buttons disabled and no second send; the required
 * marks follow the connection card; on a phone the preview sheet keeps "Close preview" in view, keeps focus
 * inside, gives it back, and the Preview button never sits on the Save buttons.
 * Set LP_SHOTS_DIR to also save screenshots.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/harness";

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness("tests/fixtures/lead-page-save-harness.tsx", [
    "components/sas/sas.css", "app/chat/[token]/chat.css", "app/p/[key]/lead-page.css", "app/app/[account]/lead-pages/lead-pages.css",
  ]);
});
test.afterAll(async () => { await harness?.close(); });
// Each test sets its own window size (1366×657, 390×844); the mobile project's emulation would lay the harness page
// (which has no viewport meta) out at 980 px, so these run in the desktop project only.
test.skip(({ isMobile }) => isMobile, "window sizes are set per test");

const shots = process.env.LP_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

const SIZES = [
  { name: "laptop", width: 1366, height: 657 },
  { name: "phone", width: 390, height: 844 },
] as const;

const open = async (page: Page, size: { width: number; height: number }) => {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.goto(harness.url);
  await page.locator("[data-save-foot]").waitFor();
};
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
const address = (page: Page) => page.locator('input[name="address"]');
const saveDraft = (page: Page) => page.getByRole("button", { name: "Save draft" });

for (const size of SIZES) {
  test(`${size.name}: Save at the bottom with only a name: the address field comes into view, focused, and the line says why`, async ({ page }) => {
    await open(page, size);
    await page.locator('form input[name="name"]').fill("Spring offer");
    await saveDraft(page).scrollIntoViewIfNeeded();
    await expect(address(page)).not.toBeInViewport();
    // Nothing covers the Save buttons (the floating Preview button on a phone).
    for (const b of [saveDraft(page), page.getByRole("button", { name: "Go live" })]) {
      const hit = await b.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
      expect(hit).toBe(true);
    }
    await saveDraft(page).click();

    await expect(address(page)).toBeFocused();
    await expect(address(page)).toBeInViewport();
    await expect(page.locator('[data-field-error="address"]')).toHaveText("Enter the address of the page the form is on.");
    await expect(page.locator('[data-field-error="address"]')).toBeInViewport();
    await expect(page.locator("[data-form-errors]")).toHaveText("Check the fields marked below.");
    await expect(page.locator("[data-save-error]")).toHaveText("Not saved: 1 field needs a fix. First: Address of your page.");
    await expect(page.locator("[data-save-announce]")).toHaveText("Not saved: 1 field needs a fix. First: Address of your page.");
    // Checked before sending: nothing went to the server.
    expect(await sent(page)).toEqual([]);
    await shot(page, `save-refused-${size.name}`);

    // The line next to the buttons takes the seller back to the field.
    await page.locator("[data-save-error]").scrollIntoViewIfNeeded();
    await page.locator("[data-save-error]").click();
    await expect(address(page)).toBeFocused();
    await expect(address(page)).toBeInViewport();

    // Fixed: saved.
    await address(page).fill("example.com/offer");
    await saveDraft(page).click();
    await expect(page.locator("body")).toHaveAttribute("data-saved", "draft:Spring offer");
  });
}

test("empty name and address: two fields, the first one (Name) focused", async ({ page }) => {
  await open(page, SIZES[0]);
  await saveDraft(page).click();
  await expect(page.locator('form input[name="name"]')).toBeFocused();
  await expect(page.locator('form input[name="name"]')).toBeInViewport();
  await expect(page.locator("[data-save-error]")).toHaveText("Not saved: 2 fields need a fix. First: Name.");
});

test("a refusal from the server: Saving… with the buttons disabled, one send only, then the field focused", async ({ page }) => {
  await open(page, SIZES[0]);
  await page.locator('form input[name="name"]').fill("Server says no");
  await address(page).fill("example.com/offer");
  await saveDraft(page).click();
  await expect(saveDraft(page)).toHaveCount(0);
  const busy = page.locator('[data-save-foot] button[value="draft"]');
  await expect(busy).toHaveText("Saving…");
  await expect(busy).toBeDisabled();
  await expect(page.locator('[data-save-foot] button[value="live"]')).toBeDisabled();
  await busy.click({ force: true }).catch(() => {});
  await page.locator("form").evaluate((f: HTMLFormElement) => f.requestSubmit());
  await shot(page, "save-pending-laptop");
  await expect(page.locator('[data-field-error="name"]')).toHaveText("Use another name.");
  await expect(page.locator('form input[name="name"]')).toBeFocused();
  await expect(page.locator("[data-save-error]")).toHaveText("Not saved: 1 field needs a fix. First: Name.");
  await expect(saveDraft(page)).toBeEnabled();
  expect(await sent(page)).toHaveLength(1);
});

test("required marks follow the connection card; Button or link saves with a name only", async ({ page }) => {
  await open(page, SIZES[0]);
  const req = page.locator("[data-address-field] .lpg-req");
  await expect(req).toBeVisible();
  await expect(page.locator("[data-address-field] .lpg-field__label:visible")).toHaveText("Address of your page (required)");
  await expect(address(page)).toHaveAttribute("aria-required", "true");
  await page.getByText("Your own form", { exact: true }).click();
  await expect(page.locator("[data-address-field] .lpg-field__label:visible")).toHaveText("Address of the page with your form (recommended)");
  await expect(address(page)).not.toHaveAttribute("aria-required", "true");
  await page.getByText("Button or link", { exact: true }).click();
  await expect(page.locator("[data-address-field] .lpg-field__label:visible")).toHaveText("Address of the page with the button (optional)");
  await expect(req).toBeHidden();
  await expect(page.locator(".lpg-field__label:visible", { hasText: "Name" })).toHaveText("Name (required)");
  await page.locator('form input[name="name"]').fill("Link page");
  await saveDraft(page).click();
  await expect(page.locator("body")).toHaveAttribute("data-saved", "draft:Link page");
  await expect(page.locator("[data-save-error]")).toHaveCount(0);
});

test("phone: the preview sheet keeps Close preview in view, keeps focus inside and gives it back; the Save buttons are usable after", async ({ page }) => {
  await open(page, SIZES[1]);
  const toggle = page.locator("[data-preview-toggle]");
  await toggle.click();
  const sheet = page.locator("[data-preview-sheet]");
  const close = page.getByRole("button", { name: "Close preview" });
  await expect(sheet).toBeVisible();
  await expect(close).toBeFocused();
  // The sheet covers the whole screen (the Save buttons are not reachable under it).
  const box = await sheet.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  // Scrolled to its end, Close preview is still at the top.
  await sheet.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(close).toBeInViewport();
  const top = await close.boundingBox();
  expect(top!.y).toBeLessThan(60);
  await shot(page, "preview-sheet-scrolled-phone");
  // Tab and Shift+Tab stay inside the sheet.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-preview-sheet]"))).toBe(true);
  }
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("[data-preview-sheet]"))).toBe(true);
  await close.click();
  await expect(sheet).toBeHidden();
  await expect(toggle).toBeFocused();
  // Back on the form: Save at the bottom works as on a laptop.
  await page.locator('form input[name="name"]').fill("Spring offer");
  await saveDraft(page).click();
  await expect(address(page)).toBeFocused();
  await expect(address(page)).toBeInViewport();
});
