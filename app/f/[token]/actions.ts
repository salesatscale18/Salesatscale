"use server";

/**
 * Buyer actions. Public: the link token is the only credential, and every
 * service call re-verifies it. Paid is never set here: the card path asks the
 * (fake) provider, whose signed event is handled by lib/payments/events.ts.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { acceptNewPrice, signForm, startPayment, type SignErrors } from "@/lib/orders/service";
import { simulateFakePayment } from "@/lib/payments/events";
import { ORDER_FORM_FIELDS, type OrderFormField } from "@/db/schema";

const back = (token: string, lang: string, extra = "") => `/f/${token}?lang=${lang === "he" ? "he" : "en"}${extra}`;

export type SignState = { status: "idle" } | { status: "error"; errors: SignErrors; formError?: "not_open" | "price_changed" | "unavailable" };

export async function signAction(_prev: SignState, form: FormData): Promise<SignState> {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const fields: Partial<Record<OrderFormField, string>> = {};
  for (const f of ORDER_FORM_FIELDS) if (form.has(f)) fields[f] = String(form.get(f) ?? "");
  const h = await headers();
  const r = await signForm(appDb, token, {
    fields, fullName: String(form.get("full_name") ?? ""), role: String(form.get("signatory_role") ?? ""), agreed: form.get("agreed") === "on",
  }, { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") });
  if (r.ok) redirect(back(token, lang));
  if (r.reason === "invalid") return { status: "error", errors: r.errors };
  if (r.reason === "price_changed") redirect(back(token, lang));
  return { status: "error", errors: {}, formError: r.reason };
}

export async function acceptPriceAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const r = await acceptNewPrice(appDb, token);
  if (r.ok) redirect(back(r.token, lang));
  redirect(back(token, lang, `&notice=${r.reason}`));
}

export async function payCardAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const outcome = form.get("outcome") === "failed" ? "failed" : "succeeded";
  const r = await startPayment(appDb, token, { method: "card", recurringConsent: form.get("recurring") === "on" });
  if (!r.ok || r.kind !== "card") redirect(back(token, lang, `&err=${r.ok ? "method_off" : r.reason}`));
  await simulateFakePayment(appDb, r.providerRef, outcome);
  redirect(back(token, lang));
}

export async function payBankAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const r = await startPayment(appDb, token, { method: "bank_transfer", recurringConsent: false });
  redirect(back(token, lang, r.ok ? "" : `&err=${r.reason}`));
}
