/**
 * The owner's voice bundle of 23 Nov 2026, the pure parts (no database, no paid call):
 * - S3: one buyer utterance transcribed twice (a partial closed when the agent started, then the whole line; or a
 *   running transcript sent again) is marked as revising the line already sent (ServerEventMapper), and the engine's
 *   "grown" test for the same line;
 * - S4: the time-limit warning 60 s before on a call of two minutes or more (else 45 s), and how long an agent
 *   mid-response may finish past the limit (at most 8 s, less near the function's end);
 * - S5: a quote for fewer units or sites runs only when the buyer asked for it or said yes to the agent's offer of it;
 * - P1: tool arguments compared as canonical JSON.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, grownFrom, LIMIT_WARN_LONG_SEC, limitWarnSecFor, lineSaysNumber } from "@/lib/voice/engine";
import { smallerQuoteAgreed, smallerQuoteParts } from "@/lib/voice/form-agreement";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";
import { LIMIT_FINISH_MAX_SEC, limitFinishSec } from "@/lib/voice/socket-limits";
import { sameUtterance } from "@/lib/voice/transcript-clean";

const a = (text: string) => ({ role: "agent", text });
const b = (text: string) => ({ role: "buyer", text });
const says = (n: number) => (line: string) => lineSaysNumber(line, n);

describe("S5: a smaller quote needs the buyer's ask first", () => {
  const cases: [string, { role: string; text: string }[], number, "yes" | "no" | "unknown"][] = [
    ["an offer of a smaller start answered with a hedged yes (23 Nov 2026)", [a("Would starting with one site help?"), b("Yeah, I guess so. I need a solution.")], 1, "no"],
    ["the agent asked to prepare the quote; a plain yes", [a("Shall I prepare a quote for one site?"), b("yes please")], 1, "yes"],
    ["the buyer says the new number", [a("Does that look right?"), b("make it for one site")], 1, "yes"],
    ["the buyer asks for a price for a smaller set", [a("Does that look right?"), b("How much would a smaller start cost?")], 1, "yes"],
    ["a yes to a quote question that does not name the smaller set", [a("Shall I prepare the quote?"), b("Yes.")], 1, "no"],
    ["the agent's offer is not a question", [a("I can prepare a quote for one site."), b("Sure.")], 1, "no"],
    ["a yes with a reservation", [a("Shall I prepare a quote for one site?"), b("Yes, but it's still expensive.")], 1, "no"],
    ["a plain answer to something else", [a("Is the price the main concern?"), b("Yes.")], 1, "no"],
    ["Hebrew: an offer of a smaller start, a hedged yes", [a("יעזור להתחיל עם סניף אחד?"), b("כן, נראה לי. אני צריך פתרון.")], 1, "no"],
    ["Hebrew: the agent asked to prepare the quote; a yes", [a("להכין הצעת מחיר לסניף אחד?"), b("כן בבקשה")], 1, "yes"],
    ["Hebrew: the buyer says the new number", [a("נראה טוב?"), b("תעשה את זה לסניף אחד")], 1, "yes"],
    ["Hebrew: a yes to a quote question that does not name the smaller set", [a("להכין הצעת מחיר?"), b("כן")], 1, "no"],
    ["two seats: said in digits", [a("Anything else?"), b("Let's go with 2 seats.")], 2, "yes"],
    ["no buyer line yet", [a("Hello!")], 1, "unknown"],
    ["another language", [a("Hola"), b("да, хорошо")], 1, "unknown"],
  ];
  for (const [name, lines, n, want] of cases) {
    it(name, () => expect(smallerQuoteAgreed(lines, says(n))).toBe(want));
  }
});

describe("S5: what counts as a smaller quote (equal quantities never do)", () => {
  const sensors = (qty: number) => [{ sku: "SENSOR", name: "Temperature sensor", qty, recurring: false }, { sku: "SENSOR", name: "Temperature sensor", qty, recurring: true }];
  const latest = [...sensors(6), { sku: "INSTALL", name: "Installation", qty: 1, recurring: false }];
  type Row = [string, Parameters<typeof smallerQuoteParts>[0], "runs" | "held"];
  const rows: Row[] = [
    // The create_quote's own discount or exception is not an input: the same quantities are the same quote size.
    ["same quantities without discount", { sites: 1, statedSites: 1, asked: [{ sku: "SENSOR", qty: 6 }], latest }, "runs"],
    ["same quantities with an added discount", { sites: 1, statedSites: 1, asked: [{ sku: "sensor", qty: 6 }], latest }, "runs"],
    // A held quote's lines (one-time and subscription for the same item): 6, not 12 (23 Nov 2026).
    ["same quantities after a held quote", { sites: null, statedSites: null, asked: [{ sku: "SENSOR", qty: 6 }], latest: sensors(6) }, "runs"],
    ["same quantities split per site", { sites: 2, statedSites: 2, asked: [{ sku: "SENSOR", qty: 6 }], latest: [...sensors(3), ...sensors(3)] }, "runs"],
    ["fewer units of one item", { sites: 1, statedSites: 1, asked: [{ sku: "SENSOR", qty: 4 }], latest }, "held"],
    ["fewer sites than stated", { sites: 1, statedSites: 2, asked: [{ sku: "SENSOR", qty: 6 }], latest }, "held"],
    ["fewer of one item, more of another", { sites: null, statedSites: null, asked: [{ sku: "SENSOR", qty: 4 }, { sku: "GATEWAY", qty: 1 }], latest }, "runs"],
    ["more units", { sites: null, statedSites: null, asked: [{ sku: "SENSOR", qty: 8 }], latest }, "runs"],
    ["no earlier quote", { sites: null, statedSites: null, asked: [{ sku: "SENSOR", qty: 2 }], latest: [] }, "runs"],
  ];
  for (const [name, input, want] of rows) {
    it(`${name}: ${want}`, () => expect(smallerQuoteParts(input) ? "held" : "runs").toBe(want));
  }
  it("names what it covers less of", () => {
    expect(smallerQuoteParts({ sites: 1, statedSites: 2, asked: [{ sku: "SENSOR", qty: 4 }], latest })).toEqual({ numbers: [1, 4], what: "1 site, 4 × Temperature sensor" });
  });
});

describe("S4: the time limit", () => {
  it("the warning comes 60 s before on a call of two minutes or more; a shorter call keeps 45 s", () => {
    expect(LIMIT_WARN_LONG_SEC).toBe(60);
    expect(limitWarnSecFor(270, 45)).toBe(60);
    expect(limitWarnSecFor(120, 45)).toBe(60);
    expect(limitWarnSecFor(119, 45)).toBe(45);
    expect(limitWarnSecFor(90, 45)).toBe(45);
  });

  it("an agent mid-response finishes it for at most 8 s, never closer than the storing margin to the function's end", () => {
    expect(LIMIT_FINISH_MAX_SEC).toBe(8);
    // The deployment's cap (270 s of a 300 s function): 8 s.
    expect(limitFinishSec(270, 270)).toBe(8);
    expect(limitFinishSec(120, 270)).toBe(8);
    // No function deadline (local dev server): 8 s.
    expect(limitFinishSec(600, null)).toBe(8);
    // A call limit near the function's end: only what leaves 15 s to store the call.
    expect(limitFinishSec(290, 280)).toBe(5);
    expect(limitFinishSec(300, 280)).toBe(0);
  });
});

describe("S3: one buyer utterance, one line", () => {
  type Ev = ReturnType<ServerEventMapper["map"]>[number];
  const buyerFinals = (events: Ev[]) => events.filter((e): e is Extract<Ev, { type: "buyer-transcript" }> => e.type === "buyer-transcript" && e.final);
  const ev = (e: Record<string, unknown>) => ({ raw: null, ...e }) as never;

  it("partial then whole: the line closed when the agent started is revised by the completed transcript", () => {
    const m = new ServerEventMapper();
    const out: Ev[] = [];
    out.push(...m.map(ev({ type: "transcript-fragment", speaker: "user", delta: "I check them by hand", startMs: 0, endMs: 1 })));
    out.push(...m.map(ev({ type: "audio-delta", responseId: "r1", itemId: "i", delta: "AAAA" })));
    out.push(...m.map(ev({ type: "input-transcription-completed", itemId: "u1", transcript: "I check them by hand every morning." })));
    expect(buyerFinals(out)).toEqual([
      { type: "buyer-transcript", text: "I check them by hand", final: true },
      { type: "buyer-transcript", text: "I check them by hand every morning.", final: true, revises: true },
    ]);
  });

  it("a running transcript of one item sent again revises; a new item does not", () => {
    const m = new ServerEventMapper();
    const out: Ev[] = [];
    out.push(...m.map(ev({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites." })));
    out.push(...m.map(ev({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites. Three fridges in each." })));
    out.push(...m.map(ev({ type: "input-transcription-completed", itemId: "u2", transcript: "Two sites." })));
    expect(buyerFinals(out).map((e) => !!e.revises)).toEqual([false, true, false]);
  });

  it("a completed transcript of a different utterance after an early close is a new line", () => {
    const m = new ServerEventMapper();
    const out: Ev[] = [];
    out.push(...m.map(ev({ type: "transcript-fragment", speaker: "user", delta: "Hello", startMs: 0, endMs: 1 })));
    out.push(...m.map(ev({ type: "audio-delta", responseId: "r1", itemId: "i", delta: "AAAA" })));
    out.push(...m.map(ev({ type: "input-transcription-completed", itemId: "u9", transcript: "Two sites, please." })));
    expect(buyerFinals(out).map((e) => !!e.revises)).toEqual([false, false]);
  });

  it("the same line grown, not the same line again", () => {
    expect(grownFrom("Two sites. Three fridges in each.", "Two sites.")).toBe(true);
    expect(grownFrom("Yes.", "Yes.")).toBe(false);
    expect(grownFrom("Yesterday was fine.", "Yes")).toBe(false);
    expect(sameUtterance("I check them by hand every morning.", "i check them by hand")).toBe(true);
    expect(sameUtterance("Hello", "Two sites")).toBe(false);
  });
});

describe("P1: identical tool calls", () => {
  it("compares arguments as canonical JSON (key order does not matter, values do)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ lines: [{ sku: "A", qty: 2 }] })).not.toBe(canonicalJson({ lines: [{ sku: "A", qty: 1 }] }));
    expect(canonicalJson({ lines: [1, 2] })).not.toBe(canonicalJson({ lines: [2, 1] }));
  });
});
