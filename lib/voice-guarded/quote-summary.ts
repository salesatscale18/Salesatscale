/**
 * "Classic + guards" (lib/voice-guarded): the spoken summary of a quote created on a call (owner, 23 Nov 2026: the
 * price walkthrough, shortened). One sentence naming the main items with their quantities (no per-unit prices, no
 * subscription listed on its own), then the two totals (today and per month, VAT included), then the delivery
 * phrase: about 15 seconds of speech. Every amount and count is written out in words by the server, in the call's
 * language, so the model reads it instead of converting digits.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { quoteLines, quoteVersions, type SellerAccount } from "@/db/schema";
import { estimateDelivery } from "@/lib/delivery/eta";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { resolveMarket } from "@/lib/markets/service";
import { deliveryByPhrase } from "@/lib/agent/quote-message";
import { moneyWords, quantityWords, type WordsLanguage } from "./money-words";

export type SummaryLine = { sku: string; name: string; qty: number; recurring: boolean };

export type SummaryInput = {
  lines: readonly SummaryLine[];
  /** The SKUs create_quote was asked for (the rest were added by the app: installation, setup…). */
  requested: readonly string[];
  currency: string;
  oneTimeTotalMinor: number;
  recurringTotalMinor: number;
  period: "month" | "year";
  taxRateBp: number;
  /** "by about Thursday 3 December" in `language`, or null (no delivery plan). */
  deliveryBy: string | null;
  language: WordsLanguage;
};

/** "temperature sensor" → "temperature sensors" (English, last word; names with digits or in capitals stay). */
export function pluralName(name: string): string {
  const m = /^(.*?)([A-Za-z]+)$/.exec(name.trim());
  if (!m) return name;
  const [, head, w] = m;
  if (w.length > 1 && w === w.toUpperCase()) return name;
  // Already plural ("sensors"), but "glass" → "glasses".
  if (/s$/i.test(w) && !/ss$/i.test(w)) return name;
  if (/(ss|x|z|ch|sh)$/i.test(w)) return `${head}${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${head}${w.slice(0, -1)}ies`;
  return `${head}${w}s`;
}

/** One item with its quantity, in words: "six Temperature sensors" / "שש יחידות חיישן טמפרטורה". */
function itemWords(l: { name: string; qty: number }, lang: WordsLanguage): string {
  if (lang === "en") return `${quantityWords(l.qty, "en")} ${l.qty === 1 ? l.name : pluralName(l.name)}`;
  if (l.qty === 1) return l.name;
  return `${l.qty === 2 ? "שתי" : quantityWords(l.qty, "he")} יחידות ${l.name}`;
}

/** "a, b and c" / "א, ב וג". */
function list(items: string[], lang: WordsLanguage): string {
  if (items.length < 2) return items.join("");
  return lang === "en" ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : `${items.slice(0, -1).join(", ")} ו${items.at(-1)}`;
}

/** Lines of one SKU and charge are one item (a quote can list a SKU per site). */
function merged(lines: readonly SummaryLine[]): SummaryLine[] {
  const out = new Map<string, SummaryLine>();
  for (const l of lines) {
    const key = `${l.sku}|${l.recurring}`;
    const had = out.get(key);
    out.set(key, had ? { ...had, qty: had.qty + l.qty } : { ...l });
  }
  return [...out.values()];
}

const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The spoken summary (pure): "Six Temperature sensors and two Gateways, with Installation. That's … today and … a month, including VAT. Delivery by about …". */
export function quoteSummaryText(q: SummaryInput): string {
  const lang = q.language;
  const requested = new Set(q.requested.map((s) => s.trim().toUpperCase()));
  const all = merged(q.lines);
  const oneTime = all.filter((l) => !l.recurring);
  // The main items: what was asked for, one-time (a subscription is the monthly total); a quote of subscriptions only names them.
  let main = oneTime.filter((l) => requested.has(l.sku.toUpperCase()));
  if (!main.length) main = all.filter((l) => requested.has(l.sku.toUpperCase()));
  if (!main.length) main = oneTime.length ? oneTime : all;
  const mainSkus = new Set(main.map((l) => l.sku));
  const added = [...new Set(oneTime.filter((l) => !mainSkus.has(l.sku)).map((l) => l.name))];
  const items = list(main.map((l) => itemWords(l, lang)), lang);
  const vat = q.taxRateBp > 0;
  const today = moneyWords(q.oneTimeTotalMinor, q.currency, lang);
  const recurring = q.recurringTotalMinor > 0 ? moneyWords(q.recurringTotalMinor, q.currency, lang) : null;
  if (lang === "he") {
    const what = `${items}${added.length ? `, כולל ${list(added, lang)}` : ""}.`;
    const per = q.period === "year" ? "לשנה" : "לחודש";
    const parts = [q.oneTimeTotalMinor > 0 || !recurring ? `${today} היום` : "", recurring ? `${recurring} ${per}` : ""].filter(Boolean);
    const totals = `זה ${parts.join(" ו")}${vat ? ", כולל מע״מ" : ""}.`;
    return [what, totals, q.deliveryBy ? `אספקה ${q.deliveryBy}.` : ""].filter(Boolean).join(" ");
  }
  const what = `${capFirst(items)}${added.length ? `, with ${list(added, lang)}` : ""}.`;
  const per = q.period === "year" ? "a year" : "a month";
  // Nothing to pay today (subscriptions only): only the recurring total.
  const parts = [q.oneTimeTotalMinor > 0 || !recurring ? `${today} today` : "", recurring ? `${recurring} ${per}` : ""].filter(Boolean);
  const totals = `That's ${parts.join(" and ")}${vat ? ", including VAT" : ""}.`;
  return [what, totals, q.deliveryBy ? `Delivery ${q.deliveryBy}.` : ""].filter(Boolean).join(" ");
}

/**
 * The summary of a quote version as stored (its lines and totals), with the delivery phrase worked out as
 * create_quote does (lib/agent/tools.ts), in the summary's language. Null when the version is not found.
 */
export async function loadQuoteSummary(
  db: Db, a: { account: SellerAccount; quoteId: string; version: number; requested: readonly string[]; language: WordsLanguage; now?: Date },
): Promise<string | null> {
  const accountId = a.account.id;
  const [v] = await db.select().from(quoteVersions)
    .where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.quoteId, a.quoteId), eq(quoteVersions.version, a.version)));
  if (!v) return null;
  const rows = await db.select().from(quoteLines).where(and(eq(quoteLines.accountId, accountId), eq(quoteLines.quoteVersionId, v.id))).orderBy(asc(quoteLines.sortOrder));
  let deliveryBy: string | null = null;
  try {
    const market = await resolveMarket(db, accountId, v.marketId);
    const plan = market ? deliveryPlanFor(a.account, market) : null;
    if (plan) deliveryBy = deliveryByPhrase(estimateDelivery({ ...plan, from: a.now ?? new Date() }).latest, a.language);
  } catch {
    deliveryBy = null;
  }
  return quoteSummaryText({
    lines: rows.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, recurring: l.chargeType !== "one_time" })),
    requested: a.requested, currency: v.currency, oneTimeTotalMinor: v.oneTimeTotalMinor, recurringTotalMinor: v.recurringTotalMinor,
    period: v.recurringPeriod === "year" ? "year" : "month", taxRateBp: v.taxRateBp, deliveryBy, language: a.language,
  });
}
