/**
 * Overview V2 KPI cards (O-1, option A): five cards, each a label, one number
 * and a muted line under it. Pure: built from overviewKpis /
 * overviewCardNumbers of the period and of the previous equal period.
 *
 * Money is never added across currencies: with several currencies the
 * largest amount is the number and every currency gets a line of its own.
 * Card amounts are whole (₪12,957); decimals stay on quotes and orders.
 * Percentages are whole numbers, rounded.
 */
import { t, type MessageKey } from "@/lib/i18n";
import type { CurrencyTotal, OverviewCardNumbers, OverviewKpis, PeriodDays } from "./service";

export type KpiAccent = "money" | "agent" | "plain";
export type KpiLine = { text: string; trend?: "up" | "down" };
export type KpiCard = { id: "revenue" | "deals" | "conversion" | "average" | "agent"; label: string; value: string; accent: KpiAccent; lines: KpiLine[] };

/** Minus sign for decreases ("−1", "−₪2,400"), as on the board. */
const MINUS = "−";

/** A whole amount in its currency, rounded: 1_295_650 ILS minor → "₪12,957". */
export function formatWhole(amountMinor: number, currency: string): string {
  const base = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" });
  const digits = base.resolvedOptions().maximumFractionDigits ?? 2;
  const whole = Math.round(amountMinor / 10 ** digits);
  // `+ 0` turns a rounded -0 into 0.
  return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.abs(whole) + 0);
}

/** Whole percentage, rounded; null when there is nothing to divide by. */
export function percent(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

/** "+2 vs previous 30 days" / "−1 vs …" / "No change vs …", with the arrow direction (none for no change). */
export function comparisonLine(diff: number, days: PeriodDays, show: (abs: number) => string = String): KpiLine {
  if (diff === 0) return { text: t("overview.kpi.no_change", { days }) };
  const delta = `${diff > 0 ? "+" : MINUS}${show(Math.abs(diff))}`;
  return { text: t("overview.kpi.vs", { delta, days }), trend: diff > 0 ? "up" : "down" };
}

/** Money comparison in whole units: a difference that rounds to 0 reads "No change". */
function moneyComparison(cur: number, prev: number, currency: string, days: PeriodDays): KpiLine {
  const shown = (m: number) => Math.round(m / 10 ** minorDigits(currency));
  const diff = shown(cur) - shown(prev);
  return comparisonLine(diff, days, (abs) => formatWhole(abs * 10 ** minorDigits(currency), currency));
}

function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export type KpiCardsInput = {
  days: PeriodDays;
  kpis: Pick<OverviewKpis, "formsSigned" | "paidByCurrency">;
  prev: Pick<OverviewKpis, "formsSigned" | "paidByCurrency">;
  cards: OverviewCardNumbers;
  /** The currency to show 0 in when nothing was paid or signed (the selected market's, else the account's). */
  currency: string;
  /**
   * While simulated buyers are included: the simulated share of each card
   * ("incl. N simulated"), from the real-only numbers. Null when they are left out.
   */
  real?: { kpis: Pick<OverviewKpis, "formsSigned" | "paidByCurrency">; cards: OverviewCardNumbers } | null;
};

const simLine = (n: number | string): string => t("overview.incl_simulated", { count: n });
/** The card's own line plus "· incl. N simulated" on the same line. */
const withSim = (lines: KpiLine[], sim: string | null): KpiLine[] =>
  sim === null ? lines : lines.length ? [...lines.slice(0, -1), { ...lines[lines.length - 1], text: `${lines[lines.length - 1].text} · ${simLine(sim)}` }] : [{ text: simLine(sim) }];

const label = (k: MessageKey) => t(k);

export function kpiCards(input: KpiCardsInput): KpiCard[] {
  const { days, kpis, prev, cards, currency, real } = input;

  // Paid revenue: one-time amounts paid in the period, per currency, vs the previous period.
  const currencies = [...new Set([...kpis.paidByCurrency, ...prev.paidByCurrency].map((r) => r.currency))].sort();
  const amount = (rows: CurrencyTotal[], c: string) => rows.find((r) => r.currency === c)?.oneTimeMinor ?? 0;
  const paid = currencies.length
    ? currencies.map((c) => ({ currency: c, cur: amount(kpis.paidByCurrency, c), prev: amount(prev.paidByCurrency, c) }))
    : [{ currency, cur: 0, prev: 0 }];
  const top = paid.reduce((a, b) => (b.cur > a.cur ? b : a));
  const revenueLines: KpiLine[] = paid.length === 1
    ? [moneyComparison(top.cur, top.prev, top.currency, days)]
    : paid.map((p) => {
      const line = moneyComparison(p.cur, p.prev, p.currency, days);
      return { ...line, text: `${formatWhole(p.cur, p.currency)} · ${line.text}` };
    });
  // "incl. N simulated" only when simulated buyers add something to the card (UX: no "incl. 0 simulated").
  const simPaid = real ? paid.map((p) => ({ ...p, sim: p.cur - amount(real.kpis.paidByCurrency, p.currency) })).filter((p) => p.sim !== 0) : [];
  const revenueSim = simPaid.length ? simPaid.map((p) => formatWhole(p.sim, p.currency)).join(" + ") : null;

  // Deals signed: order forms signed in the period.
  const dealsSim = real && kpis.formsSigned !== real.kpis.formsSigned ? kpis.formsSigned - real.kpis.formsSigned : null;

  // Lead to signed / Handled by the agent: of the leads received in the period.
  const leadsSim = real && cards.leadsReceived !== real.cards.leadsReceived ? cards.leadsReceived - real.cards.leadsReceived : null;
  const conv = percent(cards.leadsSigned, cards.leadsReceived);
  const agent = percent(cards.leadsWithoutPerson, cards.leadsReceived);

  // Average deal: the one-time total of forms signed in the period, per currency.
  const avgs = cards.signedByCurrency.filter((r) => r.count > 0).map((r) => ({ currency: r.currency, avg: Math.round(r.oneTimeMinor / r.count) }));
  const topAvg = avgs.length ? avgs.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
  const signedCount = cards.signedByCurrency.reduce((n, r) => n + r.count, 0);
  const realSigned = real ? real.cards.signedByCurrency.reduce((n, r) => n + r.count, 0) : 0;
  const averageLines: KpiLine[] = !topAvg
    ? [{ text: t("overview.kpi.no_deals") }]
    : avgs.length === 1
      ? [{ text: t("overview.kpi.average_line") }]
      : avgs.map((a) => ({ text: `${formatWhole(a.avg, a.currency)} · ${t("overview.kpi.average_line")}` }));

  return [
    {
      id: "revenue", label: label("overview.kpi.revenue"), accent: "money",
      value: formatWhole(top.cur, top.currency),
      lines: withSim(revenueLines, revenueSim),
    },
    {
      id: "deals", label: label("overview.kpi.deals"), accent: "plain",
      value: String(kpis.formsSigned),
      lines: withSim([comparisonLine(kpis.formsSigned - prev.formsSigned, days)], dealsSim === null ? null : String(dealsSim)),
    },
    {
      id: "conversion", label: label("overview.kpi.conversion"), accent: "plain",
      value: conv === null ? "—" : `${conv}%`,
      lines: withSim([{ text: conv === null ? t("overview.kpi.no_leads") : t("overview.kpi.of_leads", { count: cards.leadsSigned, total: cards.leadsReceived }) }], leadsSim === null ? null : String(leadsSim)),
    },
    {
      id: "average", label: label("overview.kpi.average"), accent: "plain",
      value: topAvg ? formatWhole(topAvg.avg, topAvg.currency) : "—",
      lines: withSim(averageLines, real && signedCount !== realSigned ? String(signedCount - realSigned) : null),
    },
    {
      id: "agent", label: label("overview.kpi.agent"), accent: "agent",
      value: agent === null ? "—" : `${agent}%`,
      lines: withSim([{ text: agent === null ? t("overview.kpi.no_leads") : t("overview.kpi.agent_line", { count: cards.leadsWithoutPerson, total: cards.leadsReceived }) }], leadsSim === null ? null : String(leadsSim)),
    },
  ];
}

/**
 * Funnel "From the step before": the % of the previous step (null on the first step; "—" when the previous
 * step is 0, and "—" when it would exceed 100%: each step is counted when it happens, not per lead, so a step
 * can be larger than the one before; `stepOver` marks those for the tooltip).
 */
export function stepPercents(values: readonly number[]): (string | null)[] {
  return values.map((v, i) => {
    if (i === 0) return null;
    const p = percent(v, values[i - 1]);
    return p === null || p > 100 ? "—" : `${p}%`;
  });
}

/** True where the step is larger than the step before (shown as "—" with a tooltip). */
export function stepOver(values: readonly number[]): boolean[] {
  return values.map((v, i) => i > 0 && values[i - 1] > 0 && v > values[i - 1]);
}

/** Order forms signed in the period and not yet paid, as the funnel reads it: signed minus paid, never below 0. */
export function waitingToPay(signed: number, paid: number): number {
  return Math.max(0, signed - paid);
}
