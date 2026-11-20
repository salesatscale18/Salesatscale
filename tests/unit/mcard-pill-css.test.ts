/**
 * Overview market cards: a status pill on the coloured map panel has a white
 * ground (UX), after and more specific than the blue Live pill rule, so the
 * Live pill keeps its blue text and icon there.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../../components/sas/sas.css"), "utf8");

describe("market card pills", () => {
  it("a white background on .sas-mcard__pill pills, declared after the blue Live rule", () => {
    const live = css.indexOf('.sas-ov2-pill--live, .sas-pill[data-status="market.live"] {');
    const white = css.indexOf(".sas-mcard__pill .sas-pill, .sas-mcard__pill .sas-pill[data-status] { background: #fff; }");
    expect(live).toBeGreaterThan(-1);
    expect(white).toBeGreaterThan(live);
  });
});
