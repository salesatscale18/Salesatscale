/**
 * Seller-readable trace lines (canvas: TestLab, LeadEmpty). Pure; the raw
 * input and result stay available behind "Show raw".
 */
type Obj = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const lines = (v: unknown) => arr(v).map((l) => `${str((l as Obj).qty)} × ${str((l as Obj).sku)}`).join(", ");

export const TRACE_LABEL: Record<string, string> = {
  search_catalog: "catalog.search",
  check_fit: "catalog.check_fit",
  lookup_knowledge: "knowledge.lookup",
  update_deal_state: "deal_state.update",
  create_quote: "quote.create",
  hand_off_to_human: "handoff.request",
  send_order_form: "order_form.send",
  check_payment: "payment.check",
};

export type TraceLine = { label: string; sent: string; got: string; missing: string[] };

export function describeCall(name: string, input: Obj, result: Obj, outcome: "ok" | "refused" | "failed"): TraceLine {
  const label = TRACE_LABEL[name] ?? name;
  const missing = arr(result.missing).map(str);
  let sent = "";
  let got = "";
  switch (name) {
    case "search_catalog":
      sent = input.query ? `Looked for "${str(input.query)}"` : "Listed all products";
      got = `${arr(result.items).length} product(s) found`;
      break;
    case "check_fit":
      sent = `Checked ${lines(input.lines)}${input.sites ? ` for ${str(input.sites)} site(s)` : ""}`;
      got = result.ok ? "Fits" : `${arr(result.problems).length} problem(s): ${arr(result.problems).map(str).join(" ")}`;
      break;
    case "lookup_knowledge": {
      const facts = arr(result.facts) as Obj[];
      sent = `Asked "${str(input.query)}"`;
      got = facts.length ? facts.map((f) => `${str(f.topic)}${f.source ? ` (${str(f.source)})` : ""}`).join(", ") : "No approved information";
      break;
    }
    case "update_deal_state": {
      const ups = arr(input.updates) as Obj[];
      sent = ups.length ? ups.map((u) => `${str(u.key)} = ${str(u.value)}`).join(", ") : "No field changes";
      if (input.objection && typeof input.objection === "object") sent += `; objection: ${str((input.objection as Obj).text)}`;
      const kept = arr(result.kept_verified).map(str);
      got = `Saved ${arr(result.saved).length}${kept.length ? `; kept verified: ${kept.join(", ")}` : ""}`;
      break;
    }
    case "create_quote":
      sent = `${lines(input.lines)}${input.discount_percent ? `, ${str(input.discount_percent)}% discount` : ""}`;
      got = result.quote
        ? `${str(result.quote)}: ${str(result.due_on_signing)} due on signing${result.monthly ? ` + ${str(result.monthly)}` : ""}${result.status === "awaiting_seller_approval" ? " (awaiting your approval)" : ""}`
        : "";
      break;
    case "send_order_form":
      sent = str(input.quote);
      got = result.link ? `Link sent, valid until ${str(result.valid_until)}` : "";
      break;
    case "check_payment":
      sent = "Checked the order";
      got = result.signed ? `Signed; payment ${str(result.payment).replace(/_/g, " ")}` : `Not signed (order form ${str(result.order_form)})`;
      break;
    case "hand_off_to_human":
      sent = str(input.reason) || "Asked for a person";
      got = "Handed to a person";
      break;
    default:
      sent = "";
  }
  if (outcome === "refused") got = str(result.rule);
  if (outcome === "failed") got = str(result.error) || "The tool failed";
  return { label, sent, got, missing };
}
