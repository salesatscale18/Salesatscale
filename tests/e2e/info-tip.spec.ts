/**
 * The (i) button (components/sas/info-tip.tsx) in a real browser, on the harness in
 * tests/fixtures/info-tip-harness.tsx: hover and keyboard focus show the popover, a click or tap pins
 * it, Escape and a click or tap outside close it; it stays inside the viewport, is not cut off by a
 * panel's overflow, and never covers the row's Change. The states and placement as pure functions:
 * tests/unit/info-tip.test.tsx.
 */
import { expect, test, type Page } from "@playwright/test";
import { startHarness, type Harness } from "./helpers/harness";

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness("tests/fixtures/info-tip-harness.tsx", ["components/sas/sas.css"]);
});
test.afterAll(async () => { await harness?.close(); });

const open = async (page: Page) => {
  await page.goto(harness.url);
  await page.locator(".sas-info__btn").first().waitFor();
};
const btn = (page: Page, label: string) => page.getByRole("button", { name: `About: ${label}` });
const pop = (page: Page, label: string) => page.locator(`[data-row="${label}"] [role="tooltip"]`);

test("hover shows it, leaving hides it; keyboard focus shows it; Escape closes it", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover is for a mouse");
  await open(page);
  await expect(pop(page, "Speaks as")).toBeHidden();
  await btn(page, "Speaks as").hover();
  await expect(pop(page, "Speaks as")).toBeVisible();
  await expect(btn(page, "Speaks as")).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(5, 5);
  await expect(pop(page, "Speaks as")).toBeHidden();
  // Keyboard: Tab from the button before it.
  await page.locator("[data-before]").focus();
  await page.keyboard.press("Tab");
  await expect(btn(page, "Speaks as")).toBeFocused();
  await expect(pop(page, "Speaks as")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop(page, "Speaks as")).toBeHidden();
  await expect(btn(page, "Speaks as")).toBeFocused();
  // On to the row's Change, then the next row's (i).
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(btn(page, "Discount without approval")).toBeFocused();
  await expect(pop(page, "Discount without approval")).toBeVisible();
});

test("a click pins it; a second click, Escape or a click outside closes it", async ({ page, isMobile }) => {
  test.skip(isMobile, "the tap is checked on the phone");
  await open(page);
  await btn(page, "Speaks as").click();
  await page.mouse.move(5, 5);
  await expect(pop(page, "Speaks as")).toBeVisible();
  await btn(page, "Speaks as").click();
  await expect(pop(page, "Speaks as")).toBeHidden();
  await btn(page, "Speaks as").click();
  await page.keyboard.press("Escape");
  await expect(pop(page, "Speaks as")).toBeHidden();
  await btn(page, "Speaks as").click();
  await page.locator("[data-outside]").click();
  await expect(pop(page, "Speaks as")).toBeHidden();
});

test("touch: a tap opens and pins it, a tap outside closes it; the hit area is 44px", async ({ page, isMobile }) => {
  test.skip(!isMobile, "touch only");
  await open(page);
  await btn(page, "Speaks as").tap();
  await expect(pop(page, "Speaks as")).toBeVisible();
  await page.locator("[data-outside]").tap();
  await expect(pop(page, "Speaks as")).toBeHidden();
  const hit = await btn(page, "Speaks as").evaluate((b) => {
    const after = getComputedStyle(b, "::after");
    const r = b.getBoundingClientRect();
    return r.width - 2 * parseFloat(after.left);
  });
  expect(hit).toBe(44);
});

test("inside the viewport, not cut off by the panel, never over the row's Change; flips above at the bottom", async ({ page }) => {
  await open(page);
  for (const label of ["Discount without approval", "Approved exceptions"]) {
    await btn(page, label).scrollIntoViewIfNeeded();
    await btn(page, label).click();
    const box = await pop(page, label).boundingBox();
    const change = await page.locator(`[data-change="${label}"]`).boundingBox();
    const vp = page.viewportSize()!;
    expect(box && change).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
    const overlaps = box!.x < change!.x + change!.width && change!.x < box!.x + box!.width && box!.y < change!.y + change!.height && change!.y < box!.y + box!.height;
    expect(overlaps).toBe(false);
    // The panel hides its overflow; the popover still shows whole (it is on top at its centre).
    const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[role="tooltip"]') !== null, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
    expect(top).toBe(true);
    await page.keyboard.press("Escape");
  }
  // Near the bottom of the screen it opens above the button.
  await btn(page, "Approved exceptions").evaluate((b) => b.scrollIntoView({ block: "end" }));
  await btn(page, "Approved exceptions").click();
  await expect(pop(page, "Approved exceptions")).toHaveAttribute("data-side", "above");
});
