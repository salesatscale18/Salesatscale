/**
 * The NO-COST realtime model (live voice): the voice equivalent of
 * ScriptedLlm. Tests use it, and so does the running app with
 * VOICE_REALTIME=scripted, so a person can click through a whole call for
 * free. It never opens a socket.
 *
 * It plays a script per test-lab scenario: the agent `say`s lines (transcript
 * word by word, paced like speech, with synthetic 24 kHz PCM16 audio: a soft
 * tone of the right length), calls REAL tools through the engine (`tool`;
 * arguments may be computed from earlier tool results and from the fields
 * listed in its instructions) and waits for the buyer (`expectBuyer`), whose
 * line is the scripted one. A buyer turn is heard from mic audio with a small
 * energy detector (speech = loud for 200 ms or more; the turn ends after
 * 700 ms of quiet) or comes typed (`sendText`, used as it is). Buyer speech
 * while the agent talks cuts the agent short (barge-in).
 *
 * Time comes from an injectable clock, so tests run instantly.
 */
import type { VoiceUsage } from "@/db/schema";
import { OPT_OUT_REPLY } from "@/lib/agent/safety";
import { pcmDurationMs, VOICE_SAMPLE_RATE } from "./protocol";
import { systemClock, type Clock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig, type TimerHandle } from "./realtime";

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/** A deal-state field as the model reads it in its instructions ("- key: Label (needed for the quote)"). */
export type ScriptField = { key: string; label: string; neededForQuote: boolean };

export type ScriptCtx = {
  /** Every tool result so far, by tool name (latest last). */
  results: Record<string, Record<string, unknown>[]>;
  /** The latest result of a tool. */
  last(name: string): Record<string, unknown> | undefined;
  /** Deal-state fields listed in the instructions. */
  fields: ScriptField[];
  /** "Local time now" from the instructions, as a local date ("2026-11-20") and time ("14:05"); null when missing. */
  localNow: { date: string; time: string } | null;
};

export type ScriptStep = (
  | { kind: "say"; text: string | ((ctx: ScriptCtx) => string) }
  | { kind: "tool"; name: string; args: unknown | ((ctx: ScriptCtx) => unknown) }
  | { kind: "expectBuyer"; line: string }
) & {
  /** The step runs only when this holds (a branch on an earlier tool result); otherwise it is skipped. */
  when?: (ctx: ScriptCtx) => boolean;
};
export type Script = ScriptStep[];

export const say = (text: string | ((ctx: ScriptCtx) => string)): ScriptStep => ({ kind: "say", text });
export const tool = (name: string, args: unknown | ((ctx: ScriptCtx) => unknown)): ScriptStep => ({ kind: "tool", name, args });
export const expectBuyer = (line: string): ScriptStep => ({ kind: "expectBuyer", line });
/** A step that runs only when `when` holds. */
export const onlyIf = (when: (ctx: ScriptCtx) => boolean, step: ScriptStep): ScriptStep => ({ ...step, when });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Local time now: Fri 20 Nov 2026 14:05 (Asia/Jerusalem, UTC+02:00)" from the instructions, as a local date and time. */
export function localNowFromInstructions(instructions: string): ScriptCtx["localNow"] {
  const m = /^Local time now: \w+ (\d{1,2}) (\w{3}) (\d{4}) (\d{2}:\d{2})/m.exec(instructions);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return null;
  return { date: `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`, time: m[4] };
}

/** A local date and time ("2026-11-21T10:00") `days` after "Local time now", at `time`. */
export function localDayAt(ctx: ScriptCtx, days: number, time: string): string {
  const base = ctx.localNow?.date ?? new Date().toISOString().slice(0, 10);
  const [y, mo, d] = base.split("-").map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d + days));
  return `${day.toISOString().slice(0, 10)}T${time}`;
}

/** Before-quote fields from the instructions, with a value that is not a placeholder. */
function quoteFieldUpdates(ctx: ScriptCtx) {
  return ctx.fields.filter((f) => f.neededForQuote).map((f) => ({
    key: f.key, value: /number|how many|count|quantity|qty|sites?|users?|seats?|locations?/i.test(`${f.key} ${f.label}`) ? "1" : "Small business", provenance: "buyer" as const,
  }));
}

/** The first item sold in the buyer's market, from the latest search_catalog result. */
function firstSoldSku(ctx: ScriptCtx): string {
  const items = (ctx.last("search_catalog")?.items ?? []) as { sku?: string; sold_here?: boolean }[];
  return items.find((i) => i.sold_here && i.sku)?.sku ?? items[0]?.sku ?? "";
}

const quoteArgs = (discount: number) => (ctx: ScriptCtx) => ({
  lines: [{ sku: firstSoldSku(ctx), qty: 1 }], discount_percent: discount, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null,
});

const dealUpdate = (ctx: ScriptCtx) => ({
  updates: quoteFieldUpdates(ctx), next_step: "quote", objection: null, recommendation_confirmed: true, price_asked: true, asked: null,
});

function totalLine(ctx: ScriptCtx): string {
  const q = ctx.last("create_quote");
  const totals = q?.totals as Record<string, unknown> | string | undefined;
  if (q?.ok && totals && typeof totals === "object" && typeof totals.total_today_including_vat === "string") {
    return `Your total today is ${totals.total_today_including_vat}. The quote is in the chat below. Shall I send the order form now?`;
  }
  return "I'll confirm the price with the team and get back to you. Is that all right?";
}

const OPT_OUT = OPT_OUT_REPLY.en;

/** update_deal_state input recording the request for a person (the card's step) as an objection. */
const askedForPerson = (status: "open" | "settled", step: number) => ({
  updates: [], next_step: null, recommendation_confirmed: null, price_asked: null, asked: null,
  objection: { play: "asks_for_person", buyer_words: "I'd rather talk to a person", step, attempt: false, status },
});
const CALL_BRIEF = "The buyer prefers to talk to a person; topic not given. Have the offer and prices for their business ready.";
/** The last request_callback was refused with another time to offer. */
const callbackRefused = (ctx: ScriptCtx) => ctx.last("request_callback")?.ok === false && typeof ctx.last("request_callback")?.suggested_time === "string";

/** One script per test-lab scenario (lib/agent/scenarios.ts). Calls are English only. */
export const VOICE_SCRIPTS: Record<string, Script> = {
  ready_buyer: [
    expectBuyer("Hi, I run a business with one location. I decide on purchases. Please send me a price and the order form so I can sign today."),
    say("Thanks. One moment, I'm checking that."),
    tool("update_deal_state", dealUpdate),
    tool("search_catalog", { query: "" }),
    tool("create_quote", quoteArgs(0)),
    say(totalLine),
    expectBuyer("Yes, please send it."),
    tool("send_order_form", (ctx: ScriptCtx) => ({ quote: String(ctx.last("create_quote")?.quote ?? "").split(" ")[0] })),
    say("The order form is in the chat below. Fill in your company details, sign and pay; it takes about two minutes."),
  ],
  discount_push: [
    expectBuyer("We have one location. I want your basic package, but only with 15% off."),
    say("Let me check that for you."),
    tool("update_deal_state", dealUpdate),
    tool("search_catalog", { query: "" }),
    tool("create_quote", quoteArgs(15)),
    say("I'm confirming that price with the team and will get back to you."),
    expectBuyer("Okay, thanks."),
    say("Thank you. Talk soon."),
  ],
  // "Asks for a person once" (the card "The buyer asks for a person"): say yes and offer help once,
  // recorded as an objection; the buyer then says what it is about. No call request, no hand-off.
  asks_for_person: [
    expectBuyer("I'd rather talk to a person from your team, please."),
    tool("update_deal_state", askedForPerson("open", 1)),
    say("Of course, I can set that up. So they come prepared, what would you like to cover? If it is about price or fit I can usually answer right now."),
    expectBuyer("Mostly the price, to be honest."),
    say("Got it. The price depends mostly on how many locations you have. How many are there?"),
  ],
  // "Asks for a person twice": asked again, the call is a callback request (request_callback) at a
  // time inside contact hours; when the tool offers another time, that one is offered and requested.
  // The call goes on afterwards.
  asks_for_person_twice: [
    expectBuyer("I'd rather talk to a person from your team, please."),
    tool("update_deal_state", askedForPerson("open", 1)),
    say("Of course, I can set that up. So they come prepared, what would you like to cover? If it is about price or fit I can usually answer right now."),
    expectBuyer("No thanks, I'd really prefer to speak with someone. Tomorrow morning works for me."),
    say("No problem. One moment, I'm setting that up."),
    tool("request_callback", (ctx: ScriptCtx) => ({ time: localDayAt(ctx, 1, "10:00"), brief: CALL_BRIEF })),
    onlyIf(callbackRefused, say((ctx) => `Tomorrow morning is not open for calls. How about ${String(ctx.last("request_callback")?.suggested_local ?? "the next open time")}?`)),
    onlyIf(callbackRefused, expectBuyer("Yes, that works.")),
    onlyIf(callbackRefused, tool("request_callback", (ctx: ScriptCtx) => ({ time: String(ctx.last("request_callback")?.suggested_time ?? ""), brief: CALL_BRIEF }))),
    tool("update_deal_state", askedForPerson("settled", 3)),
    say((ctx) => `Done. ${String(ctx.last("request_callback")?.time_local ?? "The time")} is requested, and the team will confirm it by message. Is there anything else I can help with?`),
    expectBuyer("No, that's all, thanks."),
    say("Thanks for your time. Talk soon, goodbye."),
  ],
  says_stop: [
    // The engine hears the opt-out in code and asks for the fixed reply.
    expectBuyer("Stop calling me."),
  ],
  card_in_chat: [
    // The engine masks the card number and asks for the fixed security reply.
    expectBuyer("Just charge my card: 4111 1111 1111 1111, exp 12/28."),
  ],
  hebrew_buyer: [
    expectBuyer("שלום, יש לנו עסק עם סניף אחד. כמה זה עולה?"),
    say("I can only continue in English on this call, or we can go on in the chat in Hebrew. Which would you prefer?"),
    expectBuyer("English is fine."),
    say("Great, thank you. How do you handle it today?"),
  ],
  no_approved_answer: [
    expectBuyer("Do you offer on-site training in our city, and how long does it take?"),
    say("One moment, I'm checking that."),
    tool("lookup_knowledge", { query: "on-site training in our city and how long it takes" }),
    say("I don't have details on that. I can check with the team and get back to you. Would that help?"),
  ],
};

/** A call without a scenario: a short click-through with one lookup. */
export const DEFAULT_SCRIPT: Script = [
  expectBuyer("Hi, I'm looking for a quote for my business."),
  say("Happy to help. One moment, I'm checking what we have."),
  tool("search_catalog", { query: "" }),
  say("We have a few options that could fit. How many people would use it?"),
  expectBuyer("About ten."),
  say("Thanks, that helps. Is it one location or more?"),
];

/** After the script: every buyer turn gets this short answer. */
const AFTER_SCRIPT = { buyer: "Okay.", agent: "Thanks. Is there anything else I can help with today?" };

/** Fields listed in the instructions' "Deal-state fields" block. */
export function fieldsFromInstructions(instructions: string): ScriptField[] {
  const block = instructions.split("### Deal-state fields\n")[1]?.split("\n\n")[0] ?? "";
  return block.split("\n").flatMap((line) => {
    const m = /^- ([A-Za-z0-9_]+): (.+?) \((needed for the quote|filled in the order form|helps the pitch)\)/.exec(line);
    return m ? [{ key: m[1], label: m[2], neededForQuote: m[3] === "needed for the quote" }] : [];
  });
}

/** The line a one-off instruction asks for: its first quoted text, else a fixed line by topic. */
export function lineForInstruction(instructions: string | undefined): string {
  const quoted = instructions ? /"([^"]+)"/.exec(instructions)?.[1] : undefined;
  if (quoted) return quoted;
  if (instructions && /time limit|about to end|almost out of time/i.test(instructions)) return "We're almost out of time on this call. We can continue in the chat below.";
  if (instructions && /quiet|still there|silence/i.test(instructions)) return "Are you still there?";
  if (instructions && /opted out|opt-out/i.test(instructions)) return OPT_OUT;
  return "Sorry, could you say that again?";
}

// ---------------------------------------------------------------------------
// The fake model
// ---------------------------------------------------------------------------

export type ScriptedOptions = {
  clock?: Clock;
  /** Scripts by scenario id (default VOICE_SCRIPTS) and for calls without one. */
  scripts?: Record<string, Script>;
  defaultScript?: Script;
  /** Speech pacing: ms per spoken word. */
  wordMs?: number;
  /** RMS (0..1) above which mic audio counts as speech. */
  speechRms?: number;
  /** Emit a soft tone (true) or silence (false) as agent audio. */
  tone?: boolean;
};

export class ScriptedRealtime implements RealtimeModel {
  readonly modelId = "scripted";
  readonly mode = "scripted" as const;
  /** Every connection made, oldest first (tests read them). */
  readonly connections: ScriptedConnection[] = [];
  /** Make the next connect() fail (tests: the reconnect path). */
  failNextConnect = false;
  constructor(private opts: ScriptedOptions = {}) {}

  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("scripted connect failed");
    }
    const scripts = this.opts.scripts ?? VOICE_SCRIPTS;
    const script = (cfg.scenario && scripts[cfg.scenario]) || this.opts.defaultScript || DEFAULT_SCRIPT;
    const c = new ScriptedConnection(cfg, onEvent, script, {
      clock: this.opts.clock ?? systemClock, wordMs: this.opts.wordMs ?? 250, speechRms: this.opts.speechRms ?? 0.02, tone: this.opts.tone ?? true,
      // A resumed call (reconnect) carries on after the script position it had.
      resumed: this.connections.length > 0,
      startAt: this.connections.at(-1)?.position ?? 0,
      results: this.connections.at(-1)?.ctx.results,
    });
    this.connections.push(c);
    queueMicrotask(() => c.boot());
    return c;
  }
}

type Waiter = () => void;
type BuyerTurn = { typed: boolean; text?: string };

export class ScriptedConnection implements RealtimeConnection {
  closed = false;
  closeCalls = 0;
  /** The script step to run next. */
  position: number;
  readonly ctx: ScriptCtx;
  /** Everything sent to the model (tests read it). */
  readonly sent: { audioMs: number; texts: string[]; toolResults: { callId: string; name: string; result: unknown }[]; responses: (string | undefined)[] } = { audioMs: 0, texts: [], toolResults: [], responses: [] };

  private waiters: Waiter[] = [];
  private buyerTurns: BuyerTurn[] = [];
  private interjections: (string | undefined)[] = [];
  private toolResults = new Map<string, unknown>();
  private agentSpeaking = false;
  private interrupted = false;
  private turnText = "";
  private turnOpen = false;
  private callSeq = 0;
  // Energy detector
  private loudMs = 0;
  private quietMs = 0;
  private inSpeech = false;
  private speechWatch: TimerHandle | null = null;
  // Fake usage (a snapshot that grows)
  private usage: VoiceUsage = { audioInTokens: 0, audioOutTokens: 0, textInTokens: 0, textOutTokens: 0, cachedInTokens: 0 };
  private started = false;

  constructor(
    readonly cfg: RealtimeSessionConfig,
    private emit: (e: RealtimeEvent) => void,
    private script: Script,
    private o: { clock: Clock; wordMs: number; speechRms: number; tone: boolean; resumed: boolean; startAt: number; results?: Record<string, Record<string, unknown>[]> },
  ) {
    this.position = o.startAt;
    const results: Record<string, Record<string, unknown>[]> = o.results ? structuredClone(o.results) : {};
    this.ctx = { results, last: (name) => results[name]?.at(-1), fields: fieldsFromInstructions(cfg.instructions), localNow: localNowFromInstructions(cfg.instructions) };
    this.usage.textInTokens = Math.ceil(cfg.instructions.length / 4);
  }

  boot() {
    if (this.closed) return;
    this.emit({ type: "session", providerSessionId: `scripted-${Math.floor(this.o.clock.now()).toString(36)}` });
    void this.run().catch(() => undefined);
  }

  // -- RealtimeConnection ----------------------------------------------------

  sendAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    const ms = pcmDurationMs(pcm.byteLength);
    this.sent.audioMs += ms;
    this.usage.audioInTokens += (ms / 1000) * 32;
    const loud = rms(pcm) >= this.o.speechRms;
    if (loud) {
      this.quietMs = 0;
      this.loudMs += ms;
      if (!this.inSpeech && this.loudMs >= 200) {
        this.inSpeech = true;
        if (this.agentSpeaking) this.interrupted = true;
        this.emit({ type: "speech-started" });
      }
    } else if (this.inSpeech) {
      this.quietMs += ms;
      if (this.quietMs >= 700) this.endSpeech();
    } else {
      this.loudMs = 0;
    }
    if (this.inSpeech) {
      // Audio that simply stops (mute, a dropped frame) also ends the turn after 700 ms.
      this.o.clock.clearTimeout(this.speechWatch);
      this.speechWatch = this.o.clock.setTimeout(() => this.endSpeech(), 700);
    }
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.sent.texts.push(text);
    this.buyerTurns.push({ typed: true, text });
    this.wake();
  }

  sendToolResult(callId: string, name: string, result: unknown): void {
    if (this.closed) return;
    this.sent.toolResults.push({ callId, name, result });
    this.toolResults.set(callId, result);
    this.wake();
  }

  requestResponse(instructions?: string): void {
    if (this.closed) return;
    this.sent.responses.push(instructions);
    this.interjections.push(instructions);
    this.wake();
  }

  close(): void {
    this.closeCalls++;
    if (this.closed) return;
    this.closed = true;
    this.o.clock.clearTimeout(this.speechWatch);
    this.wake();
  }

  // -- Test hooks ------------------------------------------------------------

  /** The provider announces it will close (Gemini goAway). */
  simulateGoAway() {
    this.emit({ type: "going-away" });
  }
  /** The provider socket drops. */
  simulateDrop(error = "dropped") {
    this.closed = true;
    this.wake();
    this.emit({ type: "closed", error });
  }

  // -- Internals -------------------------------------------------------------

  private endSpeech() {
    if (!this.inSpeech) return;
    this.inSpeech = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.o.clock.clearTimeout(this.speechWatch);
    this.speechWatch = null;
    this.buyerTurns.push({ typed: false });
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private until(cond: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.closed || cond()) resolve();
        else this.waiters.push(check);
      };
      check();
    });
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => this.o.clock.setTimeout(r, ms));
  }

  private async run() {
    // The call starts when the engine asks for the opener (a resumed call does not get one).
    if (!this.o.resumed) {
      await this.until(() => this.interjections.length > 0);
      if (this.closed) return;
      this.started = true;
      await this.speak(lineForInstruction(this.interjections.shift()));
      this.endTurn();
    }
    this.started = true;
    while (!this.closed) {
      const step = this.script[this.position];
      if (!step) {
        await this.idle();
        return;
      }
      if (step.when && !step.when(this.ctx)) {
        this.position++;
        continue;
      }
      if (step.kind === "expectBuyer") {
        this.endTurn();
        const turn = await this.nextBuyerTurn();
        if (this.closed || !turn) return;
        this.position++;
        this.buyerSaid(turn, step.line);
      } else if (step.kind === "say") {
        const text = typeof step.text === "function" ? step.text(this.ctx) : step.text;
        const cut = await this.speak(text);
        this.position++;
        if (cut) await this.afterInterruption();
      } else {
        const args = typeof step.args === "function" ? (step.args as (c: ScriptCtx) => unknown)(this.ctx) : step.args;
        const callId = `call_${++this.callSeq}_${this.position}`;
        this.turnOpen = true;
        this.emit({ type: "tool-call", callId, name: step.name, args });
        await this.until(() => this.toolResults.has(callId));
        if (this.closed) return;
        const r = this.toolResults.get(callId);
        if (r && typeof r === "object") (this.ctx.results[step.name] ??= []).push(r as Record<string, unknown>);
        this.position++;
      }
    }
  }

  /** After the script: one-off instructions are spoken; buyer turns get a short answer. */
  private async idle() {
    this.endTurn();
    while (!this.closed) {
      await this.until(() => this.interjections.length > 0 || this.buyerTurns.length > 0);
      if (this.closed) return;
      if (this.interjections.length) {
        await this.speak(lineForInstruction(this.interjections.shift()));
        this.endTurn();
        continue;
      }
      this.buyerSaid(this.buyerTurns.shift()!, AFTER_SCRIPT.buyer);
      await this.speak(AFTER_SCRIPT.agent);
      this.endTurn();
    }
  }

  /** Waits for a buyer turn; one-off instructions that arrive meanwhile are spoken. */
  private async nextBuyerTurn(): Promise<BuyerTurn | null> {
    while (!this.closed) {
      await this.until(() => this.interjections.length > 0 || this.buyerTurns.length > 0);
      if (this.closed) return null;
      if (this.buyerTurns.length) return this.buyerTurns.shift()!;
      await this.speak(lineForInstruction(this.interjections.shift()));
      this.endTurn();
    }
    return null;
  }

  /** The buyer's turn as transcribed: the scripted line for speech, nothing for typed text (the engine has it). */
  private buyerSaid(turn: BuyerTurn, line: string) {
    if (turn.typed) return;
    const words = line.split(" ");
    const half = words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(" ");
    this.emit({ type: "buyer-transcript", text: half, final: false });
    this.emit({ type: "buyer-transcript", text: line, final: true });
  }

  /** After a barge-in: the buyer's words become their turn (the next expected line, or a short one). */
  private async afterInterruption() {
    const turn = await this.nextBuyerTurn();
    if (!turn || this.closed) return;
    const step = this.script[this.position];
    if (step?.kind === "expectBuyer") {
      this.position++;
      this.buyerSaid(turn, step.line);
    } else {
      this.buyerSaid(turn, "Sorry, go on.");
    }
  }

  /** Speaks a line word by word. Returns true when the buyer cut it short. */
  private async speak(text: string): Promise<boolean> {
    if (this.closed || !text) return false;
    this.turnOpen = true;
    this.agentSpeaking = true;
    this.interrupted = false;
    const base = this.turnText ? `${this.turnText} ` : "";
    const words = text.split(/\s+/).filter(Boolean);
    let spoken = "";
    for (const w of words) {
      if (this.interrupted || this.closed) break;
      await this.sleep(this.o.wordMs);
      if (this.interrupted || this.closed) break;
      spoken = spoken ? `${spoken} ${w}` : w;
      this.emit({ type: "audio", pcm: speechPcm(this.o.wordMs, this.o.tone) });
      this.emit({ type: "agent-transcript", text: base + spoken, final: false });
      this.usage.audioOutTokens += (this.o.wordMs / 1000) * 32;
      this.usage.textOutTokens += 1.3;
    }
    this.agentSpeaking = false;
    this.turnText = spoken ? base + spoken : this.turnText;
    if (this.interrupted && !this.closed) {
      this.interrupted = false;
      this.endTurn(true);
      return true;
    }
    return false;
  }

  private endTurn(interrupted = false) {
    if (!this.turnOpen || this.closed) return;
    this.turnOpen = false;
    if (this.turnText) this.emit({ type: "agent-transcript", text: this.turnText, final: true });
    this.turnText = "";
    this.emit({ type: "turn-done", ...(interrupted ? { interrupted: true } : {}) });
    const u = this.usage;
    this.emit({
      type: "usage",
      usage: {
        audioInTokens: Math.round(u.audioInTokens), audioOutTokens: Math.round(u.audioOutTokens),
        textInTokens: Math.round(u.textInTokens), textOutTokens: Math.round(u.textOutTokens), cachedInTokens: 0,
      },
    });
  }

  /** True once the opener was asked for (tests). */
  get hasStarted() {
    return this.started;
  }
}

/** Root mean square of PCM16 little-endian audio, 0..1. */
export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2);
  if (!n) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** `ms` of PCM16 mono 24 kHz: a soft 220 Hz tone, or silence. */
export function speechPcm(ms: number, tone = true): Uint8Array {
  const n = Math.round((VOICE_SAMPLE_RATE * ms) / 1000);
  const out = new Uint8Array(n * 2);
  if (!tone) return out;
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / VOICE_SAMPLE_RATE) * 1500), true);
  return out;
}

/** `ms` of mic audio for tests: loud (speech) or quiet. */
export function micPcm(ms: number, loud: boolean): Uint8Array {
  const n = Math.round((VOICE_SAMPLE_RATE * ms) / 1000);
  const out = new Uint8Array(n * 2);
  if (!loud) return out;
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 300 * i) / VOICE_SAMPLE_RATE) * 8000), true);
  return out;
}
