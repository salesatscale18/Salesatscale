/**
 * The order form in three steps (P11): 1 your order, 2 your company,
 * 3 delivery, sign and pay. What the buyer typed is kept as a draft on the
 * order form (saved on Continue / Back), so a buyer who leaves and returns
 * resumes at the same step and going back never loses input. Nothing is
 * signed until step 3 completes (lib/orders/service.ts signForm).
 *
 * Pure except saveDraft. The server validates everything again at signing.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { orderForms, type OrderFormDraft, type OrderFormField, type OrderSnapshot } from "@/db/schema";

export type Step = 1 | 2 | 3;
export type FieldError = "required" | "invalid";
export type StepErrors = Partial<Record<OrderFormField | "full_name" | "agreed" | "delivery_date", FieldError>>;

const OPTIONAL: readonly OrderFormField[] = ["po_number"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Step 2's company fields, in the seller's order: everything but the delivery address (step 3) and the signer's role. */
export function companyFields(fields: readonly OrderFormField[]): OrderFormField[] {
  return fields.filter((f) => f !== "delivery_address" && f !== "signatory_role");
}

/**
 * Required and format checks for the buyer's fields. Step 2 checks the
 * company fields and the signer; `withDelivery` adds the delivery address
 * (step 3 and signing).
 */
export function fieldErrors(
  formFields: readonly OrderFormField[], values: Partial<Record<OrderFormField, string>>, fullName: string, role: string, opts: { withDelivery: boolean },
): StepErrors {
  const e: StepErrors = {};
  for (const f of formFields) {
    if (f === "signatory_role" || (f === "delivery_address" && !opts.withDelivery)) continue;
    const v = (values[f] ?? "").trim();
    if (!v && !OPTIONAL.includes(f)) e[f] = "required";
    else if (v && f === "invoice_email" && !EMAIL.test(v)) e[f] = "invalid";
  }
  if (formFields.includes("signatory_role") && !role.trim()) e.signatory_role = "required";
  if (fullName.trim().length < 2) e.full_name = "required";
  return e;
}

/** What the buyer sees in the fields: what they typed (the draft), else the prefill from the chat and the lead. */
export type StepValues = {
  fields: Partial<Record<OrderFormField, string>>;
  fullName: string;
  role: string;
  /** Delivery address same as billing (only when both fields are on). */
  deliverySame: boolean;
  delivery: { kind: "asap" } | { kind: "date"; date: string | null };
};

export function stepValues(s: Pick<OrderSnapshot, "fields" | "prefill">, draft: OrderFormDraft | null | undefined): StepValues {
  const fields: Partial<Record<OrderFormField, string>> = {};
  for (const f of s.fields) fields[f] = draft?.fields?.[f] ?? s.prefill[f] ?? "";
  const sameAllowed = s.fields.includes("billing_address") && s.fields.includes("delivery_address");
  // Default: same as billing, unless the chat gave a different delivery address.
  const prefDelivery = (s.prefill.delivery_address ?? "").trim();
  const sameDefault = !prefDelivery || prefDelivery === (fields.billing_address ?? "").trim();
  const deliverySame = sameAllowed && (draft?.deliverySame ?? sameDefault);
  if (s.fields.includes("delivery_address") && draft?.fields?.delivery_address === undefined && !fields.delivery_address) fields.delivery_address = fields.billing_address ?? "";
  return {
    fields,
    fullName: draft?.fullName ?? s.prefill.signatory_name ?? "",
    role: draft?.role ?? s.prefill.signatory_role ?? "",
    deliverySame,
    delivery: draft?.delivery ?? { kind: "asap" },
  };
}

/** The fields as signed: the delivery address is the billing address when "same as billing" is ticked. */
export function signedFields(s: Pick<OrderSnapshot, "fields">, v: StepValues): Partial<Record<OrderFormField, string>> {
  const out = { ...v.fields };
  if (v.deliverySame && s.fields.includes("delivery_address")) out.delivery_address = v.fields.billing_address ?? "";
  return out;
}

/** Step 2's errors: the company fields and the signer. */
export function companyErrors(s: Pick<OrderSnapshot, "fields">, v: StepValues): StepErrors {
  return fieldErrors(s.fields, v.fields, v.fullName, v.role, { withDelivery: false });
}

/**
 * The step to show. Without a step in the link: where the buyer left off.
 * A later step whose earlier data is missing returns to the first incomplete
 * step (step 1 has nothing to fill in; step 2 must be complete for step 3).
 */
export function resolveStep(requested: string | undefined, s: Pick<OrderSnapshot, "fields" | "prefill">, draft: OrderFormDraft | null | undefined): Step {
  const n = Number(requested);
  const wanted: Step = n === 1 || n === 2 || n === 3 ? n : draft?.step ?? 1;
  if (wanted === 3 && Object.keys(companyErrors(s, stepValues(s, draft))).length) return 2;
  return wanted;
}

/** The draft carried over to a new version's form: company details kept, back to step 1. */
export function carriedDraft(prev: OrderFormDraft | null): OrderFormDraft | null {
  if (!prev) return null;
  return {
    step: 1,
    ...(prev.fields ? { fields: { ...prev.fields } } : {}),
    ...(prev.fullName !== undefined ? { fullName: prev.fullName } : {}),
    ...(prev.role !== undefined ? { role: prev.role } : {}),
    ...(prev.deliverySame !== undefined ? { deliverySame: prev.deliverySame } : {}),
  };
}

const text = (form: FormData, key: string, max: number) => String(form.get(key) ?? "").slice(0, max);

/**
 * Reads one step's posted fields into the draft. Only the fields of the
 * posted step change (others keep what was saved), and only fields the
 * seller asked for are kept. `step` becomes the step to resume at.
 */
export function mergeDraft(
  s: Pick<OrderSnapshot, "fields">, prev: OrderFormDraft | null | undefined, posted: Step, form: FormData, next: Step,
): OrderFormDraft {
  const d: OrderFormDraft = { ...(prev ?? {}), step: next, fields: { ...(prev?.fields ?? {}) } };
  if (posted === 2) {
    for (const f of companyFields(s.fields)) if (form.has(f)) d.fields![f] = text(form, f, 300);
    if (form.has("full_name")) d.fullName = text(form, "full_name", 120);
    if (s.fields.includes("signatory_role") && form.has("signatory_role")) d.role = text(form, "signatory_role", 80);
  }
  if (posted === 3) {
    if (s.fields.includes("delivery_address")) {
      if (form.has("delivery_address")) d.fields!.delivery_address = text(form, "delivery_address", 300);
      if (s.fields.includes("billing_address")) d.deliverySame = form.get("delivery_same") === "on";
    }
    if (form.has("delivery_when")) {
      const date = text(form, "delivery_date", 10);
      d.delivery = form.get("delivery_when") === "date" ? { kind: "date", date: ISO_DATE.test(date) ? date : null } : { kind: "asap" };
    }
    d.agreed = form.get("agreed") === "on";
  }
  return d;
}

/** Saves the draft of an open (sent or opened) form. A signed or replaced form is never changed. */
export async function saveDraft(db: Db, formId: string, draft: OrderFormDraft) {
  await db.update(orderForms).set({ draft }).where(and(eq(orderForms.id, formId), inArray(orderForms.status, ["sent", "opened"])));
}
