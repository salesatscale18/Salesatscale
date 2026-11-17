/**
 * Scored test rounds (P11.5): the checklist score of one conversation.
 *
 * Pure: no network, no model. Every check is plain code on the transcript, so
 * a score is free and repeatable. Each check is one small entry in CHECKS
 * below: an id, a label, which buyers it applies to, and a function that
 * returns pass / fail / na with a one-line reason. Adjust a check by editing
 * its entry or one of the word lists right above CHECKS.
 *
 * Unit-tested in tests/unit/scored-round.test.ts with fixture transcripts.
 */

// ───────────────────────── Transcript ─────────────────────────

/**
 * Who wrote a message: the buyer; the agent (the model's text); the app (the
 * app-written quote message, kind "quote"); a person on the seller's team.
 */
export type Actor = "buyer" | "agent" | "app" | "human";
/** "order_form": a message that carries the order-form card (link). */
export type MessageKind = "text" | "quote" | "order_form";

export type TranscriptMessage = {
  actor: Actor;
  text: string;
  kind: MessageKind;
  /** For an order-form card: the card's ref and sums as shown ("Order form · Q-1001 v1", "₪2,466.20 today"). */
  card?: string;
};
export type Transcript = TranscriptMessage[];

export type CheckStatus = "pass" | "fail" | "na";
export type CheckResult = { id: string; label: string; status: CheckStatus; reason: string };
export type Score = {
  buyerId: number;
  checks: CheckResult[];
  passed: number;
  failed: number;
  na: number;
  /** "14/16": passed of the checks that applied. */
  total: string;
};

// ───────────────────────── Text helpers ─────────────────────────

/** A message the agent sent (its own text or the order-form card message); the app's quote message is not one. */
export const isAgent = (m: TranscriptMessage) => m.actor === "agent";
export const isQuote = (m: TranscriptMessage) => m.kind === "quote";
/** Agent or app: what the buyer sees from the seller's side, except a person on the team. */
const fromSeller = (m: TranscriptMessage) => m.actor === "agent" || m.actor === "app";

const stripUrls = (s: string) => s.replace(/https?:\/\/\S+/g, " ");

/** Sentences of a message: split on . ! ? … and line breaks; decimals ("1.5") and URLs do not split. */
export function sentences(text: string): string[] {
  return stripUrls(text)
    .replace(/(\d)[.,](\d)/g, "$1§$2")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

const questionMarks = (text: string) => (stripUrls(text).match(/[?؟]/g) ?? []).length;
const endsWithQuestion = (text: string) => /[?؟]\s*["'”)]*\s*$/.test(stripUrls(text).trim());

/** The agent/app messages sent after buyer message `i` and before the next buyer message (one agent turn). */
export function turnAfter(t: Transcript, i: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let j = i + 1; j < t.length && t[j].actor !== "buyer"; j++) if (fromSeller(t[j])) out.push(t[j]);
  return out;
}

/** Index of the first message matching, or -1. */
const firstIndex = (t: Transcript, f: (m: TranscriptMessage) => boolean) => t.findIndex(f);

// ───────────────────────── Word lists (adjust here) ─────────────────────────

/** Catalog SKUs of the Polar Demo account, plus the shape of any SKU (two or more capitals, dash, digits). */
export const CATALOG_SKUS = ["SNS-200", "GW-10", "INST-1"];
const SKU_SHAPE = /\b[A-Z]{2,5}-\d{1,4}\b/;

/** An amount of money: a currency sign or word next to a number. */
const MONEY = /[₪$€£]\s?\d|\d[\d,.]*\s?(?:₪|ILS|NIS|USD|EUR|shekels?|ש["״]?ח|שקל(?:ים)?)/i;
const MONEY_ALL = /[₪$€£]\s?\d[\d,.]*\d|[₪$€£]\s?\d|\d[\d,.]*\s?(?:₪|ILS|NIS|shekels?|ש["״]?ח|שקל(?:ים)?)/gi;
/** Lines of the quote message that carry totals (VAT, today, then, ongoing). */
const TOTAL_LINE = /VAT|Today|Then|Ongoing|Total|מע["״]מ|היום|לאחר מכן|תשלום קבוע|סה["״]כ/i;
/** A message that reads like a quote written as text: several amounts and a total or VAT. */
const looksLikeQuote = (text: string) => (text.match(MONEY_ALL) ?? []).length >= 3 && TOTAL_LINE.test(text);

/** The buyer asks the price. */
const PRICE_ASK = /how much|price|cost|pricing|quote me|כמה (?:זה )?עולה|מחיר|עלות|כמה זה/i;

/** A bare acknowledgement sentence: nothing but "Got it, thanks." and the like. */
const BARE_ACK = /^(?:(?:got it|thanks|thank you|great|ok(?:ay)?|perfect|understood|sure|noted|cool|alright|all right|i see|good|nice|excellent|wonderful|הבנתי|תודה(?: רבה)?|מעולה|אוקיי|אוקי|סבבה|נהדר|מצוין|יופי|בסדר)[\s,.!—–-]*)+$/iu;

/** Asking permission to make the quote ("Would you like me to prepare a quote?"). */
const PERMISSION_FOR_QUOTE = [
  /\b(?:would you like|do you want|shall|should|can|may)\s+(?:me|i)\s+(?:to\s+)?(?:prepare|send|put together|create|draw up|make|get)\b[^?]*\b(?:quote|offer|proposal|price)/i,
  /\bshall i prepare\b/i,
  /\bwant me to prepare\b/i,
  /(?:רוצה|תרצה|תרצי|שאכין|אכין|להכין)[^?]*הצע(?:ת|ה)[^?]*\?/u,
];

/** The close's delivery phrase, in the buyer's language (buyer.quote.delivery_by). */
const BY_ABOUT = /\bby about\b|עד בערך/i;

/** Company details that belong in the order form, not in chat questions. */
const COMPANY_DETAIL = [
  /company(?:'s)? name|name of (?:your|the) (?:company|business)|business name|legal name/i,
  /company (?:id|number|registration)|registration number|business number|vat number|tax id|\bh\.?p\.?\b number/i,
  /billing address|invoice address|address for (?:the )?invoices?/i,
  /invoice e-?mail|e-?mail for (?:the )?invoices?|where should (?:i|we) send the invoice/i,
  /signator|who (?:will|should|would|can) sign|authori[sz]ed to sign/i,
  /your (?:role|position|job title|title)\b|what(?:'s| is) your role/i,
  /שם (?:ה)?חברה|שם העסק|ח\.?פ|מספר (?:עוסק|חברה)|כתובת (?:ל)?(?:חיוב|חשבונית)|מייל (?:ל)?חשבוני|מורשה (?:ה)?חתימה|מי (?:יחתום|חותם)|מה התפקיד|תפקידך/u,
];

/** System talk the buyer should never see. Hebrew "מערכת" is left out: it is the ordinary word for a product set. */
const SYSTEM_TALK = /\btools?\b|\bcatalog(?:ue)?\b|\bsystem\b|appears? to include|\bdatabase\b|\bmy instructions\b|\bfunction call|קטלוג|הכלי\b/i;

/** Banned superlatives (credibility rule: specific beats superlative). */
const SUPERLATIVE = /\b(?:best|amazing|perfect|leading)\b|הכי טוב|הטוב ביותר|מושלם|מדהים|מוביל/i;

/** A self-introduction: "this is Maya", "I'm Maya", "automated assistant". */
const INTRO = /(?:\b[Tt]his is|\bI am|\bI'm|\b[Mm]y name is)\s+\p{Lu}|automated assistant|העוזר(?:\/ת)? האוטומטי|העוזרת האוטומטית|כאן \p{L}+, העוזר/u;

/** Product words of the demo set in plain language: a recommendation names the set. */
const PRODUCT_WORDS = [/sensor|חיישן/i, /hub|gateway|רכזת|מרכזת|שער/i, /install|התקנ/i];

const DISCOUNT = /discount|% off|\boff the price|reduce the price|lower the price|cheaper|הנחה|להוריד (?:את )?המחיר/i;
const URGENCY = /today only|only today|limited time|limited offer|hurry|last chance|act now|don't wait|do not wait|before (?:it'?s|they'?re) gone|only \d+ left|running out|offer ends|רק היום|מבצע מוגבל|מהר|לפני שייגמר|הזדמנות אחרונה/i;
const ASKS_WHAT_IS_OPEN = /what(?:'s| is)? (?:still )?(?:open|unclear|missing)|what would help|anything (?:i can|to) |any question|what questions|what (?:do you|would you) (?:want|need) to (?:know|check)|which part|what part|מה (?:עוד )?(?:פתוח|לא ברור|חסר)|יש (?:לך|לכם)? ?שאל|מה יעזור|משהו ש/i;
const DISCLAIMER = /can'?t speak|cannot speak|can'?t comment|don'?t know (?:their|them|it|much)|not familiar|no information|לא מכיר|לא יכול(?:ה)? להתייחס|אין לי מידע/i;

// ───────────────────────── Buyers the play checks know ─────────────────────────

/** Buyers whose conversation must end at the order form (straight path with bends). */
export const ORDER_FORM_BUYERS = [1, 2, 3, 4, 5, 6];
/** Buyers held to the 8-agent-message limit (exit criterion: the Rina case in 8 or fewer). */
export const SHORT_BUYERS = [1, 2, 6];
export const MAX_AGENT_MESSAGES = 8;
/** The competitor buyer 9 names. */
export const COMPETITOR = "FridgeGuard";

// ───────────────────────── Checks ─────────────────────────

type Ctx = { t: Transcript; buyerId: number };
type Verdict = { status: CheckStatus; reason: string };
type Check = { id: string; label: string; buyers?: number[]; run: (c: Ctx) => Verdict };

const pass = (reason = "ok"): Verdict => ({ status: "pass", reason });
const fail = (reason: string): Verdict => ({ status: "fail", reason });
const na = (reason: string): Verdict => ({ status: "na", reason });
const quoteOf = (s: string, n = 70) => {
  const one = s.replace(/\s+/g, " ").trim();
  return `"${one.length > n ? `${one.slice(0, n - 1)}…` : one}"`;
};

/** The first buyer message matching, the agent's reply turn to it, and its index. */
function replyTo(t: Transcript, re: RegExp): { at: number; turn: TranscriptMessage[] } | null {
  const at = t.findIndex((m) => m.actor === "buyer" && re.test(m.text));
  return at < 0 ? null : { at, turn: turnAfter(t, at).filter(isAgent) };
}

export const CHECKS: Check[] = [
  {
    id: "reacts_first",
    label: "Reacts to an answer before the next question",
    run: ({ t }) => {
      for (let i = 0; i < t.length; i++) {
        if (t[i].actor !== "buyer" || questionMarks(t[i].text) > 0) continue; // only answers, not the buyer's own questions
        const first = turnAfter(t, i).find(isAgent);
        if (!first) continue;
        const ss = sentences(first.text);
        if (ss.length >= 2 && BARE_ACK.test(ss[0]) && endsWithQuestion(ss[1])) return fail(`bare acknowledgement then a question: ${quoteOf(first.text)}`);
        if (ss.length >= 1 && endsWithQuestion(ss[0]) && !BARE_ACK.test(ss[0])) return fail(`asks without reacting: ${quoteOf(first.text)}`);
      }
      return pass();
    },
  },
  {
    id: "no_early_price",
    label: "No price before the quote unless the buyer asked",
    run: ({ t }) => {
      const q = firstIndex(t, isQuote);
      const end = q < 0 ? t.length : q;
      for (let i = 0; i < end; i++) {
        const m = t[i];
        if (!isAgent(m) || !MONEY.test(m.text)) continue;
        const asked = t.slice(0, i).some((b) => b.actor === "buyer" && PRICE_ASK.test(b.text));
        if (!asked) return fail(`price before the quote: ${quoteOf(m.text)}`);
      }
      return pass();
    },
  },
  {
    id: "no_sku",
    label: "No SKU outside the quote",
    run: ({ t }) => {
      for (const m of t.filter(isAgent)) {
        const sku = CATALOG_SKUS.find((s) => m.text.includes(s)) ?? m.text.match(SKU_SHAPE)?.[0];
        if (sku) return fail(`SKU ${sku} in ${quoteOf(m.text)}`);
      }
      return pass();
    },
  },
  {
    id: "recommendation",
    label: "A recommendation before the quote, ending with a question",
    run: ({ t }) => {
      const q = firstIndex(t, isQuote);
      if (q < 0) return na("no quote");
      const recs = t.slice(0, q).filter((m) => isAgent(m) && PRODUCT_WORDS.filter((w) => w.test(m.text)).length >= 2);
      if (recs.length === 0) return fail("no message names the set before the quote");
      const last = recs[recs.length - 1];
      return endsWithQuestion(last.text) ? pass() : fail(`recommendation does not end with a question: ${quoteOf(last.text)}`);
    },
  },
  {
    id: "no_permission_question",
    label: "No permission question for the quote",
    run: ({ t }) => {
      const m = t.filter(isAgent).find((x) => PERMISSION_FOR_QUOTE.some((re) => re.test(x.text)));
      return m ? fail(`asks permission: ${quoteOf(m.text)}`) : pass();
    },
  },
  {
    id: "one_quote_message",
    label: "One quote message per quote, totals not repeated",
    run: ({ t }) => {
      const quotes = t.map((m, i) => ({ m, i })).filter(({ m }) => isQuote(m));
      if (quotes.length === 0) {
        const plain = t.find((m) => isAgent(m) && looksLikeQuote(m.text));
        return plain ? fail(`quote written as plain text: ${quoteOf(plain.text)}`) : na("no quote");
      }
      for (let k = 1; k < quotes.length; k++) {
        const between = t.slice(quotes[k - 1].i + 1, quotes[k].i).some((m) => m.actor === "buyer");
        if (!between) return fail("two quote messages in one turn");
        if (quotes[k].m.text === quotes[k - 1].m.text) return fail("the same quote sent twice");
      }
      for (const { m, i } of quotes) {
        const totals = m.text.split("\n").filter((l) => TOTAL_LINE.test(l)).join("\n");
        const amounts = new Set((totals.match(MONEY_ALL) ?? []).map((a) => a.replace(/\s/g, "")));
        const next = quotes.find((x) => x.i > i)?.i ?? t.length;
        for (const a of t.slice(i + 1, next).filter(isAgent)) {
          const repeated = (a.text.match(MONEY_ALL) ?? []).map((x) => x.replace(/\s/g, "")).find((x) => amounts.has(x));
          if (repeated) return fail(`repeats ${repeated} after the quote: ${quoteOf(a.text)}`);
          if (looksLikeQuote(a.text)) return fail(`quote repeated as plain text: ${quoteOf(a.text)}`);
        }
      }
      return pass(`${quotes.length} quote message${quotes.length > 1 ? "s" : ""}`);
    },
  },
  {
    id: "quote_vat",
    label: "The quote message shows VAT",
    run: ({ t }) => {
      // A replaced, withdrawn or expired card collapses to one line without VAT by design; only live quotes count.
      const quotes = t.filter(isQuote).filter((q) => !/Replaced by|Withdrawn|Expired on|הוחלפה|בוטלה|פג תוקף/.test(q.text));
      if (quotes.length === 0) return na("no quote");
      // The text quote has label and amount on one line; the designed card (P11 wave 2) has them on two rows.
      const bad = quotes.find((q) => {
        const lines = q.text.split("\n");
        return !lines.some((l, i) => /VAT|מע["״]מ/.test(l) && (MONEY.test(l) || MONEY.test(lines[i + 1] ?? "")));
      });
      return bad ? fail("no VAT line with an amount") : pass();
    },
  },
  {
    id: "close_by_about",
    label: "A close with \"by about <date>\" with the quote",
    run: ({ t }) => {
      const at = t.map((m, i) => (isQuote(m) ? i : -1)).filter((i) => i >= 0);
      if (at.length === 0) return na("no quote");
      for (const i of at) {
        // The same turn: from the buyer message before the quote to the next buyer message.
        let s = i;
        while (s > 0 && t[s - 1].actor !== "buyer") s--;
        let e = i;
        while (e + 1 < t.length && t[e + 1].actor !== "buyer") e++;
        const close = t.slice(s, e + 1).find((m) => isAgent(m) && BY_ABOUT.test(m.text));
        if (!close) return fail("no \"by about\" close in the quote's turn");
        if (!endsWithQuestion(close.text)) return fail(`close does not end with a question: ${quoteOf(close.text)}`);
      }
      return pass();
    },
  },
  {
    id: "no_company_questions",
    label: "No company-detail questions in chat",
    run: ({ t }) => {
      for (const m of t.filter(isAgent)) {
        const q = sentences(m.text).find((s) => /[?؟]/.test(s) && COMPANY_DETAIL.some((re) => re.test(s)));
        if (q) return fail(`asks for company details: ${quoteOf(q)}`);
      }
      return pass();
    },
  },
  {
    id: "no_system_talk",
    label: "No system talk (tool, catalog, system)",
    run: ({ t }) => {
      const m = t.filter(isAgent).find((x) => SYSTEM_TALK.test(stripUrls(x.text)));
      return m ? fail(`"${stripUrls(m.text).match(SYSTEM_TALK)![0]}" in ${quoteOf(m.text)}`) : pass();
    },
  },
  {
    id: "no_superlatives",
    label: "No banned superlatives (best, amazing, perfect, leading)",
    run: ({ t }) => {
      const m = t.filter(isAgent).find((x) => SUPERLATIVE.test(x.text));
      return m ? fail(`"${m.text.match(SUPERLATIVE)![0]}" in ${quoteOf(m.text)}`) : pass();
    },
  },
  {
    id: "short_messages",
    label: "At most 3 sentences (the recommendation 4) and one question per message (two once)",
    run: ({ t }) => {
      let twoQuestions = 0;
      // The recommendation (the last agent message before the first quote, ending with a question) has four parts by design.
      const firstQuote = t.findIndex(isQuote);
      let rec = -1;
      for (let i = (firstQuote < 0 ? t.length : firstQuote) - 1; i >= 0; i--) if (isAgent(t[i])) { rec = t[i].text.trim().endsWith("?") ? i : -1; break; }
      for (const [i, m] of t.entries()) {
        if (!isAgent(m)) continue;
        const n = sentences(m.text).length;
        if (n > (i === rec ? 4 : 3)) return fail(`${n} sentences: ${quoteOf(m.text)}`);
        const q = questionMarks(m.text);
        if (q > 2) return fail(`${q} questions: ${quoteOf(m.text)}`);
        if (q === 2 && ++twoQuestions > 1) return fail(`two questions in a message more than once: ${quoteOf(m.text)}`);
      }
      return pass();
    },
  },
  {
    id: "single_intro",
    label: "Introduces itself once",
    run: ({ t }) => {
      const n = t.filter((m) => isAgent(m) && INTRO.test(m.text)).length;
      return n <= 1 ? pass(n === 1 ? "once" : "no introduction") : fail(`introduces itself ${n} times`);
    },
  },
  {
    id: "agent_message_count",
    label: `At most ${MAX_AGENT_MESSAGES} agent messages`,
    buyers: SHORT_BUYERS,
    run: ({ t }) => {
      const n = t.filter(isAgent).length;
      return n <= MAX_AGENT_MESSAGES ? pass(`${n} agent messages`) : fail(`${n} agent messages`);
    },
  },
  {
    id: "order_form_reached",
    label: "Reaches the order form",
    buyers: ORDER_FORM_BUYERS,
    run: ({ t }) => (t.some((m) => m.kind === "order_form") ? pass() : fail("no order-form card")),
  },
  {
    id: "play_price_objection",
    label: "Too expensive: no discount in the first reply",
    buyers: [4],
    run: ({ t }) => {
      const r = replyTo(t, /expensive|too much|pricey|יקר/i);
      if (!r) return na("the buyer did not raise the price");
      if (r.turn.length === 0) return fail("no reply to the objection");
      const d = r.turn.find((m) => DISCOUNT.test(m.text));
      return d ? fail(`offers a discount at once: ${quoteOf(d.text)}`) : pass();
    },
  },
  {
    id: "play_sceptic",
    label: "Sceptic: ends with a check question, no superlative",
    buyers: [7],
    run: ({ t }) => {
      const r = replyTo(t, /really work|does it work|actually work|באמת עובד/i);
      if (!r) return na("the buyer did not ask");
      if (r.turn.length === 0) return fail("no reply to the doubt");
      const last = r.turn[r.turn.length - 1];
      if (!endsWithQuestion(last.text)) return fail(`reply does not end with a check question: ${quoteOf(last.text)}`);
      const sup = r.turn.find((m) => SUPERLATIVE.test(m.text));
      return sup ? fail(`superlative in the reply: ${quoteOf(sup.text)}`) : pass();
    },
  },
  {
    id: "play_think_it_over",
    label: "Think it over: asks what is still open, no urgency",
    buyers: [8],
    run: ({ t }) => {
      const r = replyTo(t, /think|partner|שותף|לחשוב/i);
      if (!r) return na("the buyer did not ask for time");
      if (r.turn.length === 0) return fail("no reply");
      const rest = t.slice(r.at + 1).filter(isAgent);
      const urgent = rest.find((m) => URGENCY.test(m.text));
      if (urgent) return fail(`urgency: ${quoteOf(urgent.text)}`);
      const asks = r.turn.some((m) => endsWithQuestion(m.text) && ASKS_WHAT_IS_OPEN.test(m.text));
      return asks ? pass() : fail(`does not ask what is still open: ${quoteOf(r.turn.map((m) => m.text).join(" "))}`);
    },
  },
  {
    id: "play_competitor",
    label: "Competitor: no claim about the named competitor",
    buyers: [9],
    run: ({ t }) => {
      const r = replyTo(t, new RegExp(COMPETITOR, "i"));
      if (!r) return na("the buyer did not name a competitor");
      const name = new RegExp(`${COMPETITOR}|unlike (?:them|theirs)|\\bthey (?:don'?t|can'?t|only|charge)|their (?:sensors?|devices?|product|price|alerts?)`, "i");
      for (const m of t.slice(r.at + 1).filter(isAgent)) {
        for (const s of sentences(m.text)) {
          if (name.test(s) && !DISCLAIMER.test(s)) return fail(`claim about the competitor: ${quoteOf(s)}`);
        }
      }
      return pass();
    },
  },
];

/** Scores one conversation. Checks that do not apply to this buyer are "na". */
export function scoreTranscript(t: Transcript, buyerId: number): Score {
  const checks: CheckResult[] = CHECKS.map((c) => {
    const v = c.buyers && !c.buyers.includes(buyerId) ? na("not for this buyer") : c.run({ t, buyerId });
    return { id: c.id, label: c.label, ...v };
  });
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return { buyerId, checks, passed, failed, na: checks.length - passed - failed, total: `${passed}/${passed + failed}` };
}
