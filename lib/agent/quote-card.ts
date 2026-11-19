/**
 * The designed quote card (P11 wave 2, boards QuoteChat / QuoteStates /
 * QuoteSeller). The app still stores the fixed-layout text quote message
 * (lib/agent/quote-message.ts) as the fallback and as what WhatsApp sends; the
 * web chats (buyer simulator, lead page, inbox, test lab) render that message
 * as this card instead. Every number comes from the quote record.
 *
 * This file is pure (no database): the headline rules, the link a quote
 * message carries in its create_quote tool call, and the mapping from quote
 * rows to the card's display model in the buyer's language. The loader is in
 * lib/agent/quote-card-data.ts. Safe in client components only for its types.
 */
import { formatMoney } from "@/lib/domain/money";
import { dir as dirOf, isLocale, t, type Locale, type MessageKey } from "@/lib/i18n";
import { APP_MESSAGE_CALL } from "./app-message";
import { recurringTotalKey } from "@/lib/orders/display";
import { longCalendarDate, longDate, percentText } from "./quote-message";

// ---------------------------------------------------------------------------
// Headline (create_quote `headline`)
// ---------------------------------------------------------------------------

export const HEADLINE_MAX = 60;
const CURRENCY_SIGN = /[₪$€£¥]/;
const CURRENCY_WORD = /\b(?:ils|nis|usd|eur|gbp|shekels?|dollars?|euros?|pounds?)\b|ש["״׳']?ח|שקל|שקלים|דולר|יורו/i;
/** 590.00, 1,180, 10%: amounts and discounts are prices, not counts. */
const PRICE_NUMBER = /\d[\d,]*\.\d{1,2}(?!\d)|\d{1,3}(?:,\d{3})+(?!\d)|\d\s*%/;

/**
 * The agent's headline when it is valid: one line, at most 60 characters,
 * no prices (no currency sign; no currency word or amount next to digits).
 * Anything else is dropped (null) and the card falls back.
 */
export function validHeadline(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
  if (!s || s.length > HEADLINE_MAX) return null;
  if (CURRENCY_SIGN.test(s)) return null;
  if (/\d/.test(s) && CURRENCY_WORD.test(s)) return null;
  if (PRICE_NUMBER.test(s)) return null;
  return s;
}

const capFirst = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

/** The card's headline: the agent's, else "<first item> and N more" when the quote has 3+ items, else none. */
export function cardHeadline(headline: string | null, itemNames: string[], language: Locale): string | null {
  if (headline) return headline;
  if (itemNames.length < 3) return null;
  return t("buyer.qcard.fallback_headline", { name: capFirst(itemNames[0]), count: itemNames.length - 1 }, language);
}

// ---------------------------------------------------------------------------
// The link a quote message carries (create_quote's tool call result)
// ---------------------------------------------------------------------------

export type QuoteCardLink = {
  messageId: string;
  conversationId: string;
  /** The quote (newer results); older ones only give "Q-1001 v1". */
  quoteId: string | null;
  number: number;
  version: number;
  /** The quote waited for the seller's approval when it was made: the message is the placeholder. */
  held: boolean;
  headline: string | null;
};

type CallLike = { name: string; outcome: string; conversationId?: string; result: Record<string, unknown> | null | undefined };

/** Quote message links from the create_quote calls of conversations, and the cards the app sent after an approval (app_message). */
export function quoteCardLinks(calls: readonly CallLike[]): QuoteCardLink[] {
  const out: QuoteCardLink[] = [];
  for (const c of calls) {
    const r = c.result ?? {};
    const app = c.name === APP_MESSAGE_CALL && r.kind === "quote";
    const id = app ? r.message_id : r.quote_message_id;
    if ((c.name !== "create_quote" && !app) || c.outcome !== "ok" || typeof id !== "string") continue;
    const m = /^Q-(\d+)\s+v(\d+)$/.exec(String(r.quote ?? ""));
    if (!m) continue;
    out.push({
      messageId: id,
      conversationId: c.conversationId ?? "",
      quoteId: typeof r.quote_id === "string" ? r.quote_id : null,
      number: Number(m[1]),
      version: typeof r.quote_version === "number" ? r.quote_version : Number(m[2]),
      held: !app && r.quote_held === true,
      headline: validHeadline(r.headline),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

export type QuoteCardState = "sent" | "held" | "replaced" | "expired" | "withdrawn";

export type QuoteCardRow = { label: string; amount: string; muted?: boolean };
/**
 * One line. `isolate` is the part of the label shown as its own bidi run: the
 * whole "2 × <item name>" ("1 ×" included, so a Latin name in a Hebrew card still
 * reads quantity first), also inside "1 × <item name> · monthly service".
 */
export type QuoteCardLine = { label: string; isolate: string; amount: string; was: string | null };

export type QuoteCardView = {
  messageId: string;
  quoteId: string;
  leadId: string;
  state: QuoteCardState;
  lang: Locale;
  dir: "ltr" | "rtl";
  seller: string;
  initials: string;
  brand: string;
  /** The article's accessible name. */
  label: string;
  /** "Your quote" / "Your updated quote". */
  title: string;
  /** "Q-1001" for version 1, "Q-1001 v2" from version 2 on; null on the held placeholder. */
  ref: string | null;
  /** Under the title instead of seller · ref (the held placeholder). */
  sub: string | null;
  headline: string | null;
  /** The item name inside the fallback headline ("<name> and N more"), isolated when shown so mixed-direction text keeps its order; null for the agent's own headline. */
  headlineName: string | null;
  /** One-time lines; lines past `fold` are folded under `more`. */
  lines: QuoteCardLine[];
  fold: number | null;
  more: string | null;
  /** Discount, subtotal, VAT: before the total (folded with the extra lines on a long quote). */
  rows: QuoteCardRow[];
  total: QuoteCardRow | null;
  /** "Includes VAT 18%" under the total (price lists that include VAT). */
  afterTotal: QuoteCardRow | null;
  monthly: { heading: string | null; lines: QuoteCardLine[]; rows: QuoteCardRow[]; total: QuoteCardRow; afterTotal: QuoteCardRow | null } | null;
  delivery: string | null;
  /** The last date of that delivery estimate (YYYY-MM-DD), when the card shows it: the app's close after an approval says it too. */
  deliveryDate: string | null;
  firstCharge: string | null;
  validUntil: string | null;
  /** The state line (held, replaced, expired, withdrawn) and, when replaced, the old totals. */
  status: string | null;
  summary: string | null;
  /** Seller view only: what the buyer does not see. */
  sellerOnly: { skus: string[]; priceList: string | null } | null;
  /** Seller view, held quote: the approval panel. */
  approval: QuoteApproval | null;
};

export type QuoteApproval = {
  ref: string;
  reasons: string[];
  lines: QuoteCardRow[];
  total: QuoteCardRow | null;
  /** Approve and send works without extra input (nothing left to price). */
  canApprove: boolean;
  /** "Send 5% instead": the only reason is a discount above the limit. */
  inLimitBp: number | null;
};

// Raw rows the loader gives (subsets of the schema's rows).
export type CardQuote = { id: string; leadId: string; number: number; status: string; currentVersion: number };
export type CardVersion = {
  id: string; quoteId: string; version: number; currency: string; pricesIncludeTax: boolean; taxRateBp: number; discountBp: number;
  oneTimeSubtotalMinor: number; oneTimeDiscountMinor: number; oneTimeTaxMinor: number; oneTimeTotalMinor: number;
  recurringSubtotalMinor: number; recurringDiscountMinor: number; recurringTaxMinor: number; recurringTotalMinor: number;
  recurringPeriod: string | null; validUntil: Date; createdAt: Date; priceListId: string | null;
  approvalReasons: { kind: string; requestedBp?: number; limitBp?: number }[];
};
export type CardLine = {
  sku: string; name: string; qty: number; charge: "one_time" | "recurring"; lineTotalMinor: number | null;
  priceSource: string; service: boolean; sortOrder: number;
};

export type CardInput = {
  link: QuoteCardLink;
  /** The message's language (the buyer's). */
  language: string | null;
};

export type CardData = {
  quotes: Map<string, CardQuote>;
  /** Every version of the quotes, by quote id. */
  versions: Map<string, CardVersion[]>;
  lines: Map<string, CardLine[]>;
  /** Last date of the delivery estimate from the version's creation (YYYY-MM-DD), or null. */
  deliveryLatest: Map<string, string | null>;
  priceListNames: Map<string, string>;
  /** Approval reasons in plain words, for the seller's panel. */
  reasonText: (r: CardVersion["approvalReasons"][number]) => string;
};

export type CardContext = { seller: string; /** The seller's trade name per buyer language (decision 2); missing = `seller`. */ sellerLocal?: Partial<Record<string, string>> | null; brand: string; timezone: string; now: Date; audience: "buyer" | "seller" };

/** Two decimals and the price list's currency sign; a minus sign (−) before negative amounts (discounts). */
export const signedMoney = (minor: number, currency: string) => (minor < 0 ? `−${formatMoney(-minor, currency)}` : formatMoney(minor, currency));
const localeOf = (l: string | null | undefined): Locale => (l && isLocale(l) ? l : "en");

export type TotalsInput = { pricesIncludeTax: boolean; taxRateBp: number; discountBp: number; subtotalMinor: number; discountMinor: number; taxMinor: number };

/**
 * The rows around one total (one-time or recurring), as the quote card shows
 * them; the seller's quote detail uses the same rows. Before the total: the
 * discount, then (prices before VAT) Subtotal and VAT. After the total
 * (prices that include VAT): "Includes VAT 18%". No VAT rate: no VAT rows.
 */
export function quoteTotalsRows(
  x: TotalsInput, money: (minor: number) => string, tr: (key: MessageKey, vars?: Record<string, string | number>) => string,
  opts: { subtotal?: boolean } = {},
): { rows: QuoteCardRow[]; afterTotal: QuoteCardRow | null } {
  const vat = x.taxRateBp > 0;
  const rate = percentText(x.taxRateBp);
  const rows: QuoteCardRow[] = [];
  if (x.discountMinor > 0) rows.push({ label: tr("buyer.qcard.discount", { rate: percentText(x.discountBp) }), amount: money(-x.discountMinor) });
  if (vat && !x.pricesIncludeTax) {
    if (opts.subtotal !== false) rows.push({ label: tr("buyer.qcard.subtotal"), amount: money(x.subtotalMinor - x.discountMinor), muted: true });
    rows.push({ label: tr("buyer.qcard.vat", { rate }), amount: money(x.taxMinor), muted: true });
  }
  const afterTotal = vat && x.pricesIncludeTax ? { label: tr("buyer.qcard.includes_vat", { rate }), amount: money(x.taxMinor), muted: true } : null;
  return { rows, afterTotal };
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const charged = (l: CardLine) => l.priceSource !== "not_charged" && (l.lineTotalMinor ?? 0) !== 0;

/** The lines of one charge as the card shows them: zero lines only when the item has no other charge. */
function cardLines(all: CardLine[], charge: CardLine["charge"]): CardLine[] {
  return all
    .filter((l) => l.charge === charge)
    .filter((l) => charged(l) || !all.some((o) => o.sku === l.sku && o.charge !== charge && charged(o)))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Distinct item names in quote order (for the fallback headline). */
function itemNames(lines: CardLine[]): string[] {
  const seen = new Map<string, string>();
  for (const l of [...lines].sort((a, b) => a.sortOrder - b.sortOrder)) if (!seen.has(l.sku)) seen.set(l.sku, l.name);
  return [...seen.values()];
}

/** `superseded`: a held placeholder after which the app sent the quote as a new card ("Send 5% instead"). */
type Resolved = { input: CardInput; quote: CardQuote; version: CardVersion | null; state: QuoteCardState; superseded?: boolean };

/**
 * Card models for quote messages, keyed by message id. `inputs` are in
 * conversation order (oldest first). A held placeholder shows the quote's
 * current version once the seller approved it (replaced in place); a newer
 * card in the same conversation collapses the older ones; a card past its
 * valid-until date is expired.
 */
export function buildQuoteCards(inputs: CardInput[], data: CardData, ctx: CardContext): Record<string, QuoteCardView> {
  const quoteByNumber = new Map([...data.quotes.values()].map((q) => [q.number, q]));
  const resolved: Resolved[] = [];
  inputs.forEach((input, i) => {
    // Newer links name the quote; older ones only its number (always within the account's own quotes).
    const quote = input.link.quoteId ? data.quotes.get(input.link.quoteId) : quoteByNumber.get(input.link.number);
    if (!quote) return;
    const versions = data.versions.get(quote.id) ?? [];
    // A placeholder the app followed with a new card of the same quote stays a collapsed line (it never showed numbers).
    const superseded = input.link.held && inputs.slice(i + 1).some((n) => !n.link.held && n.link.conversationId === input.link.conversationId && n.link.quoteId === quote.id);
    const wanted = input.link.held && !superseded ? quote.currentVersion : input.link.version;
    const version = versions.find((v) => v.version === wanted) ?? null;
    let state: QuoteCardState = "sent";
    if (quote.status === "cancelled") state = "withdrawn";
    else if (superseded) state = "replaced";
    else if (input.link.held && quote.status === "awaiting_approval") state = "held";
    if (!version) state = state === "sent" || superseded ? "withdrawn" : state;
    resolved.push({ input, quote, version, state, superseded: superseded && state === "replaced" });
  });
  // Newer cards (with numbers) collapse older ones of the same conversation.
  const priced = (r: Resolved) => r.state === "sent" && r.version !== null;
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (!priced(r)) continue;
    const later = resolved.slice(i + 1).find((n) => n.input.link.conversationId === r.input.link.conversationId && priced(n));
    if (later) r.state = "replaced";
    else if (r.version!.validUntil.getTime() <= ctx.now.getTime()) r.state = "expired";
  }
  const out: Record<string, QuoteCardView> = {};
  resolved.forEach((r, i) => {
    const earlier = resolved.slice(0, i).reverse().find((p) => p.input.link.conversationId === r.input.link.conversationId && p.version && p.state === "replaced");
    const later = resolved.slice(i + 1).find((n) => n.input.link.conversationId === r.input.link.conversationId && n.state !== "held" && n.state !== "withdrawn" && n.version);
    out[r.input.link.messageId] = cardView(r, data, ctx, { previous: earlier ?? null, next: later ?? null });
  });
  return out;
}

function cardView(r: Resolved, data: CardData, ctx: CardContext, around: { previous: Resolved | null; next: Resolved | null }): QuoteCardView {
  const lang = localeOf(r.input.language);
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(key, vars, lang);
  const v = r.version;
  // The seller's name in the card's language (decision 2).
  const sellerName = ctx.sellerLocal?.[lang]?.trim() || ctx.seller;
  const base: QuoteCardView = {
    messageId: r.input.link.messageId, quoteId: r.quote.id, leadId: r.quote.leadId, state: r.state, lang, dir: dirOf(lang),
    seller: sellerName, initials: initialsOf(sellerName), brand: ctx.brand,
    label: tr("buyer.qcard.aria", { ref: `Q-${r.quote.number}` }), title: tr("buyer.qcard.your_quote"), ref: null, sub: null, headline: null, headlineName: null,
    lines: [], fold: null, more: null, rows: [], total: null, afterTotal: null, monthly: null,
    delivery: null, deliveryDate: null, firstCharge: null, validUntil: null, status: null, summary: null, sellerOnly: null, approval: null,
  };
  if (r.state === "withdrawn" || !v) return { ...base, ref: `Q-${r.quote.number}`, status: tr("buyer.qcard.withdrawn") };
  if (r.state === "held") {
    // The buyer never sees a number while the seller decides.
    const held: QuoteCardView = { ...base, label: tr("buyer.qcard.aria_held"), sub: tr("buyer.qcard.checking"), status: tr("buyer.qcard.held_text", { seller: sellerName }) };
    return ctx.audience === "seller" ? { ...held, approval: approvalOf(r.quote, v, data) } : held;
  }

  const money = (m: number) => signedMoney(m, v.currency);
  const lines = data.lines.get(v.id) ?? [];
  const oneTimeLines = cardLines(lines, "one_time");
  const recurringLines = cardLines(lines, "recurring");
  const hasOneTime = v.oneTimeTotalMinor > 0 || oneTimeLines.some(charged);
  const hasRecurring = v.recurringTotalMinor > 0;
  const year = v.recurringPeriod === "year";
  // The buyer sees a version only from v2 on (live review, Package 3 item 7).
  const ref = v.version > 1 ? `Q-${r.quote.number} v${v.version}` : `Q-${r.quote.number}`;
  const names = itemNames(lines);
  const headline = cardHeadline(r.input.link.headline, names, lang);
  const headlineName = headline && !r.input.link.headline && names.length ? capFirst(names[0]) : null;
  const totalLabel = hasRecurring ? tr("buyer.qcard.today") : tr("buyer.qcard.total");
  // One label for the recurring total on the card and every buyer page (lib/orders/display.ts).
  const periodTotalLabel = tr(recurringTotalKey({ pricesIncludeTax: v.pricesIncludeTax, taxRateBp: v.taxRateBp, taxMinor: v.recurringTaxMinor }, year ? "year" : "month"));
  const seller = ctx.audience === "seller"
    ? { skus: [...new Set(lines.map((l) => l.sku))], priceList: v.priceListId ? data.priceListNames.get(v.priceListId) ?? null : null }
    : null;
  const withRef = { ...base, label: tr("buyer.qcard.aria", { ref }), ref, sellerOnly: seller };

  if (r.state === "replaced") {
    const next = around.next?.version;
    const status = next && around.next!.quote.id === r.quote.id
      ? tr("buyer.qcard.replaced_version", { version: next.version })
      : tr("buyer.qcard.replaced_quote");
    const parts = [
      ...(hasOneTime || !hasRecurring ? [tr("buyer.qcard.sum_today", { amount: money(v.oneTimeTotalMinor) })] : []),
      ...(hasRecurring ? [tr(year ? "buyer.qcard.sum_year" : "buyer.qcard.sum_month", { amount: money(v.recurringTotalMinor) })] : []),
    ];
    return { ...withRef, status, summary: r.superseded ? null : parts.join(" · ") };
  }
  if (r.state === "expired") {
    const total = hasOneTime || !hasRecurring
      ? { label: totalLabel, amount: money(v.oneTimeTotalMinor) }
      : { label: periodTotalLabel, amount: money(v.recurringTotalMinor) };
    return {
      ...withRef, headline, headlineName, total,
      status: tr("buyer.qcard.expired", { date: longDate(v.validUntil, ctx.timezone, lang) }),
    };
  }

  // Lines changed since the card it replaces ("was 2"), or new.
  const prevLines = around.previous?.version ? data.lines.get(around.previous.version.id) ?? [] : null;
  const lineView = (l: CardLine): QuoteCardLine => {
    const name = capFirst(l.name);
    const counted = `${l.qty} × ${name}`;
    // The monthly charge of an item also bought once names the service, so the same item does not read as charged twice.
    const serviceOf = l.charge === "recurring" && lines.some((o) => o.sku === l.sku && o.charge === "one_time");
    // Every line shows its quantity, 1 included ("1 × <item name> · monthly service"), as on the seller side.
    const isolate = counted;
    const label = serviceOf ? tr(year ? "buyer.qcard.service_year" : "buyer.qcard.service_month", { name: isolate }) : isolate;
    const amount = l.lineTotalMinor === null ? "—" : charged(l) ? money(l.lineTotalMinor) : tr("buyer.qcard.included");
    let was: string | null = null;
    if (prevLines) {
      const before = prevLines.find((p) => p.sku === l.sku && p.charge === l.charge);
      if (!before) was = tr("buyer.qcard.new_line");
      else if (before.qty !== l.qty) was = tr("buyer.qcard.was", { qty: before.qty });
    }
    return { label, isolate, amount, was };
  };
  /** The monthly block has no subtotal (board QuoteChat: lines, VAT, Monthly). */
  const sectionRows = (t0: { subtotal: number; discount: number; tax: number }, discountBp: number, subtotal = true) =>
    quoteTotalsRows({ ...v, discountBp, subtotalMinor: t0.subtotal, discountMinor: t0.discount, taxMinor: t0.tax }, money, tr, { subtotal }).rows;
  const includes = (tax: number): QuoteCardRow | null =>
    quoteTotalsRows({ ...v, subtotalMinor: 0, discountMinor: 0, taxMinor: tax }, money, tr).afterTotal;

  const one = hasOneTime || !hasRecurring;
  const shown = oneTimeLines.map(lineView);
  const folded = shown.length > 4 ? shown.length - 4 : 0;
  const ships = oneTimeLines.some((l) => !l.service);
  const latest = data.deliveryLatest.get(v.id) ?? null;
  return {
    ...withRef,
    title: around.previous ? tr("buyer.qcard.your_updated_quote") : tr("buyer.qcard.your_quote"),
    headline,
    headlineName,
    lines: one ? shown : [],
    fold: one && folded ? 4 : null,
    more: one && folded ? tr("buyer.qcard.more", { count: folded }) : null,
    rows: one ? sectionRows({ subtotal: v.oneTimeSubtotalMinor, discount: v.oneTimeDiscountMinor, tax: v.oneTimeTaxMinor }, v.discountBp) : [],
    total: one ? { label: totalLabel, amount: money(v.oneTimeTotalMinor) } : null,
    afterTotal: one ? includes(v.oneTimeTaxMinor) : null,
    monthly: hasRecurring
      ? {
          heading: one ? tr(year ? "buyer.qcard.then_yearly" : "buyer.qcard.then_monthly") : null,
          lines: recurringLines.map(lineView),
          rows: sectionRows({ subtotal: v.recurringSubtotalMinor, discount: v.recurringDiscountMinor, tax: v.recurringTaxMinor }, v.discountBp, false),
          total: { label: periodTotalLabel, amount: money(v.recurringTotalMinor) },
          afterTotal: includes(v.recurringTaxMinor),
        }
      : null,
    delivery: one && ships && latest ? tr("buyer.qcard.delivery", { date: longCalendarDate(latest, lang) }) : null,
    deliveryDate: one && ships && latest ? latest : null,
    firstCharge: !one ? tr("buyer.qcard.first_charge") : null,
    validUntil: tr("buyer.qcard.valid_until", { date: longDate(v.validUntil, ctx.timezone, lang) }),
  };
}

/** The seller's approval panel for a held quote (English, the seller's UI). */
function approvalOf(quote: CardQuote, v: CardVersion, data: CardData): QuoteApproval {
  const money = (m: number) => signedMoney(m, v.currency);
  const lines = cardLines(data.lines.get(v.id) ?? [], "one_time");
  const rows: QuoteCardRow[] = lines.map((l) => ({
    label: `${l.qty} × ${capFirst(l.name)}`,
    amount: l.lineTotalMinor === null ? t("conv.qcard.to_price") : money(l.lineTotalMinor),
  }));
  if (v.oneTimeDiscountMinor > 0) rows.push({ label: t("buyer.qcard.discount", { rate: percentText(v.discountBp) }), amount: money(-v.oneTimeDiscountMinor) });
  const unpriced = (data.lines.get(v.id) ?? []).some((l) => l.lineTotalMinor === null);
  const discountOnly = v.approvalReasons.length > 0 && v.approvalReasons.every((r) => r.kind === "discount_over_limit");
  const limit = v.approvalReasons.find((r) => r.kind === "discount_over_limit")?.limitBp;
  return {
    ref: `Q-${quote.number} v${v.version}`,
    reasons: v.approvalReasons.map(data.reasonText),
    lines: rows,
    total: unpriced ? null : { label: t(v.taxRateBp > 0 ? "conv.qcard.total_incl_vat" : "conv.qcard.total"), amount: money(v.oneTimeTotalMinor) },
    canApprove: !unpriced,
    inLimitBp: discountOnly && typeof limit === "number" && limit > 0 ? limit : null,
  };
}
