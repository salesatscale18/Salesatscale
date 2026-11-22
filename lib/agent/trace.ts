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
  record_opt_out: "lead.opt_out",
  schedule_follow_up: "follow_up.schedule",
  request_callback: "callback.request",
  ask_team: "team.ask",
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
      const placeholders = arr(result.rejected_placeholder).map(str);
      got = `Saved ${arr(result.saved).length}${kept.length ? `; kept verified: ${kept.join(", ")}` : ""}${placeholders.length ? `; not saved (no real value): ${placeholders.join(", ")}` : ""}`;
      break;
    }
    case "create_quote": {
      sent = `${lines(input.lines)}${input.discount_percent ? `, ${str(input.discount_percent)}% discount` : ""}`;
      // Results since P11 carry labelled totals (none while awaiting approval); older ones due_on_signing and monthly.
      const totals = result.totals && typeof result.totals === "object" ? (result.totals as Obj) : null;
      const awaiting = result.status === "awaiting_seller_approval" ? " (awaiting your approval)" : "";
      if (!result.quote) got = "";
      else if (totals) {
        const rec = totals.recurring_total_including_vat;
        got = `${str(result.quote)}: ${str(totals.total_today_including_vat)} due on signing incl. VAT${rec ? ` + ${str(rec)}` : ""}${awaiting}`;
      } else if (result.due_on_signing) {
        got = `${str(result.quote)}: ${str(result.due_on_signing)} due on signing${result.monthly ? ` + ${str(result.monthly)}` : ""}${awaiting}`;
      } else got = `${str(result.quote)}${awaiting}`;
      break;
    }
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
    case "record_opt_out":
      sent = str(input.reason) || "Buyer asked not to be contacted";
      got = "Opted out; the chat is closed";
      break;
    case "schedule_follow_up":
      sent = `${str(input.due_at)}${input.topic ? `: ${str(input.topic)}` : ""}`;
      // Seller view: the short time (due_short; results stored before O7 hold only due_local, short then too).
      got = result.due_short || result.due_local ? `Follow-up set for ${str(result.due_short ?? result.due_local)}` : "";
      break;
    case "request_callback":
      // Older calls carry the time the agent recorded; now the buyer picks it on the booking card.
      sent = input.time ? `${str(input.time)}${input.brief ? `: ${str(input.brief)}` : ""}` : str(input.brief);
      // N1: the time the buyer named, booked by the agent, or not free (the booking card is posted either way).
      got = result.booked === true ? `Call booked for ${str(result.call_short ?? result.call_local)}`
        : result.booked === false ? `${str(result.asked_short ?? result.asked_local)} not free; booking link sent in the chat`
        : result.time_short || result.time_local ? `Call requested for ${str(result.time_short ?? result.time_local)}; the team confirms it` : result.ok === true ? "Booking link sent in the chat" : "";
      break;
    case "ask_team":
      sent = `"${str(input.question)}"${input.must_have === true ? " (must-have)" : input.must_have === false ? " (good to know)" : ""}`;
      got = result.sent === true ? "Sent to the team; the chat goes on" : result.sent === false ? "Already answered in Knowledge" : "";
      break;
    default:
      sent = "";
  }
  if (outcome === "refused") got = str(result.rule);
  if (outcome === "failed") got = str(result.error) || "The tool failed";
  return { label, sent, got, missing };
}
