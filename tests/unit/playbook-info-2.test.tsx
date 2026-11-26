/**
 * Playbook part views after the (i) pass, UX review (26 Nov): the label column fits the longest label
 * on one line with its (i) right after the text; the (i) on "Where the answer is used" prefers a side
 * that does not cover the role tags it explains (placeInfoTip's `prefer` / `explains`, pure); on a
 * phone the preview button is a slim bar at the bottom edge, with the part padded clear of it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoTip, placeInfoTip, type Box } from "@/components/sas/info-tip";

const pbCss = fs.readFileSync(path.join(process.cwd(), "app/app/[account]/setup/playbook/playbook.css"), "utf8");
const at = (left: number, top: number): Box => ({ left, top, right: left + 24, bottom: top + 24 });
const covers = (p: { left: number; top: number; width: number; maxHeight?: number }, h: number, b: Box) =>
  p.left < b.right && b.left < p.left + p.width && p.top < b.bottom && b.top < p.top + (p.maxHeight ?? h);

describe("placeInfoTip: a preferred placement, and never over what the (i) explains", () => {
  const vp = { width: 1440, height: 900 };
  const size = { width: 360, height: 200 };
  // The column header's (i) at the end of "Where the answer is used"; the first rows' role tags under it.
  const anchor = at(1100, 400);
  const tags: Box[] = [{ left: 950, top: 440, right: 1126, bottom: 464 }, { left: 950, top: 500, right: 1126, bottom: 524 }];

  it("without a preference it goes below, over the role tags (what this fixes)", () => {
    const p = placeInfoTip({ anchor, size, viewport: vp });
    expect(p.side).toBe("below");
    expect(tags.some((t) => covers(p, 200, t))).toBe(true);
  });
  it("prefer above: above the header, clear of the tags", () => {
    const p = placeInfoTip({ anchor, size, viewport: vp, prefer: "above", explains: tags });
    expect(p).toEqual({ side: "above", left: 1072, top: 400 - 6 - 200, width: 360 });
    expect(tags.some((t) => covers(p, 200, t))).toBe(false);
  });
  it("explains alone (no preference): the first placement clear of them, not below over them", () => {
    const p = placeInfoTip({ anchor, size, viewport: vp, explains: tags });
    expect(p.side).toBe("above");
    expect(tags.some((t) => covers(p, 200, t))).toBe(false);
  });
  it("no room above (the header near the top of the screen): beside the (i) on its start side, still clear of the tags", () => {
    const high = at(1100, 60);
    const under: Box[] = [{ left: 1100, top: 100, right: 1180, bottom: 124 }];
    const p = placeInfoTip({ anchor: high, size, viewport: vp, prefer: "above", explains: under });
    expect(p).toEqual({ side: "start", left: 1100 - 6 - 360, top: 60, width: 360 });
    expect(covers(p, 200, under[0])).toBe(false);
  });
  it("prefer start: beside the button on the inline-start side (the right in RTL)", () => {
    expect(placeInfoTip({ anchor, size, viewport: vp, prefer: "start" })).toEqual({ side: "start", left: 1100 - 6 - 360, top: 400, width: 360 });
    expect(placeInfoTip({ anchor: at(300, 400), size, viewport: vp, prefer: "start", rtl: true })).toEqual({ side: "start", left: 324 + 6, top: 400, width: 360 });
  });
  it("when nothing clear of what it explains fits, it is placed as without them (never over the row's controls)", () => {
    const everywhere: Box[] = [{ left: 0, top: 0, right: 1440, bottom: 900 }];
    const change = { left: 1100, top: 440, right: 1160, bottom: 462 };
    const plain = placeInfoTip({ anchor, size, viewport: vp, avoid: [change] });
    expect(placeInfoTip({ anchor, size, viewport: vp, avoid: [change], explains: everywhere })).toEqual(plain);
    expect(covers(plain, 200, change)).toBe(false);
  });
  it("the start side is only used where it fits beside the button (a phone): then above or below as usual", () => {
    const p = placeInfoTip({ anchor: at(200, 400), size: { width: 360, height: 120 }, viewport: { width: 390, height: 844 }, prefer: "start" });
    expect(p.side).toBe("below");
  });
});

describe("InfoTip markup: preference and what it explains, for the measuring code", () => {
  it("are data attributes on the (i)'s wrapper", () => {
    const html = renderToStaticMarkup(<InfoTip label="Where the answer is used" wide prefer="above" explains="[data-role-tag]">Roles</InfoTip>);
    expect(html).toContain('<span class="sas-info" data-info-explains="[data-role-tag]" data-info-prefer="above">');
    expect(renderToStaticMarkup(<InfoTip label="Tone">x</InfoTip>)).toMatch(/^<span class="sas-info">/);
  });
});

describe("Playbook rows: label column", () => {
  it("is wide enough for the longest label with its (i) on one line (\"Discount without approval\" + (i): 198px)", () => {
    const m = pbCss.match(/\n\.pb-row \{ display: grid; grid-template-columns: (\d+)px minmax\(0, 1fr\) auto;/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(198);
    expect(Number(m![1])).toBeLessThanOrEqual(216);
  });
  it("puts the (i) inline right after the label text, not at the column's far edge", () => {
    expect(pbCss).toMatch(/\.pb-row__label--info \{ display: block; \}/);
    expect(pbCss).not.toMatch(/\.pb-row__label--info \{[^}]*display: flex/);
    expect(pbCss).toMatch(/\.pb-row__label--info \.sas-info \{ margin: 0; margin-inline-start: 2px;/);
  });
  it("on a phone the label still stacks above the value", () => {
    expect(pbCss).toMatch(/@media \(max-width: 767px\) \{\n  \.pb-row \{ grid-template-columns: minmax\(0, 1fr\) auto;[^}]*\}\n  \.pb-row__label \{ grid-column: 1; \}\n  \.pb-row__value \{ grid-column: 1 \/ -1; grid-row: 2; \}/);
  });
});

describe("Phone: the preview button is a slim bar at the bottom edge", () => {
  const block = pbCss.slice(pbCss.indexOf("/* Phone: the \"Preview\" button is a slim bar"));
  const phone = block.slice(block.indexOf("@media (max-width: 767px) {"));
  it("full width, docked at the bottom, safe-area aware", () => {
    expect(phone).toMatch(/\.pb-pv__toggle \{[^}]*inset-inline: 0; inset-block-end: 0; width: 100%;[^}]*min-height: 44px;[^}]*env\(safe-area-inset-bottom, 0px\)/);
  });
  it("the part is padded by more than the bar, and focus scrolls clear of it (an open row's Save / Cancel)", () => {
    const pad = phone.match(/\.pb-part-layout\[data-with-preview\] \{ padding-block-end: calc\((\d+)px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
    expect(pad).not.toBeNull();
    // The bar: 44px tall at least (8px + 8px padding around a 20px line, or min-height); the padding leaves room under the last row.
    expect(Number(pad![1])).toBeGreaterThan(44 + 16);
    expect(phone).toMatch(/html:has\(\.pb-pv__toggle\) \{ scroll-padding-block-end: calc\(\d+px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  });
});
