/**
 * Playbook home and the part menu: one plain line per part, built from the
 * SAVED draft values, and the gaps that can be computed today (no invented
 * ones). Pure; unit-tested.
 */
import type { Playbook } from "@/db/schema";
import { t, type MessageKey } from "@/lib/i18n";
import { openerParts, readOpener } from "@/lib/agent/core/opener";
import { agentGenderOf } from "@/lib/agent/core/names";
import { questionBudgetOf } from "@/lib/agent/core/stage";
import { objectionAttemptsOf } from "@/lib/agent/core/objections";
import { unpaidRemindersOf, type PlaybookWithUnpaid } from "@/lib/orders/unpaid-reminders";
import type { PlaybookPart } from "@/lib/agent/playbook-parts";
import { activeOffers, offersOf, type StoredOffer } from "@/lib/agent/offer-settings";
import type { PlaysSummary } from "./plays/overview";

export const PART_LABEL: Record<PlaybookPart, MessageKey> = {
  agent: "playbook.part.agent", opening: "playbook.part.opening", asks: "playbook.part.asks", plays: "playbook.part.plays", objections: "playbook.part.objections",
  offers: "playbook.part.offers", close: "playbook.part.close", limits: "playbook.part.limits", never: "playbook.part.never", after: "playbook.part.after",
};

/** One line under the part's name in its view (UX: one line each; the rest sits behind the part's "How … works" disclosure). */
export const PART_SUB: Record<PlaybookPart, MessageKey> = {
  agent: "playbook.part_sub.agent", opening: "playbook.part_sub.opening", asks: "playbook.part_sub.asks", plays: "playbook.part_sub.plays", objections: "playbook.part_sub.objections",
  offers: "playbook.part_sub.offers", close: "playbook.part_sub.close", limits: "playbook.part_sub.limits", never: "playbook.part_sub.never", after: "playbook.part_sub.after",
};

export type PartLine = { summary: string; short: string };

const count = (n: number, one: MessageKey, many: MessageKey, none?: MessageKey) => (n === 0 && none ? t(none) : t(n === 1 ? one : many, { n }));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Chat questions: the ones the agent asks (order-form fields are filled in the order form). */
export const chatQuestions = (p: Pick<Playbook, "fields">) => p.fields.filter((f) => f.stage !== "before_order_form");

/** The ways a deal can close, as one line ("Order form with card or bank transfer · or a booked call"). */
export function closeLine(o: Playbook["outcomes"]): string {
  const pay = o.orderForm && o.bankTransfer ? "playbook.sum.close_card_bank" : o.orderForm ? "playbook.sum.close_card" : o.bankTransfer ? "playbook.sum.close_bank" : null;
  if (!pay && !o.meeting) return t("playbook.sum.close_none");
  if (!pay) return t("playbook.sum.close_call_only");
  return o.meeting ? `${t(pay)} · ${t("playbook.sum.close_or_call")}` : t(pay);
}

/** "Reminders after 2 and 5 days · tells your team after 7". */
export function afterLine(p: Playbook): { summary: string; short: string } {
  const u = unpaidRemindersOf(p as PlaybookWithUnpaid);
  const on = [u.first, u.second].filter((s) => s.on).map((s) => s.days);
  const reminders = on.length === 2 ? t("playbook.sum.after_two", { a: on[0], b: on[1] }) : on.length === 1 ? t(on[0] === 1 ? "playbook.sum.after_one_day" : "playbook.sum.after_one", { a: on[0] }) : t("playbook.sum.after_none");
  const team = u.team.on ? t(u.team.days === 1 ? "playbook.sum.after_team_day" : "playbook.sum.after_team", { c: u.team.days }) : t("playbook.sum.after_team_off");
  const step = (s: { on: boolean; days: number }) => (s.on ? String(s.days) : t("playbook.unpaid.off"));
  return { summary: `${reminders} · ${team}`, short: t("playbook.sum.after_short", { a: step(u.first), b: step(u.second), c: step(u.team) }) };
}

/**
 * Offers: the active offers in the agent's order, with their most off
 * ("A smaller first step · More units 5% · General discount 5%"), and their count.
 */
export function offersLine(p: Pick<Playbook, "maxDiscountBp"> & { offers?: unknown }): PartLine {
  const active = activeOffers(offersOf(p));
  const one = (o: StoredOffer) => {
    const name = t(`playbook.offers.type.${o.type}` as MessageKey);
    return o.type === "smaller_start" ? name : t("playbook.sum.offer_pct", { name, pct: (o.percentBp ?? 0) / 100 });
  };
  return { summary: active.map(one).join(" · "), short: count(active.length, "playbook.sum.offers_one", "playbook.sum.offers") };
}

/** The part lines for home (summary) and the part menu (short). */
export function partLines(p: Playbook, ctx: { plays: PlaysSummary }): Record<PlaybookPart, PartLine> {
  const gender = agentGenderOf(p);
  const tone = oneLine(p.tone);
  const o = readOpener(p.opener);
  const opener = o.topics.length || o.question
    ? (() => { const parts = openerParts({ name: "", agent: "", company: "", language: "en", opener: p.opener }); return t("playbook.sum.quote", { text: `${parts.interest} ${parts.question}` }); })()
    : t("playbook.sum.opening_none");
  const asks = chatQuestions(p).length;
  const objections = p.objections.length;
  const ways = [p.outcomes.orderForm, p.outcomes.bankTransfer, p.outcomes.meeting].filter(Boolean).length;
  const handOff = oneLine(p.handOffWhen);
  return {
    agent: { summary: [p.agentName, t(`playbook.sum.speaks.${gender}` as MessageKey), tone].filter(Boolean).join(" · "), short: p.agentName },
    opening: { summary: opener, short: count(o.topics.length, "playbook.sum.topics_one", "playbook.sum.topics", "playbook.sum.topics_none") },
    asks: {
      summary: `${count(asks, "playbook.sum.questions_one", "playbook.sum.questions", "playbook.sum.questions_none")} · ${t("playbook.sum.recommends_after", { n: questionBudgetOf(p) })}`,
      short: count(asks, "playbook.sum.questions_one", "playbook.sum.questions", "playbook.sum.questions_none"),
    },
    plays: { summary: t("playbook.sum.plays", { total: ctx.plays.total, n: ctx.plays.withFacts }), short: t("playbook.sum.plays_short", { total: ctx.plays.total }) },
    objections: {
      summary: `${count(objections, "playbook.sum.objections_one", "playbook.sum.objections", "playbook.sum.objections_none")} · ${t(objectionAttemptsOf(p) === 1 ? "playbook.sum.attempts_one" : "playbook.sum.attempts", { n: objectionAttemptsOf(p) })}`,
      short: count(objections, "playbook.sum.objections_one", "playbook.sum.objections", "playbook.sum.objections_none"),
    },
    offers: offersLine(p),
    close: { summary: closeLine(p.outcomes), short: count(ways, "playbook.sum.ways_one", "playbook.sum.ways", "playbook.sum.ways_none") },
    limits: {
      // Discounts live in Offers (set per offer); Limits is the hand-over rules.
      summary: handOff ? `${t("playbook.sum.limits")} · ${t("playbook.sum.hands_over", { text: handOff })}` : t("playbook.sum.limits"),
      short: t("playbook.sum.limits_short"),
    },
    never: { summary: count(p.neverDo.length, "playbook.sum.rules_one", "playbook.sum.rules", "playbook.sum.rules_none"), short: count(p.neverDo.length, "playbook.sum.rules_one", "playbook.sum.rules", "playbook.sum.rules_none") },
    after: afterLine(p),
  };
}

/** A gap worth a look: computable from today's data only. `part` null: it lives outside the playbook (Knowledge). */
export type GapNote = { id: string; part: PlaybookPart | null; text: string; link: string; href: string };

/**
 * The gaps shown on home ("Worth a look"): an opening without its question,
 * chat questions without an example, plays that ask for facts while no play has any, and buyer questions
 * the agent could not answer (Knowledge).
 */
export function gapNotes(p: Playbook, ctx: {
  plays: PlaysSummary; unanswered: number; href: { part: (part: PlaybookPart) => string; playsNeeds: string; questions: string };
}): GapNote[] {
  const out: GapNote[] = [];
  const o = readOpener(p.opener);
  // A gap that one row fixes opens that row (`?edit=<row>`); several rows: the part's list.
  if (!o.question) out.push({ id: "opening_question", part: "opening", text: t("playbook.gap.opening_question"), link: t("playbook.gap.add_one"), href: `${ctx.href.part("opening")}?edit=question` });
  const missing = p.fields.flatMap((f, i) => (f.stage !== "before_order_form" && !f.example?.trim() ? [i] : []));
  const noExample = missing.length;
  if (noExample) out.push({ id: "examples", part: "asks", text: t(noExample === 1 ? "playbook.gap.examples_one" : "playbook.gap.examples", { n: noExample }), link: t("playbook.gap.add_examples"), href: noExample === 1 ? `${ctx.href.part("asks")}?edit=field.${missing[0]}` : ctx.href.part("asks") });
  // Plays work without facts (UX after S2): a note only when no play has the seller's facts yet.
  if (ctx.plays.sharper && ctx.plays.withFacts === 0) out.push({ id: "plays", part: "plays", text: t(ctx.plays.sharper === 1 ? "playbook.gap.plays_one" : "playbook.gap.plays", { n: ctx.plays.sharper }), link: t("playbook.gap.add_facts"), href: ctx.href.playsNeeds });
  if (ctx.unanswered) out.push({ id: "questions", part: null, text: t(ctx.unanswered === 1 ? "playbook.gap.questions_one" : "playbook.gap.questions", { n: ctx.unanswered }), link: t("playbook.gap.answer_them"), href: ctx.href.questions });
  return out;
}
