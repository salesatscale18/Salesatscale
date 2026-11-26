/**
 * The hand-over's "Talk now" readiness (owner, 26 Nov): the adapter to the Voice side's contract
 * (app/h/[token]/call-ready.ts) and each hand-over state as rendered (idle with the buttons at once,
 * preparing, failed by reason with or without "Try again"), in English and Hebrew; the off-screen chat's
 * real viewport size and the static ring with reduced motion (lead-page.css). No network, no call.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { translator, type Locale } from "@/lib/i18n";
import {
  canRetry, CALL_FAIL_REASONS, failReasonOf, NO_EVENT_MS, startHeldCall, supportsHold,
  type CallReadyEvents, type CallFailReason,
} from "@/app/h/[token]/call-ready";
import { HandoverActions, failLine, type HandoverPhase, type HandoverStrings } from "@/app/h/[token]/handover-chat";

/** Manual timers: `run()` fires what is pending. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    set: (fn: () => void) => { pending.set(++n, fn); return n; },
    clear: (id: unknown) => { pending.delete(id as number); },
    run: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
    get size() { return pending.size; },
    ms: [] as number[],
  };
}

/** A Voice side double: records the order of calls and lets the test fire events. */
function voiceDouble() {
  const log: string[] = [];
  let handlers: CallReadyEvents | null = null;
  const c = {
    startCall: vi.fn((opts?: { holdGreeting?: boolean }) => { log.push(`start:${JSON.stringify(opts ?? null)}`); }),
    releaseGreeting: vi.fn(() => { log.push("release"); }),
    onCallEvents: vi.fn((h: CallReadyEvents) => { log.push("subscribe"); handlers = h; return () => { log.push("unsubscribe"); handlers = null; }; }),
  };
  return { c, log, fire: () => handlers };
}

const noop = { onReady: () => {}, onFailed: () => {}, onNoEvents: () => {} };

describe("call-ready adapter", () => {
  it("without the Voice side's hold: today's behaviour (startCall with no options, in the tap; show the chat now)", () => {
    const startCall = vi.fn();
    expect(supportsHold({ startCall })).toBe(false);
    const h = startHeldCall({ startCall }, { ...noop, onReady: vi.fn() });
    expect(h).toEqual({ mode: "fallback" });
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(startCall).toHaveBeenCalledWith();
    // Only one of the two hold members is not enough.
    expect(supportsHold({ startCall, releaseGreeting: () => {} })).toBe(false);
  });

  it("with the hold: listens first, then startCall({ holdGreeting: true }) synchronously; ready once; release once", () => {
    const { c, log, fire } = voiceDouble();
    const timers = fakeTimers();
    const onReady = vi.fn();
    const onMic = vi.fn();
    const h = startHeldCall(c, { ...noop, onReady, onMicGranted: onMic }, timers);
    expect(h.mode).toBe("hold");
    expect(log).toEqual(["subscribe", 'start:{"holdGreeting":true}']);
    fire()!.onMicGranted();
    fire()!.onMicGranted();
    expect(onMic).toHaveBeenCalledTimes(1);
    fire()!.onReady();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(log).toContain("unsubscribe");
    expect(timers.size).toBe(0);
    if (h.mode !== "hold") throw new Error();
    h.release();
    h.release();
    expect(c.releaseGreeting).toHaveBeenCalledTimes(1);
  });

  it("failed: the reason passes through (unknown ones become other); nothing after it", () => {
    for (const reason of [...CALL_FAIL_REASONS, "weird"]) {
      const { c, fire } = voiceDouble();
      const onFailed = vi.fn();
      const onReady = vi.fn();
      startHeldCall(c, { ...noop, onFailed, onReady }, fakeTimers());
      const f = fire()!;
      f.onFailed(reason as CallFailReason);
      f.onReady();
      expect(onFailed).toHaveBeenCalledWith(reason === "weird" ? "other" : reason);
      expect(onReady).not.toHaveBeenCalled();
    }
    expect(failReasonOf(undefined)).toBe("other");
  });

  it("an answer inside startCall itself (an instant refusal) is handled", () => {
    const onFailed = vi.fn();
    let h: CallReadyEvents | null = null;
    const c = { startCall: () => h!.onFailed("gate_refused"), releaseGreeting: () => {}, onCallEvents: (x: CallReadyEvents) => { h = x; return () => {}; } };
    startHeldCall(c, { ...noop, onFailed }, fakeTimers());
    expect(onFailed).toHaveBeenCalledWith("gate_refused");
  });

  it("no event at all: the chat as today after the wait; mic granted but never ready: failed (other)", () => {
    const a = voiceDouble();
    const t1 = fakeTimers();
    const onNoEvents = vi.fn();
    startHeldCall(a.c, { ...noop, onNoEvents }, t1);
    t1.run();
    expect(onNoEvents).toHaveBeenCalledTimes(1);
    expect(a.fire()).toBeNull();

    const b = voiceDouble();
    const t2 = fakeTimers();
    const onFailed = vi.fn();
    startHeldCall(b.c, { ...noop, onFailed }, t2);
    b.fire()!.onMicGranted();
    t2.run();
    expect(onFailed).toHaveBeenCalledWith("other");
    expect(NO_EVENT_MS).toBeGreaterThan(15_000);
  });

  it("Try again only where it can help", () => {
    expect(CALL_FAIL_REASONS.filter(canRetry)).toEqual(["connect_failed", "busy", "other"]);
  });
});

const stringsFor = (lang: Locale): HandoverStrings => {
  const tr = translator(lang);
  return {
    talkNow: tr("buyer.lp.handover.talk_now"), chatWriting: tr("buyer.lp.handover.chat_writing"), continueChat: tr("buyer.lp.handover.continue_chat"),
    preparing: tr("buyer.lp.handover.preparing"), tryAgain: tr("buyer.lp.handover.try_again"),
    failMicDenied: tr("buyer.lp.handover.fail_mic_denied"), failMicUnavailable: tr("buyer.lp.handover.fail_mic_unavailable"), failCall: tr("buyer.lp.handover.fail_call"),
  };
};
const html = (phase: HandoverPhase, lang: Locale = "en", talkLoading = false) =>
  renderToStaticMarkup(<HandoverActions phase={phase} voiceOffered strings={stringsFor(lang)} talkLoading={talkLoading} />);

describe("hand-over states", () => {
  it("idle: the calm ring and both buttons at once, enabled; Talk now loading (busy, not disabled) until the chat can call", () => {
    const h = html({ kind: "idle" });
    expect(h).toContain('data-ring="done"');
    expect(h).toContain(">Talk now</button>");
    expect(h).toContain(">Chat in writing</button>");
    expect(h).not.toContain("disabled");
    expect(h).not.toContain("Getting your conversation ready");
    const loading = html({ kind: "idle" }, "en", true);
    expect(loading).toMatch(/data-handover-talk=""/);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('class="lp-spin"');
    expect(loading).not.toContain("disabled=");
  });

  it("preparing: the turning ring and ONE polite status line, no buttons (en and he)", () => {
    const en = html({ kind: "preparing" });
    expect(en).toContain('data-ring="busy"');
    expect(en).toContain('role="status" aria-live="polite" data-handover-preparing="">Getting your conversation ready</p>');
    expect(en.match(/role="status"/g)).toHaveLength(1);
    expect(en).not.toContain("<button");
    expect(html({ kind: "preparing" }, "he")).toContain("מכינים את השיחה");
  });

  it("failed: the line by reason, Try again for connection / busy / other only, Chat in writing always", () => {
    const expected: Record<CallFailReason, string> = {
      mic_denied: "The microphone is blocked for this page. Allow it in your browser to talk, or chat in writing.",
      mic_unavailable: "No microphone was found on this device. You can chat in writing.",
      connect_failed: "The call could not start. Try again, or chat in writing.",
      busy: "The call could not start. Try again, or chat in writing.",
      gate_refused: "The call could not start. Try again, or chat in writing.",
      other: "The call could not start. Try again, or chat in writing.",
    };
    for (const reason of CALL_FAIL_REASONS) {
      const h = html({ kind: "failed", reason });
      expect(h).toContain(`data-handover-failed="${reason}">${expected[reason]}</p>`);
      expect(h).toContain(">Chat in writing</button>");
      expect(h).not.toContain(">Talk now</button>");
      if (canRetry(reason)) expect(h).toMatch(/data-handover-retry="">.*Try again<\/button>/);
      else {
        expect(h).not.toContain("Try again</button>");
        // Then "Chat in writing" is the main button.
        expect(h).toContain('class="lp-btn lp-btn--primary" data-handover-write=""');
      }
    }
    const he = html({ kind: "failed", reason: "mic_denied" }, "he");
    expect(he).toContain("המיקרופון חסום בדף הזה. אפשר לאשר אותו בדפדפן כדי לדבר, או להתכתב בצ&#x27;אט.");
    expect(html({ kind: "failed", reason: "busy" }, "he")).toContain("לנסות שוב</button>");
    expect(failLine(stringsFor("he"), "mic_unavailable")).toBe("לא נמצא מיקרופון במכשיר הזה. אפשר להתכתב בצ'אט.");
    expect(failLine(stringsFor("he"), "other")).toBe("לא הצלחנו להתחיל את השיחה. אפשר לנסות שוב או להתכתב בצ'אט.");
  });

  it("CSS: the off-screen chat has the real viewport size; reduced motion keeps the ring and the loading mark still", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "app/p/[key]/lead-page.css"), "utf8");
    const off = /\.lp-offstage \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(off).toContain("position: fixed");
    expect(off).toContain("width: 100vw");
    expect(off).toContain("height: 100dvh");
    expect(off).not.toContain("390px");
    expect(off).not.toMatch(/display:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.lp-ring, \.lp-ring b \{ animation: none; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.lp-spin \{ animation: none;/);
  });
});
