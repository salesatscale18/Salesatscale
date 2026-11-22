"use client";

/**
 * Test-lab voice calls (live voice, release 1), the browser side: starting a
 * call, swapping the saved thread for the live call while it runs, and the
 * live "This call" card. The page renders these only for platform admins
 * with voice on; the actions check the same on the server.
 *
 * One VoiceClient lives at module level, so the call survives the page
 * re-rendering (the URL moves to the call's conversation and the page
 * refreshes on deal changes) and is only ended when the test lab is left.
 */
import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { VoiceCall, useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { VoiceCallStats } from "@/components/sas/voice/voice-call-stats";
import { t, translator } from "@/lib/i18n";
import { useBackGuard } from "@/lib/voice/client/back-guard";
import { LeaveSheet } from "@/components/sas/voice/leave-sheet";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction, type BarView, type CostFormat } from "@/lib/voice/client/view";
import { elapsedSec, isIdlePhase } from "@/lib/voice/client/state";
import { endMyVoiceCallAction, startVoiceCallAction } from "./voice-actions";
import { startChatAction } from "./actions";

// ---------------------------------------------------------------------------
// The lab's call (module level)
// ---------------------------------------------------------------------------

type LabCall = { conversationId: string; fx: CostFormat; versionId: string | null; scenario: string | null; handedOff: boolean; model?: string | null } | null;

let client: VoiceClient | null = null;
let call: LabCall = null;
const callListeners = new Set<() => void>();
let mounted = 0;

function labClient(): VoiceClient {
  client ??= new VoiceClient();
  return client;
}
function setCall(next: LabCall) {
  call = next;
  for (const fn of [...callListeners]) fn();
}
function useLabCall(): LabCall {
  return useSyncExternalStore(
    (fn) => {
      callListeners.add(fn);
      return () => callListeners.delete(fn);
    },
    () => call,
    () => null,
  );
}

/**
 * Keeps the call while the test lab is on screen. Leaving the test lab (this
 * unmounts and nothing mounts again within a second) ends the call; so does
 * closing the tab (the socket closes and the relay ends the call).
 */
export function VoiceLabKeeper() {
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      setTimeout(() => {
        if (mounted === 0 && client) {
          client.dispose();
          client = null;
          setCall(null);
        }
      }, 1000);
    };
  }, []);
  return null;
}

/**
 * Back during a test call (board VoiceBubbleBack 2): "End the call?" on Back or on a link that leaves the test lab;
 * End call ends it and stays here. With no call, Back and links work as usual. During the call, closing or
 * reloading the tab gets the browser's leave prompt.
 */
export function VoiceLabBackGuard() {
  const s = useVoiceSnapshot(labClient());
  const mine = useLabCall();
  // Only once the call is connected: the URL has moved to the call's conversation by then (no guard under that step).
  const on = !!mine && !mine.handedOff && (s.phase === "live" || s.phase === "reconnecting");
  const g = useBackGuard({ ask: on ? "end_call" : null, liveCall: on, guardLinks: true, onEndCall: () => labClient().end() });
  return g.sheet ? <LeaveSheet ask={g.sheet} tr={translator("en")} dir="ltr" onChoose={g.choose} /> : null;
}

type StartInput = { slug: string; lab: string; versionId: string | null; scenario: string | null; language?: string | null; maxSec?: number | null };

/** Starts a call: audio unlocked in the click, the mic, then the server creates the call, then the socket. */
function useStartCall() {
  const router = useRouter();
  return (input: StartInput) => {
    const c = labClient();
    // Synchronously inside the click: browsers only start audio from a user gesture.
    c.begin({ maxSec: input.maxSec ?? null });
    setCall(null);
    void (async () => {
      if (!(await c.prepare())) return;
      let r: Awaited<ReturnType<typeof startVoiceCallAction>>;
      try {
        r = await startVoiceCallAction({ slug: input.slug, versionId: input.versionId, scenario: input.scenario, language: input.language ?? null });
      } catch {
        c.unavailable("error");
        return;
      }
      if (!r.ok) {
        c.unavailable(r.reason, { retryAt: r.retryAt, ownCall: r.ownCall });
        return;
      }
      setCall({ conversationId: r.conversationId, fx: r.fx, versionId: input.versionId, scenario: input.scenario, handedOff: false, model: r.model });
      c.start({ wsUrl: r.wsUrl, sessionId: r.sessionId, ticket: r.ticket, maxSec: r.maxSec, mode: r.mode });
      router.push(`${input.lab}?c=${r.conversationId}`, { scroll: false });
    })();
  };
}

/** "End that call": ends this user's running call on the server, then back to Ready to start again. */
async function endOtherCall(slug: string) {
  const c = labClient();
  try {
    await endMyVoiceCallAction({ slug });
  } finally {
    c.cancel();
  }
}

/** Phases the starter shows itself (before the call has its own place on the page). */
const STARTER_PHASES = new Set(["mic_prompt", "mic_blocked", "no_mic", "starting", "unavailable"]);

// ---------------------------------------------------------------------------
// Starter: "Call the agent"
// ---------------------------------------------------------------------------

export type StarterOption = { value: string; label: string };

/**
 * The test lab's one row of choices when voice calls are on: Scenario, Buyer
 * language and Version, then "Start chat" (the existing test chat, same
 * server action) and "Start call". A call starts in the chosen buyer language
 * (a scenario brings its own) and the buyer can switch. The microphone prompt, a blocked microphone and refusals ("Calls are
 * paused", "Too many calls…") show in a call bar under the row; the call
 * limit and the voice settings line close the card.
 */
export function VoiceLabChoices({
  slug, lab, scenarios, languages, defaultLanguage, versions, defaultVersionId, callMax, limitLines, usageHref, settingsLine, settingsHref,
}: {
  slug: string;
  lab: string;
  scenarios: (StarterOption & { language: string })[];
  languages: StarterOption[];
  defaultLanguage: string;
  versions: StarterOption[];
  defaultVersionId: string;
  /** The effective longest call per version id (the same value the relay reports). */
  callMax: Record<string, number>;
  /** "Calls: up to 4 min 30 s" per version id. */
  limitLines: Record<string, string>;
  usageHref: string;
  settingsLine: string | null;
  settingsHref: string | null;
}) {
  const c = labClient();
  const s = useVoiceSnapshot(c);
  const [scenario, setScenario] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [versionId, setVersionId] = useState(defaultVersionId);
  const start = useStartCall();
  const busy = !isIdlePhase(s.phase) && !STARTER_PHASES.has(s.phase);
  const own = STARTER_PHASES.has(s.phase);
  // A scenario brings its own buyer language (as for a chat).
  const callLanguage = scenarios.find((x) => x.value === scenario)?.language ?? language;
  const startCall = () => start({ slug, lab, versionId: versionId || null, scenario: scenario || null, language: callLanguage, maxSec: callMax[versionId] ?? null });
  const onAction = (a: BarAction) => {
    if (a.kind === "cancel") c.cancel();
    else if (a.kind === "end_other") void endOtherCall(slug);
    else if (a.kind === "try_again" || a.kind === "start") startCall();
  };
  const line = [limitLines[versionId], settingsLine].filter(Boolean).join(" · ");
  return (
    <section className="sas-panel" aria-labelledby="lab-new-h" data-voice-starter="">
      <form action={startChatAction} className="sas-panel__body lab-choices" data-new-chat="">
        <h2 id="lab-new-h" className="sas-heading lab-choices__h">{t("lab.voice.choices_heading")}</h2>
        <input type="hidden" name="slug" value={slug} />
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="lab-scenario">{t("lab.scenario")}</label>
          <select className="sas-select" id="lab-scenario" name="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
            <option value="">{t("lab.scenario_none")}</option>
            {scenarios.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="lab-lang">{t("lab.language")}</label>
          <select className="sas-select" id="lab-lang" name="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="lab-ver">{t("lab.version_label")}</label>
          <select className="sas-select" id="lab-ver" name="versionId" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            {versions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="lab-choices__actions">
          <button type="submit" className={buttonClass("primary")}><Icon name="plus" />{t("lab.voice.start_chat")}</button>
          <button
            type="button" className={buttonClass("secondary")} onClick={startCall} disabled={busy} data-voice-start=""
          >
            <Icon name="phone-call" />{t("lab.voice.start_call")}
          </button>
        </div>
      </form>
      {own ? (
        <div className="lab-call__bar">
          <VoiceCallBar view={barView(s, Date.now(), { usageHref })} onAction={onAction} />
          {s.phase === "unavailable" ? (
            <button type="button" className={`${buttonClass("ghost", "sm")} lab-call__dismiss`} onClick={() => c.cancel()}>{t("voice.cancel")}</button>
          ) : null}
        </div>
      ) : null}
      {line ? (
        <div className="lab-call__foot">
          <span className="sas-small" data-voice-settings-line="">{line}</span>
          {settingsHref ? (
            <a className={buttonClass("secondary", "sm")} href={settingsHref} data-voice-settings-open=""><Icon name="sliders" />{t("voice.settings.open")}</a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The open voice conversation: live call or the saved one
// ---------------------------------------------------------------------------

/** Refreshes the server-rendered parts (Deal state, the scenario) at most every few seconds while a call runs. */
function useThrottledRefresh(key: number, on: boolean) {
  const router = useRouter();
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!on || key === 0) return;
    const run = () => {
      last.current = Date.now();
      timer.current = null;
      router.refresh();
    };
    const wait = 3000 - (Date.now() - last.current);
    if (wait <= 0) run();
    else if (!timer.current) timer.current = setTimeout(run, wait);
  }, [key, on, router]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
}

/**
 * The open voice conversation's body. While this page's call runs (and until
 * the saved thread has been refreshed after it ended), the live call; then
 * `children`, the saved thread from the server.
 */
export function VoiceLabLive({ conversationId, slug, lab, usageHref, children }: {
  conversationId: string; slug: string; lab: string; usageHref: string; children: ReactNode;
}) {
  const c = labClient();
  const s = useVoiceSnapshot(c);
  const mine = useLabCall();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const start = useStartCall();
  const active = !!mine && mine.conversationId === conversationId && !mine.handedOff;
  useThrottledRefresh(s.dealChanges + s.appMessages, active && s.phase === "live");
  const ended = s.phase === "ended";
  useEffect(() => {
    if (!active || !ended) return;
    // The call is stored: load the saved thread, then show it instead of the live one.
    const id = setTimeout(() => {
      startTransition(() => router.refresh());
      setTimeout(() => {
        if (call && call.conversationId === conversationId) setCall({ ...call, handedOff: true });
      }, 1200);
    }, 600);
    return () => clearTimeout(id);
  }, [active, ended, conversationId, router]);
  if (!active) return <>{children}</>;
  return (
    <VoiceCall
      client={c}
      context={{ savedNote: t("voice.ended.saved"), usageHref, fx: mine.fx }}
      onStart={() => start({ slug, lab, versionId: mine.versionId, scenario: mine.scenario })}
      emptyText={t("voice.transcript.empty")}
    />
  );
}

/** The live "This call" card while this page's call runs; otherwise `children` (the saved call's card). */
export function VoiceLabStats({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const c = labClient();
  const s = useVoiceSnapshot(c);
  const mine = useLabCall();
  const now = useNow(s.phase === "live");
  if (!mine || mine.conversationId !== conversationId || mine.handedOff || s.phase === "idle") return <>{children}</>;
  return (
    <VoiceCallStats
      durationSec={elapsedSec(s, now)} maxSec={s.maxSec} costMicros={s.costMicros} scripted={s.mode === "scripted"} fx={mine.fx}
      answerMsAvg={s.answerMsAvg} live={s.phase !== "ended"} endReason={s.phase === "ended" ? s.endReason : null} errorCode={s.errorCode}
      model={mine.model ?? null}
    />
  );
}

/**
 * The saved call's bar ("Call ended · 4:12 · No cost · saved…" with Call
 * again). Call again starts a new call on the same version and scenario; its
 * microphone and connecting steps show here until the new call opens.
 */
export function VoiceCallAgainBar({ view, slug, lab, versionId, scenario, usageHref }: {
  view: BarView; slug: string; lab: string; versionId: string | null; scenario: string | null; usageHref: string;
}) {
  const c = labClient();
  const s = useVoiceSnapshot(c);
  const start = useStartCall();
  const [mine, setMine] = useState(false);
  const shown = mine && STARTER_PHASES.has(s.phase) ? barView(s, Date.now(), { usageHref }) : view;
  const busy = !isIdlePhase(s.phase) && !STARTER_PHASES.has(s.phase);
  return (
    <VoiceCallBar
      view={shown}
      actionDisabled={busy}
      onAction={(a) => {
        if (a.kind === "cancel") c.cancel();
        else if (a.kind === "end_other") void endOtherCall(slug);
        else if (a.kind === "call_again" || a.kind === "try_again" || a.kind === "start") {
          setMine(true);
          start({ slug, lab, versionId, scenario });
        }
      }}
    />
  );
}
