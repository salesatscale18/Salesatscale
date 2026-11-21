import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TextWithId } from "@/components/sas/id-text";

/**
 * IDs (Q-1002, PD-10001, SNS-200, SIM-0001) use normal digits: in Inter,
 * tabular-nums also widens the hyphen ("Q - 1002"). Tabular digits stay for
 * amounts, times and counts only.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; body: string; index: number };

/** Each innermost rule as selectors and body, in file order (rules inside @media included). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out.push({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2], index: m.index });
  }
  return out;
}

const numeric = (body: string) => /font-variant-numeric:\s*([^;]+)/.exec(body)?.[1].trim() ?? null;
const find = (all: Rule[], selector: string) => all.find((r) => r.selectors.includes(selector))!;

describe("ID digits (sas.css)", () => {
  const all = rules(read("components/sas/sas.css"));

  it("no rule that targets an ID class sets tabular digits", () => {
    for (const r of all) {
      const ids = r.selectors.filter((s) => /\.sas-id\b|\.sas-id--plain\b/.test(s));
      if (ids.length) expect(numeric(r.body), ids.join(", ")).not.toBe("tabular-nums");
    }
  });

  it(".sas-id and .sas-id--plain set normal digits, also inside .sas-num, after every tabular .sas-num rule", () => {
    expect(numeric(find(all, ".sas-id").body)).toBe("normal");
    expect(numeric(find(all, ".sas-id.sas-id--plain").body)).toBe("normal");
    const guard = all.filter((r) => numeric(r.body) === "normal" && r.selectors.includes(".sas-id") && r.selectors.includes(".sas-id--plain")).pop();
    expect(guard).toBeDefined();
    expect(guard!.selectors).toEqual(expect.arrayContaining([".sas-num .sas-id", ".sas-num .sas-id--plain"]));
    const lastNum = all.filter((r) => r.selectors.some((s) => /\.sas-num\b/.test(s)) && numeric(r.body) === "tabular-nums").pop()!;
    expect(lastNum.index).toBeLessThan(guard!.index);
  });

  it("amounts keep tabular digits", () => {
    expect(numeric(find(all, ".sas-num").body)).toBe("tabular-nums");
    expect(numeric(find(rules(read("app/f/[token]/buyer.css")), ".b-num").body)).toBe("tabular-nums");
    expect(numeric(find(rules(read("components/sas/quote-card.css")), ".sas-qc__num").body)).toBe("tabular-nums");
  });

  it("buyer and quote card ID classes use normal digits", () => {
    expect(numeric(find(rules(read("app/f/[token]/buyer.css")), ".b-id").body)).toBe("normal");
    expect(numeric(find(rules(read("components/sas/quote-card.css")), ".sas-qc__ref").body)).toBe("normal");
  });
});

describe("ID markup", () => {
  it("TextWithId puts the ID in the ID class (code font and plain)", () => {
    expect(renderToStaticMarkup(createElement(TextWithId, { text: "Order PD-10001 paid", id: "PD-10001" }))).toBe('Order <span class="sas-id">PD-10001</span> paid');
    expect(renderToStaticMarkup(createElement(TextWithId, { text: "Q-1002 v2 sent", id: "Q-1002 v2", plain: true }))).toBe('<span class="sas-id sas-id--plain">Q-1002 v2</span> sent');
  });

  it("the seller form card and the bank reference do not wrap IDs in tabular classes", () => {
    const conv = fs.readFileSync(path.join(process.cwd(), "app/app/[account]/leads/[leadId]/conversation.tsx"), "utf8");
    expect(conv).toContain('<bdi className="sas-id sas-id--plain">{p.ref.replace(/ v1$/, "")}</bdi>');
    const bank = fs.readFileSync(path.join(process.cwd(), "app/f/[token]/bank.tsx"), "utf8");
    expect(bank).toContain('<bdi className="b-id">{reference}</bdi>');
  });
});
