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
  clock: string | null;
  /** Mute + End (a live call), End only (connecting, reconnecting), or none. */
  controls: "call" | "end_only" | "none";
  endLabel: string;
  action: BarAction | null;
  muted: boolean;
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

export type BarContext = {
  /** The Ready line: "English · v2 Draft · up to 10 minutes". */
  readyLine?: string;
  /** Appended to the ended line in the test lab: "saved in Test lab chats". */
  savedNote?: string;
  /** Where "Open AI usage" goes when calls are paused (seller pages only; hidden for buyers). */
  usageHref?: string | null;
  fx?: CostFormat | null;
};

const UNAVAILABLE_TITLE: Record<VoiceUnavailableReason, MessageKey> = {
  spend_cap: "voice.unavailable.title.paused", platform_budget: "voice.unavailable.title.paused", account_paused: "voice.unavailable.title.paused",
  rate_limited: "voice.unavailable.title.rate_limited", voice_off: "voice.unavailable.title.off", not_allowed: "voice.unavailable.title.off",
  already_in_call: "voice.unavailable.title.in_call", error: "voice.unavailable.title.off",
};

/** The ended line's second part: cost or "No cost", plus the saved note. */
export function endedSub(s: VoiceSnapshot, ctx: BarContext): string {
  const cost = s.mode === "scripted" ? t("voice.no_cost") : t("voice.ended.cost", { cost: costText(s.costMicros, ctx.fx ?? null) });
  return [cost, ctx.savedNote].filter(Boolean).join(" · ");
}

export function barView(s: VoiceSnapshot, now: number, ctx: BarContext = {}): BarView {
  const base = { clock: null, controls: "none" as const, endLabel: t("voice.end"), action: null, muted: s.muted, busy: false, bars: null, icon: null };
  switch (s.phase) {
    case "idle":
      return { ...base, state: "ready", tone: "plain", icon: "phone-call", title: t("voice.ready.title"), sub: ctx.readyLine ?? "", action: { kind: "start", label: t("voice.ready.start") } };
    case "mic_prompt":
      return { ...base, state: "mic_prompt", tone: "me", icon: "mic", title: t("voice.mic_prompt.title"), sub: t("voice.mic_prompt.sub"), action: { kind: "cancel", label: t("voice.cancel") } };
    case "mic_blocked":
      return { ...base, state: "mic_blocked", tone: "warn", icon: "mic-off", title: t("voice.mic_blocked.title"), sub: t("voice.mic_blocked.sub"), action: { kind: "try_again", label: t("voice.try_again") } };
    case "no_mic":
      return { ...base, state: "no_mic", tone: "warn", icon: "mic-off", title: t("voice.no_mic.title"), sub: t("voice.no_mic.sub"), action: { kind: "try_again", label: t("voice.try_again") } };
    case "starting":
    case "connecting":
      return { ...base, state: "connecting", tone: "plain", icon: "loader", title: t("voice.connecting.title"), sub: t("voice.connecting.sub"), controls: "end_only", endLabel: t("voice.cancel_call") };
    case "reconnecting":
      return {
        ...base, state: "reconnecting", tone: "warn", icon: "wifi-off", title: t("voice.reconnecting.title"), sub: t("voice.reconnecting.sub"),
        clock: callClock(elapsedSec(s, now)), controls: "end_only",
      };
    case "ending":
      return { ...base, state: "ending", tone: "off", icon: "phone-off", title: t("voice.ending.title"), sub: t("voice.ending.sub"), clock: callClock(elapsedSec(s, now)), controls: "end_only", busy: true };
    case "ended": {
      const lost = s.endReason === "connection_lost";
      return {
        ...base, state: "ended", tone: "off", icon: "phone-off",
        title: lost ? t("voice.ended.title_lost") : t("voice.ended.title", { time: callClock(s.durationSec) }),
        sub: endedSub(s, ctx), action: { kind: "call_again", label: t("voice.call_again") }, muted: false,
      };
    }
    case "unavailable": {
      const reason = s.unavailable ?? "error";
      const action: BarAction | null = reason === "spend_cap" && ctx.usageHref ? { kind: "link", label: t("voice.open_ai_usage"), href: ctx.usageHref }
        : reason === "already_in_call" && s.ownCall ? { kind: "end_other", label: t("voice.end_that_call") } : null;
      let sub = t(`voice.unavailable.${reason}` as MessageKey);
      if (reason === "rate_limited" && s.retryAt) sub = t("voice.unavailable.rate_limited_at", { time: clockTime(s.retryAt) });
      if (reason === "already_in_call") sub = t(s.ownCall ? "voice.unavailable.already_in_call" : "voice.unavailable.already_in_call_other");
      return { ...base, state: "unavailable", tone: "warn", icon: "alert-triangle", title: t(UNAVAILABLE_TITLE[reason]), sub, action };
    }
    case "live": {
      const clock = callClock(elapsedSec(s, now));
      const call = { ...base, clock, controls: "call" as const };
      const noticeSub = s.notice === "limit_soon" ? t("voice.notice.limit_soon") : s.notice === "silence_check" ? t("voice.notice.silence_check") : null;
      if (s.muted) return { ...call, state: "muted", tone: "off", bars: "muted", title: t("voice.muted.title"), sub: noticeSub ?? t("voice.muted.sub") };
      if (s.live === "speaking") return { ...call, state: "speaking", tone: "agent", bars: "out", title: t("voice.speaking.title"), sub: noticeSub ?? t("voice.speaking.sub") };
      if (s.live === "checking") return { ...call, state: "checking", tone: "agent", bars: "checking", title: t("voice.checking.title"), sub: noticeSub ?? t("voice.checking.sub") };
      return { ...call, state: "listening", tone: "me", bars: "mic", title: t("voice.listening.title"), sub: noticeSub ?? t("voice.listening.sub") };
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
