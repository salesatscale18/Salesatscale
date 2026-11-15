"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireAccount } from "@/lib/auth/account";
import type { QuoteRequestLine } from "@/lib/catalog/pricing";
import { createQuote, createQuoteVersion } from "@/lib/quotes/service";
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
  return { lines, discountBp: Number.isFinite(discountBp) ? discountBp : -1, sites: Number.isInteger(sites) && sites! > 0 ? sites : undefined };
}

/** Live preview: same pricing as saving (previewQuote), nothing saved. The account comes from requireAccount, never the form. */
export async function previewQuoteAction(form: FormData): Promise<QuotePreview> {
  const { account } = await requireAccount(String(form.get("slug") ?? ""));
  const fromQuote = String(form.get("fromQuote") ?? "") || undefined;
  return buildPreview(appDb, account, String(form.get("leadId") ?? ""), readForm(form), fromQuote);
}

export type SaveQuoteState = { status: "idle" } | { status: "error"; messages: string[]; link?: RefusalLink };

export async function saveQuoteAction(_prev: SaveQuoteState, form: FormData): Promise<SaveQuoteState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const fromQuote = String(form.get("fromQuote") ?? "");
  const input = { ...readForm(form), idempotencyKey: String(form.get("idem") ?? "") || undefined, changeNote: String(form.get("note") ?? "").trim() || undefined };
  if (fromQuote && !input.changeNote) return { status: "error", messages: [t("quote.editor.note_required")] };
  const actor = { kind: "human" as const, userId: a.user.id, actingAs: a.actingAs };
  const r = fromQuote
    ? await createQuoteVersion(appDb, a.account.id, actor, fromQuote, input)
    : await createQuote(appDb, a.account.id, actor, leadId, input);
  // Refusals include no_price_list (with a link to price lists) and not_sold.
  if (!r.ok) return { status: "error", ...refusalMessages(a.account.slug, r) };
  revalidatePath(`/app/${a.account.slug}/orders`);
  revalidatePath(`/app/${a.account.slug}/leads/${r.quote.leadId}`);
  redirect(`/app/${a.account.slug}/orders?quote=${r.quote.id}`);
}
