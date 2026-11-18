/**
 * Order form prefill from what the conversation learned (demo item 8). The
 * one place that maps deal-state keys to order-form fields. Pure; unit-tested.
 *
 * Deal-state keys are the seller's playbook field keys (`fieldKey(label)`), so
 * each order-form field accepts the keys a playbook is likely to use for it.
 */
import type { DealFieldValue, OrderFormField } from "@/db/schema";

export type PrefillKey = OrderFormField | "signatory_name";
export type Prefill = Partial<Record<PrefillKey, string>>;

/** Order-form field → deal-state keys that fill it, best match first. */
export const DEAL_KEYS_FOR_FIELD: Record<PrefillKey, readonly string[]> = {
  company_name: ["company_name", "legal_name", "company_legal_name", "business_name", "company", "business"],
  company_id: ["company_id", "company_number", "registration_number", "company_registration", "business_id", "tax_id", "vat_id", "vat_number"],
  billing_address: ["billing_address", "invoice_address", "company_address", "address"],
  delivery_address: ["delivery_address", "shipping_address", "installation_address", "site_address", "address"],
  invoice_email: ["invoice_email", "billing_email", "accounts_email", "email"],
  signatory_name: ["signatory_name", "signatory", "signer_name", "decision_maker_name"],
  signatory_role: ["signatory_role", "signer_role", "decision_maker_role", "job_title", "role", "position"],
  po_number: ["po_number", "purchase_order", "purchase_order_number"],
};

const PROVENANCE_RANK: Record<DealFieldValue["provenance"], number> = { verified: 3, buyer: 2, inferred: 1 };
const usable = (v: DealFieldValue | undefined): v is DealFieldValue => !!v && !!v.value?.trim() && !/^[\p{P}\p{S}\s]*$/u.test(v.value) && !/^(n\/?a|none|unknown|tbd|לא ידוע)$/i.test(v.value.trim());

/** The deal-state value for one field: the best-provenance usable value among its keys (key order breaks ties). */
export function dealValueFor(field: PrefillKey, deal: Record<string, DealFieldValue>): DealFieldValue | null {
  let best: DealFieldValue | null = null;
  for (const key of DEAL_KEYS_FOR_FIELD[field]) {
    const v = deal[key];
    if (usable(v) && (!best || PROVENANCE_RANK[v.provenance] > PROVENANCE_RANK[best.provenance])) best = v;
  }
  return best;
}

/**
 * What the buyer sees already filled in. Precedence per field: a verified
 * deal-state value, then what the buyer said in the chat, then the lead record
 * (seller's import), then what the agent inferred.
 */
export function orderFormPrefill(
  lead: { fullName: string; company: string | null; email: string | null },
  deal: Record<string, DealFieldValue> | null | undefined,
): Prefill {
  return orderFormPrefillWithSources(lead, deal).values;
}

/**
 * The other way round: what the buyer signed on the order form, as verified
 * deal-state values (company and signer details). Each value goes to its
 * canonical key (the form field's own name) and to every key of the playbook
 * (`playbookKeys`) or of the current deal state (`existingKeys`) that the
 * prefill maps to that field, so the lead card shows it whatever the seller
 * called the field. Empty values are skipped. Pure.
 */
export function signedDealValues(
  signed: { fields: Partial<Record<string, string>>; fullName: string; role: string | null },
  keys: { playbookKeys?: readonly string[]; existingKeys?: readonly string[] },
  at: Date,
): Record<string, DealFieldValue> {
  const known = new Set([...(keys.playbookKeys ?? []), ...(keys.existingKeys ?? [])]);
  const valueOf: Partial<Record<PrefillKey, string>> = {};
  for (const field of Object.keys(DEAL_KEYS_FOR_FIELD) as PrefillKey[]) {
    const v = field === "signatory_name" ? signed.fullName : field === "signatory_role" ? signed.role ?? "" : signed.fields[field] ?? "";
    if (v.trim()) valueOf[field] = v.trim().slice(0, 300);
  }
  const out: Record<string, DealFieldValue> = {};
  const updatedAt = at.toISOString();
  for (const field of Object.keys(valueOf) as PrefillKey[]) {
    const value = valueOf[field]!;
    // "address" maps to both billing and delivery: the billing address wins (the first field in the map).
    for (const key of [field, ...DEAL_KEYS_FOR_FIELD[field].filter((k) => known.has(k))]) {
      if (!out[key]) out[key] = { value, provenance: "verified", updatedAt };
    }
  }
  return out;
}

/** Where a prefilled value came from: the conversation, or the buyer's own request (the website lead form). */
export type PrefillSource = "chat" | "request";

/**
 * The prefill plus where each value came from (the order form's small
 * "From your chat" / "From your request" tags). A value from the lead record
 * counts as the buyer's request only when the lead came from the website
 * form (origin "webhook"); a seller's own import or entry gets no tag.
 */
export function orderFormPrefillWithSources(
  lead: { fullName: string; company: string | null; email: string | null; origin?: string | null },
  deal: Record<string, DealFieldValue> | null | undefined,
): { values: Prefill; sources: Partial<Record<PrefillKey, PrefillSource>> } {
  const fromLead: Prefill = {
    ...(lead.company?.trim() ? { company_name: lead.company.trim() } : {}),
    ...(lead.email?.trim() ? { invoice_email: lead.email.trim() } : {}),
    ...(lead.fullName.trim() ? { signatory_name: lead.fullName.trim() } : {}),
  };
  const values: Prefill = {};
  const sources: Partial<Record<PrefillKey, PrefillSource>> = {};
  for (const field of Object.keys(DEAL_KEYS_FOR_FIELD) as PrefillKey[]) {
    const d = deal ? dealValueFor(field, deal) : null;
    const useDeal = d !== null && (d.provenance !== "inferred" || !fromLead[field]);
    const value = useDeal ? d.value : fromLead[field];
    if (!value?.trim()) continue;
    values[field] = value.trim().slice(0, 300);
    if (useDeal) sources[field] = "chat";
    else if (lead.origin === "webhook") sources[field] = "request";
  }
  return { values, sources };
}
