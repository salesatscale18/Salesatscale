"use server";

/**
 * Buyer actions. Public: the link token is the only credential, and every
 * service call re-verifies it. Paid is never set here: the card path asks the
 * (fake) provider, whose signed event is handled by lib/payments/events.ts.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { acceptNewPrice, loadForm, signForm, snapshotOf, startPayment } from "@/lib/orders/service";
import { companyErrors, mergeDraft, saveDraft, signedFields, stepValues, type Step } from "@/lib/orders/draft";
import { simulateFakePayment } from "@/lib/payments/events";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";

const back = (token: string, lang: string, extra = "") => `/f/${token}?lang=${lang === "he" ? "he" : "en"}${extra}`;

/** Sign, accept price and pay share one budget per link: 20 per 10 minutes. The key holds a hash, never the token. */
async function limited(token: string) {
  return !(await rateLimit(appDb, `buyer:${hashKey(token)}`, { limit: 20, windowSeconds: 600 })).ok;
}

/** Saving a step (Continue / Back) has its own, larger budget: 60 per 10 minutes per link. */
async function draftLimited(token: string) {
  return !(await rateLimit(appDb, `buyer-draft:${hashKey(token)}`, { limit: 60, windowSeconds: 600 })).ok;
}

const stepOf = (v: unknown): Step => (v === "2" ? 2 : v === "3" ? 3 : 1);

/**
 * The three-step order form (P11). Every step posts here: the step's fields
 * are saved as the form's draft (never as a signature), then the buyer moves
 * on ("continue"), goes to an earlier step ("goto:N", also the progress bar
 * and "Change"), switches language on the same step ("lang:en" / "lang:he",
 * saved without checks), or signs ("sign", step 3). Errors come back as `check=1`:
 * the page recomputes them from the saved draft, so no client code is needed.
 */
export async function stepAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const posted = stepOf(String(form.get("step") ?? ""));
  const intent = String(form.get("intent") ?? "continue");
  const sign = intent === "sign" && posted === 3;
  if (await (sign ? limited(token) : draftLimited(token))) redirect(back(token, lang, `&step=${posted}&err=rate_limited`));
  const view = await loadForm(appDb, token);
  // Signed, replaced or expired meanwhile: the page shows that state.
  if (!view || view.state !== "open") redirect(back(token, lang));
  const s = snapshotOf(view.form);
  const target: Step = intent.startsWith("goto:") ? stepOf(intent.slice(5)) : intent === "continue" ? (posted === 1 ? 2 : 3) : posted;
  const draft = mergeDraft(s, view.form.draft, posted, form, target);
  // The language switch (EN / HE): keep what was typed on this step as the draft, unchecked, and reload the same step.
  if (intent.startsWith("lang:")) {
    await saveDraft(appDb, view.form.id, draft);
    redirect(back(token, intent.slice(5), `&step=${posted}`));
  }
  // Step 3 needs a complete step 2: back to it with the errors shown.
  if (target === 3 && Object.keys(companyErrors(s, stepValues(s, draft))).length) {
    await saveDraft(appDb, view.form.id, { ...draft, step: 2 });
    redirect(back(token, lang, "&step=2&check=1"));
  }
  await saveDraft(appDb, view.form.id, draft);
  if (!sign) redirect(back(token, lang, `&step=${target}`));

  const v = stepValues(s, draft);
  const h = await headers();
  const r = await signForm(appDb, token, {
    fields: signedFields(s, v), fullName: v.fullName, role: v.role, agreed: draft.agreed === true, delivery: v.delivery,
  }, { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") });
  if (r.ok || r.reason === "price_changed") redirect(back(token, lang));
  if (r.reason === "invalid") {
    const company = Object.keys(r.errors).some((k) => k !== "agreed" && k !== "delivery_date" && k !== "delivery_address");
    if (company) await saveDraft(appDb, view.form.id, { ...draft, step: 2 });
    redirect(back(token, lang, company ? "&step=2&check=1" : "&step=3&check=1"));
  }
  redirect(back(token, lang, `&step=3&err=${r.reason}`));
}

export async function acceptPriceAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  if (await limited(token)) redirect(back(token, lang, "&err=rate_limited"));
  const r = await acceptNewPrice(appDb, token);
  if (r.ok) redirect(back(r.token, lang));
  redirect(back(token, lang, `&notice=${r.reason}`));
}

export async function payCardAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  const outcome = form.get("outcome") === "failed" ? "failed" : "succeeded";
  if (await limited(token)) redirect(back(token, lang, "&err=rate_limited"));
  const r = await startPayment(appDb, token, { method: "card", recurringConsent: form.get("recurring") === "on" });
  if (!r.ok || r.kind !== "card") redirect(back(token, lang, `&err=${r.ok ? "method_off" : r.reason}`));
  await simulateFakePayment(appDb, r.providerRef, outcome);
  redirect(back(token, lang));
}

export async function payBankAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  const lang = String(form.get("lang") ?? "en");
  if (await limited(token)) redirect(back(token, lang, "&err=rate_limited"));
  const r = await startPayment(appDb, token, { method: "bank_transfer", recurringConsent: false });
  redirect(back(token, lang, r.ok ? "" : `&err=${r.reason}`));
}
