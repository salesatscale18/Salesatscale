/**
 * The quote editor's markup (canvas: QuoteEditor) from a server preview:
 * labels, the Checks group, the blocked state, the search combobox.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotePreview } from "@/app/app/[account]/leads/[leadId]/quote/preview";

vi.mock("@/app/app/[account]/leads/[leadId]/quote/actions", () => ({
  previewQuoteAction: async () => ({ status: "empty" }),
  saveQuoteAction: async () => ({ status: "idle" }),
}));
const { QuoteEditor } = await import("@/app/app/[account]/leads/[leadId]/quote/editor");

const items = [
  { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device", sold: true, charges: [{ charge: "one_time" as const, period: null, priceMinor: 59_000 }] },
  { sku: "GW-10", name: "Site gateway", unit: "site", sold: true, charges: [{ charge: "one_time" as const, period: null, priceMinor: 66_000 }] },
  { sku: "CRATE", name: "Spare crate", unit: "custom", unitCustom: { en: { one: "crate", other: "crates" } }, sold: true, charges: [{ charge: "one_time" as const, period: null, priceMinor: 1_000 }] },
  { sku: "PLAN-M", name: "Monitoring plan", unit: "site", sold: true, charges: [{ charge: "recurring" as const, period: "month" as const, priceMinor: 9_000 }] },
  { sku: "EXPORT", name: "Export kit", unit: "item", sold: false, charges: [] },
];
const line = (sku: string, name: string, qty: number, unit: number, extra: object = {}) => ({
  sku, name, qty, charge: "one_time" as const, period: null, unitPriceMinor: unit, lineTotalMinor: unit * qty, priceSource: "list" as const, autoAdded: false, removable: true, ...extra,
});
const base: Extract<QuotePreview, { status: "ok" }> = {
  status: "ok", currency: "ILS",
  lines: [
    line("SNS-200", "Wireless fridge sensor", 6, 59_000),
    line("GW-10", "Site gateway", 1, 66_000),
    line("CRATE", "Spare crate", 1, 1_000),
    { ...line("PLAN-M", "Monitoring plan", 2, 9_000), charge: "recurring", period: "month", autoAdded: true, perCount: { qty: 2, unit: "site" } },
  ],
  oneTime: { subtotal: 420_000, discount: 42_000, tax: 54_900, total: 378_000 },
  recurring: { subtotal: 18_000, discount: 0, tax: 2_600, total: 18_000 },
  recurringPeriod: "month", pricesIncludeTax: true,
  approval: ["Discount 10.0% is above the 5% limit."],
  fitProblems: [{ text: "2 sites need 2 gateways. The quote has 1.", fix: { sku: "GW-10", add: 1, name: "Site gateway" } }],
  notes: ["No Wi-Fi on a site? Use the cellular gateway GW-10C."],
  complete: false, discountBp: 1000, removed: [],
};
const render = (preview: QuotePreview) => renderToStaticMarkup(
  <QuoteEditor
    slug="acme" leadId="00000000-0000-4000-8000-000000000001" currency="ILS" maxDiscountPct={5} items={items}
    initialQty={{ "SNS-200": 6, "GW-10": 1, CRATE: 1 }} initialDiscount="10" idem="k" validDays={7} initialPreview={preview} initialSites="2"
  />,
);
/** The submit buttons: intent, disabled, label. */
const submits = (html: string) => [...html.matchAll(/<button type="submit"([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
  intent: /value="(\w+)"/.exec(attrs)?.[1], disabled: attrs.includes('disabled=""'), label,
}));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("quote editor markup", () => {
  it("unit sub-lines use unit labels, not raw keys; per-site recurring lines show the count", () => {
    const html = text(render(base));
    expect(html).toContain("SNS-200 One-time · per device");
    expect(html).toContain("PLAN-M Monthly · per site");
    expect(html).toContain("CRATE One-time · per crate");
    expect(html).not.toMatch(/SNS-200 device/);
    expect(html).toContain("₪90.00/month × 2 sites");
  });

  it("the items table fits a 1280px screen: five columns, the charge under the name, a wrapping product cell", () => {
    const html = render(base);
    const head = /<thead>(.*?)<\/thead>/.exec(html)![1];
    expect([...head.matchAll(/<th /g)]).toHaveLength(5);
    expect(head).not.toContain(">Charge<");
    expect(html).toContain('class="sas-table qe-table" style="min-width:500px"');
    expect(html).toContain('<td style="white-space:normal;min-width:160px">');
  });

  it("quantity inputs are named after their item", () => {
    expect(render(base)).toContain('aria-label="Quantity, Wireless fridge sensor"');
  });

  it("preview labels: One-time items, Discount 10%, Due on signing, Monthly, VAT and validity", () => {
    const html = text(render(base));
    expect(html).toMatch(/One-time items ₪4,200\.00 Discount 10% −₪420\.00 Due on signing ₪3,780\.00 Monthly ₪180\.00\/month/);
    expect(html).toContain("Prices include VAT (₪549.00 + ₪26.00/month). Valid 7 days from sending.");
    expect(text(render({ ...base, pricesIncludeTax: false }))).toContain("Prices without VAT (+ ₪549.00 + ₪26.00/month VAT).");
  });

  it("Checks group: fit problems with their fix, approval, and advice", () => {
    const html = text(render(base));
    expect(html).toMatch(/Checks 2 sites need 2 gateways\. The quote has 1\. Add 1 × Site gateway Needs approval: Discount 10\.0% is above the 5% limit\. Advice: No Wi-Fi on a site\?/);
    expect(text(render({ ...base, fitProblems: [], approval: [], notes: [] }))).not.toContain("Checks");
  });

  it("blocked: the primary keeps its label and is disabled; a separate line says how many problems", () => {
    const html = render(base);
    expect(submits(html)).toEqual([{ intent: "send", disabled: true, label: "Submit for approval" }]);
    expect(html).toContain('<span id="qe-blocked" class="sas-small" style="text-align:center">Fix 1 problem to continue.</span>');
    // Needs someone else's approval: no draft (it is not sendable either way).
    const two = render({ ...base, approval: [], fitProblems: [...base.fitProblems, { text: "Another problem.", fix: null }] });
    expect(submits(two)).toEqual([{ intent: "send", disabled: true, label: "Create and send" }, { intent: "draft", disabled: true, label: "Save as draft" }]);
    expect(two).toContain("Fix 2 problems to continue.");
  });

  it("ready: Create and send plus Save as draft, both enabled", () => {
    const html = render({ ...base, fitProblems: [], approval: [], complete: true });
    expect(submits(html)).toEqual([{ intent: "send", disabled: false, label: "Create and send" }, { intent: "draft", disabled: false, label: "Save as draft" }]);
    expect(html).not.toContain("qe-blocked");
    expect(submits(render({ ...base, fitProblems: [], complete: true })).map((b) => b.label)).toEqual(["Approve and send", "Save as draft"]);
  });

  it("search combobox for adding items, with the browse list kept as #qe-add", () => {
    const html = render(base);
    expect(html).toMatch(/<input id="qe-search" role="combobox" aria-label="Add product" placeholder="Add product by name or SKU" aria-expanded="false"/);
    // Items already on the quote are not offered; not-sold ones are listed but disabled.
    expect(html).toContain('id="qe-opt-PLAN-M"');
    expect(html).not.toContain('id="qe-opt-SNS-200"');
    expect(html).toMatch(/id="qe-opt-EXPORT" role="option" aria-selected="false" aria-disabled="true"[^>]*>.*?Not sold in this market/);
    expect(html).toMatch(/<select id="qe-add"/);
    expect(html).toMatch(/<option value="EXPORT" disabled="">Export kit · EXPORT · Not sold in this market<\/option>/);
  });

  it("auto-added lines: a required one shows the link icon and Required with; a removed one is struck through with Add back", () => {
    const html = render({
      ...base,
      lines: [...base.lines, { ...line("SVC-INST", "Installation", 2, 25_000), autoAdded: true, removable: false, requiredWith: "Site gateway" }],
      removed: [{ sku: "SETUP", name: "Setup fee", qty: 1 }],
    });
    expect(html).toMatch(/id="q-req-SVC-INST"[^>]*><svg[^>]*lucide-link-2[^>]*>.*?<span>Required with Site gateway\./);
    expect(html).not.toContain("lucide-lock");
    const withRemoval = renderToStaticMarkup(
      <QuoteEditor
        slug="acme" leadId="00000000-0000-4000-8000-000000000001" fromQuote="00000000-0000-4000-8000-000000000002" currency="ILS" maxDiscountPct={5} items={items}
        initialQty={{ "GW-10": 1 }} initialDiscount="" idem="k" validDays={7} initialRemoved={["SETUP"]}
        initialPreview={{ ...base, lines: [line("GW-10", "Site gateway", 1, 66_000)], removed: [{ sku: "SETUP", name: "Setup fee", qty: 1 }] }}
      />,
    );
    expect(withRemoval).toMatch(/data-removed="true"[^>]*>.*?text-decoration:line-through.*?Setup fee.*?id="q-back-SETUP"/);
    expect(withRemoval).toContain('<textarea class="sas-input" id="q-note" name="note"');
    expect(withRemoval).toContain("Shown in the version history.");
  });
});
