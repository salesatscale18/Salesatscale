"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireAccount } from "@/lib/auth/account";
import { priceQuote, pricingErrorText, approvalReasonText, type QuoteRequestLine } from "@/lib/catalog/pricing";
import { checkFit } from "@/lib/catalog/fit";
import { publishedCatalog } from "@/lib/catalog/service";
import { createQuote, createQuoteVersion } from "@/lib/quotes/service";
import { t, type MessageKey } from "@/lib/i18n";

export type PreviewLine = { sku: string; name: string; qty: number; unitPriceMinor: number | null; lineTotalMinor: number | null; priceSource: string; recurring: boolean };
export type QuotePreview =
  | { status: "empty" }
  | { status: "errors"; messages: string[] }
  | {
      status: "ok";
      lines: PreviewLine[];
      oneTime: { subtotal: number; discount: number; tax: number; total: number };
      recurring: { subtotal: number; discount: number; tax: number; total: number };
      pricesIncludeTax: boolean;
      approval: string[];
      fitProblems: { text: string; fix: { sku: string; add: number; name: string } | null }[];
      notes: string[];
      complete: boolean;
    };

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

/** Live preview: same engine and rules as creating, nothing saved. */
export async function previewQuoteAction(form: FormData): Promise<QuotePreview> {
  const { account } = await requireAccount(String(form.get("slug") ?? ""));
  const catalog = await publishedCatalog(appDb, account.id);
  if (!catalog) return { status: "errors", messages: [t("quote.editor.no_catalog")] };
  const input = readForm(form);
  if (input.lines.length === 0) return { status: "empty" };
  const r = priceQuote({
    items: catalog.items, lines: input.lines, discountBp: input.discountBp, maxDiscountBp: account.maxDiscountBp,
    pricesIncludeTax: catalog.version.pricesIncludeTax, taxRateBp: catalog.version.taxRateBp,
  });
  if (!r.ok) return { status: "errors", messages: r.errors.map(pricingErrorText) };
  const fit = checkFit(catalog.rules, input.lines, input.sites);
  const tot = (x: typeof r.oneTime) => ({ subtotal: x.subtotalMinor, discount: x.discountMinor, tax: x.taxMinor, total: x.totalMinor });
  return {
    status: "ok",
    lines: r.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor, priceSource: l.priceSource, recurring: l.chargeType === "recurring" })),
    oneTime: tot(r.oneTime),
    recurring: tot(r.recurring),
    pricesIncludeTax: catalog.version.pricesIncludeTax,
    approval: r.approvalReasons.map(approvalReasonText),
    fitProblems: fit.problems.map((text, i) => {
      const f = fit.fixes[i];
      const item = f ? catalog.items.find((x) => x.sku === f.sku && x.active) : undefined;
      return { text, fix: f && item ? { ...f, name: item.name } : null };
    }),
    notes: fit.notes,
    complete: r.complete,
  };
}

export type SaveQuoteState = { status: "idle" } | { status: "error"; messages: string[] };

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
  if (!r.ok) {
    const messages =
      r.reason === "pricing" ? r.errors.map(pricingErrorText)
      : r.reason === "fit" ? r.problems
      : [t(`quote.editor.refused.${r.reason}` as MessageKey)];
    return { status: "error", messages };
  }
  revalidatePath(`/app/${a.account.slug}/orders`);
  revalidatePath(`/app/${a.account.slug}/leads/${r.quote.leadId}`);
  redirect(`/app/${a.account.slug}/orders?quote=${r.quote.id}`);
}
