/**
 * What the call bar shows for a call state (live voice): always a word and an
 * icon; the colour only supports them (blue = the person's turn, violet = the
 * agent speaking, warning = the person must act, grey = muted or ended).
 * Pure, so every state is unit-tested and the harness can show each one.
 */
import { formatMoney } from "@/lib/domain/money";
import { t, type MessageKey } from "@/lib/i18n";
import { callClock } from "../lab";
import { elapsedSec, type VoiceSnapshot, type VoiceUnavailableReason } from "./state";

export type BarTone = "plain" | "me" | "agent" | "warn" | "off";
export type BarIcon = "phone-call" | "mic" | "mic-off" | "loader" | "wifi-off" | "phone-off" | "alert-triangle";
export type BarAction =
  | { kind: "start" | "try_again" | "cancel" | "call_again" | "end_other"; label: string }
  | { kind: "link"; label: string; href: string };

export type BarView = {
  /** Machine name of the state (data attribute, tests, the harness). */
  state: string;
  tone: BarTone;
  /** An icon, or animated bars (mic level, agent audio, a slow "checking" pulse, flat when muted). */
  icon: BarIcon | null;
  bars: "mic" | "out" | "checking" | "muted" | null;
  title: string;
  sub: string;
  /** The sub-line on a narrow phone (under ~420px), where the clock and the buttons leave little room. */
  subShort: string;
  clock: string | null;
  /** Mute + End (a live call), End only (connecting, reconnecting), or none. */
  controls: "call" | "end_only" | "none";
  endLabel: string;
  action: BarAction | null;
  muted: boolean;
  /** Labels of the mute button (the bar's language). */
  muteLabel: string;
  unmuteLabel: string;
  /** The bar is busy: buttons wait (ending). */
  busy: boolean;
};

/** How money from the relay (USD micros) is shown: the account currency, like Sources. */
export type CostFormat = { currency: string; minorPerUsd: number | null };

/** USD micros as money text in the account currency (USD when there is no rate). */
export function costText(micros: number, fx: CostFormat | null): string {
  if (fx && fx.minorPerUsd !== null && fx.currency) return formatMoney(Math.round((micros / 1_000_000) * fx.minorPerUsd), fx.currency);
  return formatMoney(Math.round(micros / 10_000), "USD");
}

/** "14:05": a time of day in the viewer's own time zone (the bar runs in their browser). */
export function clockTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
}

/** A translator for the bar's words: English for the test lab; the buyer's language on the chat page. */
type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * The bar's words. On the buyer page (`audience: "buyer"`) every key is read
 * from its `buyer.` copy (buyer.voice.…) in the buyer's language, and the
 * agent speaks by name ("Maya is speaking"); the test lab reads voice.… in English.
 */
function words(ctx: BarContext): Tr {
  if (ctx.audience !== "buyer") return t;
  const tr: Tr = ctx.tr ?? t;
  return (key, vars) => tr(`buyer.${key}` as MessageKey, vars);
}

export type BarContext = {
  /** The Ready line: "English · v2 Draft · up to 10 minutes". */
  readyLine?: string;
  /** Appended to the ended line in the test lab: "saved in Test lab chats". */
  savedNote?: string;
  /** Where "Open AI usage" goes when calls are paused (seller pages only; hidden for buyers). */
  usageHref?: string | null;
  fx?: CostFormat | null;
  /** The buyer page: the buyer's words, no cost, no Call again (the composer's button starts the next call). */
  audience?: "lab" | "buyer";
  /** Translator for the buyer page (the lead's language). */
  tr?: Tr;
  /** The agent's name, for "Maya is speaking" on the buyer page. */
  agentName?: string;
};

const UNAVAILABLE_TITLE: Record<VoiceUnavailableReason, MessageKey> = {
  spend_cap: "voice.unavailable.title.paused", platform_budget: "voice.unavailable.title.paused", account_paused: "voice.unavailable.title.paused",
  rate_limited: "voice.unavailable.title.rate_limited", voice_off: "voice.unavailable.title.off", not_allowed: "voice.unavailable.title.off",
  already_in_call: "voice.unavailable.title.in_call", error: "voice.unavailable.title.off",
};

/** The ended line's second part: cost or "No cost", plus the saved note. */
export function endedSub(s: VoiceSnapshot, ctx: BarContext): string {
  const T = words(ctx);
  if (ctx.audience === "buyer") return T("voice.ended.chat_continues" as MessageKey);
  const cost = s.mode === "scripted" ? T("voice.no_cost") : T("voice.ended.cost", { cost: costText(s.costMicros, ctx.fx ?? null) });
  return [cost, ctx.savedNote].filter(Boolean).join(" · ");
}

const SHORT: Partial<Record<string, MessageKey>> = {
  mic_prompt: "voice.short.mic_prompt", mic_blocked: "voice.short.mic_blocked", no_mic: "voice.short.no_mic", connecting: "voice.short.connecting",
  reconnecting: "voice.short.reconnecting", ending: "voice.short.ending", listening: "voice.short.listening", speaking: "voice.short.speaking",
  checking: "voice.short.checking", muted: "voice.short.muted",
};

export function barView(s: VoiceSnapshot, now: number, ctx: BarContext = {}): BarView {
  const T = words(ctx);
  const v = fullBarView(s, now, ctx);
  let subShort = v.sub;
  if (s.phase === "live" && s.notice) subShort = T(s.notice === "limit_soon" ? "voice.short.limit_soon" : "voice.short.silence_check");
  else if (v.state === "ended") subShort = endedSub(s, { ...ctx, savedNote: undefined });
  else if (SHORT[v.state]) subShort = T(SHORT[v.state]!);
  return { ...v, subShort };
}

function fullBarView(s: VoiceSnapshot, now: number, ctx: BarContext): Omit<BarView, "subShort"> {
  const T = words(ctx);
  const buyer = ctx.audience === "buyer";
  const base = { clock: null, controls: "none" as const, endLabel: T("voice.end"), muteLabel: T("voice.mute"), unmuteLabel: T("voice.unmute"), action: null, muted: s.muted, busy: false, bars: null, icon: null };
  switch (s.phase) {
    case "idle":
      return { ...base, state: "ready", tone: "plain", icon: "phone-call", title: T("voice.ready.title"), sub: ctx.readyLine ?? "", action: { kind: "start", label: T("voice.ready.start") } };
    case "mic_prompt":
      return { ...base, state: "mic_prompt", tone: "me", icon: "mic", title: T("voice.mic_prompt.title"), sub: T("voice.mic_prompt.sub"), action: { kind: "cancel", label: T("voice.cancel") } };
    case "mic_blocked":
      return { ...base, state: "mic_blocked", tone: "warn", icon: "mic-off", title: T("voice.mic_blocked.title"), sub: T("voice.mic_blocked.sub"), action: { kind: "try_again", label: T("voice.try_again") } };
    case "no_mic":
      return { ...base, state: "no_mic", tone: "warn", icon: "mic-off", title: T("voice.no_mic.title"), sub: T("voice.no_mic.sub"), action: { kind: "try_again", label: T("voice.try_again") } };
    case "starting":
    case "connecting":
      return { ...base, state: "connecting", tone: "plain", icon: "loader", title: T("voice.connecting.title"), sub: T("voice.connecting.sub"), controls: "end_only", endLabel: T("voice.cancel_call") };
    case "reconnecting":
      return {
        ...base, state: "reconnecting", tone: "warn", icon: "wifi-off", title: T("voice.reconnecting.title"), sub: T("voice.reconnecting.sub"),
        clock: callClock(elapsedSec(s, now)), controls: "end_only",
      };
    case "ending":
      return { ...base, state: "ending", tone: "off", icon: "phone-off", title: T("voice.ending.title"), sub: T("voice.ending.sub"), clock: callClock(elapsedSec(s, now)), controls: "end_only", busy: true };
    case "ended": {
      const lost = s.endReason === "connection_lost";
      return {
        ...base, state: "ended", tone: "off", icon: "phone-off",
        title: lost ? T("voice.ended.title_lost") : T("voice.ended.title", { time: callClock(s.durationSec) }),
        sub: endedSub(s, ctx), action: buyer ? null : { kind: "call_again", label: T("voice.call_again") }, muted: false,
      };
    }
    case "unavailable": {
      // The buyer is never told why (no reasons, no links): calls are simply not available now.
      if (buyer) return { ...base, state: "unavailable", tone: "warn", icon: "alert-triangle", title: T("voice.unavailable.buyer_title" as MessageKey), sub: T("voice.unavailable.buyer_sub" as MessageKey) };
      const reason = s.unavailable ?? "error";
      const action: BarAction | null = reason === "spend_cap" && ctx.usageHref ? { kind: "link", label: T("voice.open_ai_usage"), href: ctx.usageHref }
        : reason === "already_in_call" && s.ownCall ? { kind: "end_other", label: T("voice.end_that_call") } : null;
      let sub = T(`voice.unavailable.${reason}` as MessageKey);
      if (reason === "rate_limited" && s.retryAt) sub = T("voice.unavailable.rate_limited_at", { time: clockTime(s.retryAt) });
      if (reason === "already_in_call") sub = T(s.ownCall ? "voice.unavailable.already_in_call" : "voice.unavailable.already_in_call_other");
      return { ...base, state: "unavailable", tone: "warn", icon: "alert-triangle", title: T(UNAVAILABLE_TITLE[reason]), sub, action };
    }
    case "live": {
      const clock = callClock(elapsedSec(s, now));
      const call = { ...base, clock, controls: "call" as const };
      const noticeSub = s.notice === "limit_soon" ? T("voice.notice.limit_soon") : s.notice === "silence_check" ? T("voice.notice.silence_check") : null;
      if (s.muted) return { ...call, state: "muted", tone: "off", bars: "muted", title: T("voice.muted.title"), sub: noticeSub ?? T("voice.muted.sub") };
      if (s.live === "speaking") return { ...call, state: "speaking", tone: "agent", bars: "out", title: buyer && ctx.agentName ? T("voice.speaking.named" as MessageKey, { agent: `\u2068${ctx.agentName}\u2069` }) : T("voice.speaking.title"), sub: noticeSub ?? T("voice.speaking.sub") };
      if (s.live === "checking") return { ...call, state: "checking", tone: "agent", bars: "checking", title: T("voice.checking.title"), sub: noticeSub ?? T("voice.checking.sub") };
      return { ...call, state: "listening", tone: "me", bars: "mic", title: T("voice.listening.title"), sub: noticeSub ?? T("voice.listening.sub") };
    }
  }
}

/** "How it ended" in plain words, for the saved call and the ended card. */
export function endReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const key = `voice.end_reason.${reason}` as MessageKey;
  const text = t(key);
  return text === undefined || text === key ? null : text;
}

/** The error the person was shown, in plain words. */
export function errorText(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = `voice.error.${code}` as MessageKey;
  const text = t(key);
  return text === undefined || text === key ? t("voice.error.internal") : text;
}
