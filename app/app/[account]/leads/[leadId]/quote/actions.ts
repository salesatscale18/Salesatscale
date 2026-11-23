"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireAccount } from "@/lib/auth/account";
import type { QuoteRequestLine } from "@/lib/catalog/pricing";
import { createQuote, createQuoteVersion, getQuote } from "@/lib/quotes/service";
import { MAX_CUSTOM_PRICE_MAJOR, parseCustomPrices } from "@/lib/quotes/custom-prices";
import { currencyDigits } from "@/lib/quotes/price-field";
import { formatMoney } from "@/lib/domain/money";
import { createOrderForm } from "@/lib/orders/service";
import { offerOrderFormInChat } from "@/lib/sms/outbound";
import { t } from "@/lib/i18n";
import { buildPreview, refusalMessages, type QuotePreview, type RefusalLink } from "./preview";

/** Reads quantities ("qty:<SKU>"), discount (%) and sites from the editor form. */
function readForm(form: FormData) {
  const lines: QuoteRequestLine[] = [];
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("qty:")) continue;
    const qty = Number(String(v).trim() || "0");
    if (qty !== 0) lines.push({ sku: k.slice(4), qty });
  }
  const pct = String(form.get("discount") ?? "").trim();
  const discountBp = pct ? Math.round(Number(pct) * 100) : 0;
  const sitesRaw = String(form.get("sites") ?? "").trim();
  const sites = sitesRaw ? Number(sitesRaw) : undefined;
  // Auto-added lines removed at the buyer's request ("removed" per SKU). The editor always
  // sends "removedSet", so an empty list clears earlier removals; the service keeps only removable ones.
  const removedByBuyer = form.has("removedSet") ? form.getAll("removed").map((v) => String(v).trim()).filter(Boolean).slice(0, 50) : undefined;
  return {
    lines, discountBp: Number.isFinite(discountBp) ? discountBp : -1, sites: Number.isInteger(sites) && sites! > 0 ? sites : undefined,
    ...(removedByBuyer ? { removedByBuyer } : {}),
  };
}

/**
 * A new version only: the quote (of this account and lead) it is made from,
 * and a person's unit prices from the form ("price:<SKU>:<charge>"), checked
 * here: 0 or more, at most MAX_CUSTOM_PRICE_MAJOR, in the quote's currency.
 */
async function versionInput(accountId: string, leadId: string, fromQuote: string, form: FormData) {
  const q = await getQuote(appDb, accountId, fromQuote);
  if (!q || q.quote.leadId !== leadId) return { ok: true as const, customs: undefined, exceptions: [] };
  const current = q.versions[0]?.version;
  const currency = current?.currency ?? "USD";
  const parsed = parseCustomPrices(form.entries(), currency);
  if (!parsed.ok) {
    return { ok: false as const, message: t("quote.editor.price_invalid", { sku: parsed.sku, max: formatMoney(MAX_CUSTOM_PRICE_MAJOR * 10 ** currencyDigits(currency), currency) }) };
  }
  // The approved exceptions the quote used stay on record on the person's version ("Exception applied").
  const exceptions = (current?.approvalReasons ?? []).flatMap((r) => (r.kind === "exception" ? [{ id: r.id, text: r.text }] : []));
  return { ok: true as const, customs: parsed.customs, exceptions };
}

/** Live preview: same pricing as saving (previewQuote), nothing saved. The account comes from requireAccount, never the form. */
export async function previewQuoteAction(form: FormData): Promise<QuotePreview> {
  const { account } = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const fromQuote = String(form.get("fromQuote") ?? "") || undefined;
  const v = fromQuote ? await versionInput(account.id, leadId, fromQuote, form) : null;
  if (v && !v.ok) return { status: "errors", messages: [v.message] };
  return buildPreview(appDb, account, leadId, readForm(form), fromQuote, v?.customs);
}

export type SaveQuoteState = { status: "idle" } | { status: "error"; messages: string[]; link?: RefusalLink };

export async function saveQuoteAction(_prev: SaveQuoteState, form: FormData): Promise<SaveQuoteState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const fromQuote = String(form.get("fromQuote") ?? "");
  const input = { ...readForm(form), idempotencyKey: String(form.get("idem") ?? "") || undefined, changeNote: String(form.get("note") ?? "").trim() || undefined };
  if (fromQuote && !input.changeNote) return { status: "error", messages: [t("quote.editor.note_required")] };
  const actor = { kind: "human" as const, userId: a.user.id, actingAs: a.actingAs };
  let r;
  if (fromQuote) {
    const v = await versionInput(a.account.id, leadId, fromQuote, form);
    if (!v.ok) return { status: "error", messages: [v.message] };
    r = await createQuoteVersion(appDb, a.account.id, actor, fromQuote, { ...input, exceptions: v.exceptions }, new Date(), v.customs);
  } else {
    r = await createQuote(appDb, a.account.id, actor, leadId, input);
  }
  // Refusals include no_price_list (with a link to price lists) and not_sold.
  if (!r.ok) return { status: "error", ...refusalMessages(a.account.slug, r) };
  // "Create and send": a quote that is ready (draft: approved or needing no approval) goes straight
  // on to its order form, as the order page's "Send order form" does. "Save as draft" stops here
  // (created, not sent). A repeated submit (reused) does not send again.
  let sent = "";
  if (form.get("intent") === "send" && r.quote.status === "draft" && !r.reused) {
    const f = await createOrderForm(appDb, a.account.id, { kind: "human", userId: a.user.id, actingAs: a.actingAs }, r.quote.id);
    // As every order-form send: the form card in the buyer's chat and the "order form ready" SMS.
    if (f.ok) await offerOrderFormInChat(appDb, { userId: a.user.id, actingAs: a.actingAs }, a.account.id, f.form.leadId, f.url);
    sent = f.ok ? "&sent=1" : `&send=${f.reason}`;
  }
  revalidatePath(`/app/${a.account.slug}/orders`);
  revalidatePath(`/app/${a.account.slug}/leads/${r.quote.leadId}`);
  redirect(`/app/${a.account.slug}/orders?quote=${r.quote.id}${sent}`);
}
