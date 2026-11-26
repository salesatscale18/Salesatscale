/**
 * InfoTip (components/sas/info-tip.tsx): the (i) button's states (hover, keyboard focus, click pins,
 * Escape, a tap outside), its markup (a real button with "About: {label}", aria-expanded,
 * aria-controls / aria-describedby to the popover), its sizes (16px icon, 24px hit area, 44px on
 * touch) and where the popover goes (flips and clamps inside the viewport, never over the row's
 * Change control). The same behaviour in a real browser: tests/e2e/info-tip.spec.ts.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { INFO_TIP_CLOSED, InfoTip, infoTipNext, infoTipOpen, placeInfoTip, type InfoTipEvent } from "@/components/sas/info-tip";

const run = (...events: InfoTipEvent[]) => events.reduce(infoTipNext, INFO_TIP_CLOSED);
const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");

describe("InfoTip states", () => {
  it("hover shows it; leaving hides it", () => {
    expect(infoTipOpen(run("enter"))).toBe(true);
    expect(infoTipOpen(run("enter", "leave"))).toBe(false);
  });
  it("keyboard focus shows it; blur hides it", () => {
    expect(infoTipOpen(run("focus"))).toBe(true);
    expect(infoTipOpen(run("focus", "blur"))).toBe(false);
  });
  it("a click pins it: it stays open when the pointer and focus leave", () => {
    const s = run("enter", "focus", "click", "leave", "blur");
    expect(s.pinned).toBe(true);
    expect(infoTipOpen(s)).toBe(true);
  });
  it("a tap (no hover) opens and pins it; a second tap closes it", () => {
    expect(infoTipOpen(run("click"))).toBe(true);
    expect(infoTipOpen(run("focus", "click"))).toBe(true);
    expect(infoTipOpen(run("focus", "click", "click"))).toBe(false);
  });
  it("Escape closes it, even while hovered and focused; it opens again once the pointer or focus comes back", () => {
    const s = run("enter", "focus", "click", "escape");
    expect(infoTipOpen(s)).toBe(false);
    expect(infoTipOpen(infoTipNext(infoTipNext(s, "leave"), "enter"))).toBe(false); // focus still on it, closed by Escape
    expect(infoTipOpen([("blur" as const), ("leave" as const), ("enter" as const)].reduce(infoTipNext, s))).toBe(true);
  });
  it("a click or tap outside closes a pinned one", () => {
    expect(infoTipOpen(run("click", "blur", "outside"))).toBe(false);
  });
});

describe("InfoTip markup", () => {
  const html = renderToStaticMarkup(<InfoTip label="Speaks as">Grammar only, for languages like Hebrew.</InfoTip>);
  it("is a real button named \"About: {label}\" that controls and describes its popover (closed: hidden, still in the DOM)", () => {
    const m = html.match(/<button type="button" class="sas-info__btn" aria-label="About: Speaks as" aria-expanded="false" aria-controls="([^"]+)" aria-describedby="([^"]+)">/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(html).toContain(`<span id="${m![1]}" role="tooltip" class="sas-info__pop" hidden="">Grammar only, for languages like Hebrew.</span>`);
    expect(html).toMatch(/<svg[^>]*lucide-info/);
  });
  it("wide content gets the wider popover; a fixed popover id can be given", () => {
    const wide = renderToStaticMarkup(<InfoTip label="Questions before it recommends" wide popoverId="pb-q-hint">Text</InfoTip>);
    expect(wide).toContain('aria-controls="pb-q-hint" aria-describedby="pb-q-hint"');
    expect(wide).toContain('id="pb-q-hint" role="tooltip" class="sas-info__pop sas-info__pop--wide"');
  });
  it("sizes: 16px icon, 24px hit area, 44px on touch screens; 13px text, ~280px (wide ~360px); no motion when reduced", () => {
    expect(css).toMatch(/\.sas-info__btn \{[^}]*width: 24px; height: 24px;/);
    expect(css).toMatch(/\.sas-info__btn \.sas-ico \{ width: 16px; height: 16px; \}/);
    // 24px + 2 × 10px = 44px.
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.sas-info__btn::after \{ content: ""; position: absolute; inset: -10px; \} \}/);
    expect(css).toMatch(/\.sas-info__pop \{[^}]*max-width: min\(280px, calc\(100vw - 16px\)\);[^}]*font: 400 13px\/19px/);
    expect(css).toMatch(/\.sas-info__pop--wide \{ max-width: min\(360px, calc\(100vw - 16px\)\); \}/);
    expect(css).toMatch(/\.sas-info__pop\[hidden\] \{ display: none; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.sas-info__pop \{ animation: none; \} \}/);
  });
});

describe("placeInfoTip (edge flip and clamp)", () => {
  const vp = { width: 1440, height: 900 };
  const at = (left: number, top: number) => ({ left, top, right: left + 24, bottom: top + 24 });
  it("below the button, starting just before it", () => {
    const p = placeInfoTip({ anchor: at(300, 200), size: { width: 280, height: 80 }, viewport: vp });
    expect(p).toEqual({ side: "below", left: 292, top: 230, width: 280 });
  });
  it("flips above near the bottom of the viewport", () => {
    const p = placeInfoTip({ anchor: at(300, 840), size: { width: 280, height: 80 }, viewport: vp });
    expect(p.side).toBe("above");
    expect(p.top).toBe(840 - 6 - 80);
  });
  it("clamps at the right edge, and at 390 it is never wider than the screen", () => {
    expect(placeInfoTip({ anchor: at(1400, 200), size: { width: 280, height: 80 }, viewport: vp }).left).toBe(1440 - 280 - 8);
    const phone = placeInfoTip({ anchor: at(350, 200), size: { width: 400, height: 120 }, viewport: { width: 390, height: 844 } });
    expect(phone.width).toBe(374);
    expect(phone.left).toBe(8);
    expect(phone.left + phone.width).toBeLessThanOrEqual(390 - 8);
  });
  it("clamps at the left edge (RTL rows start there)", () => {
    expect(placeInfoTip({ anchor: at(2, 200), size: { width: 280, height: 80 }, viewport: vp }).left).toBe(8);
  });
  const covers = (p: { left: number; top: number; width: number; maxHeight?: number }, h: number, b: { left: number; top: number; right: number; bottom: number }) =>
    p.left < b.right && b.left < p.left + p.width && p.top < b.bottom && b.top < p.top + (p.maxHeight ?? h);
  it("never over the row's Change control: moved sideways off it, else to the other side", () => {
    const change = { left: 300, top: 240, right: 360, bottom: 262 };
    const p = placeInfoTip({ anchor: at(300, 200), size: { width: 280, height: 80 }, viewport: vp, avoid: [change] });
    expect(covers(p, 80, change)).toBe(false);
    expect(p).toEqual({ side: "below", left: 14, top: 230, width: 280 });
    // No room sideways (a phone): above the button.
    const phone = placeInfoTip({ anchor: at(100, 400), size: { width: 360, height: 80 }, viewport: { width: 390, height: 844 }, avoid: [{ left: 20, top: 440, right: 380, bottom: 488 }] });
    expect(phone.side).toBe("above");
    expect(phone.top).toBe(400 - 6 - 80);
  });
  it("a phone, a tall popover and the stepper under the label: under the stepper, shortened to fit (its content scrolls)", () => {
    const stepper = { left: 16, top: 470, right: 180, bottom: 518 };
    const p = placeInfoTip({ anchor: at(300, 420), size: { width: 360, height: 484 }, viewport: { width: 390, height: 844 }, avoid: [stepper] });
    expect(covers(p, 484, stepper)).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + (p.maxHeight ?? 484)).toBeLessThanOrEqual(844 - 8);
  });
  it("with no room on either side: shortened on the side with room (at least 120px)", () => {
    const p = placeInfoTip({ anchor: at(300, 100), size: { width: 280, height: 400 }, viewport: { width: 390, height: 500 } });
    expect(p).toEqual({ side: "below", left: 102, top: 130, width: 280, maxHeight: 362 });
  });
});
