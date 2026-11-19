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
import { t } from "@/lib/i18n";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { barView, type BarAction, type BarView, type CostFormat } from "@/lib/voice/client/view";
import { elapsedSec, isIdlePhase } from "@/lib/voice/client/state";
import { endMyVoiceCallAction, startVoiceCallAction } from "./voice-actions";

// ---------------------------------------------------------------------------
// The lab's call (module level)
// ---------------------------------------------------------------------------

type LabCall = { conversationId: string; fx: CostFormat; versionId: string | null; scenario: string | null; handedOff: boolean } | null;

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

type StartInput = { slug: string; lab: string; versionId: string | null; scenario: string | null; maxSec?: number | null };

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
        r = await startVoiceCallAction({ slug: input.slug, versionId: input.versionId, scenario: input.scenario });
      } catch {
        c.unavailable("error");
        return;
      }
      if (!r.ok) {
        c.unavailable(r.reason, { retryAt: r.retryAt, ownCall: r.ownCall });
        return;
      }
      setCall({ conversationId: r.conversationId, fx: r.fx, versionId: input.versionId, scenario: input.scenario, handedOff: false });
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
 * "Call the agent" (boards VoiceStates 1 and VoiceSettingsPanel): the Ready
 * bar with the same scenario and version pickers as "New test chat", and
 * the voice settings line. The microphone prompt, a blocked microphone and a
 * refusal ("Calls are paused") show in this bar.
 */
export function VoiceCallStarter({
  slug, lab, scenarios, versions, defaultVersionId, readyLines, readyMax, usageHref, settingsLine, settingsHref,
}: {
  slug: string;
  lab: string;
  scenarios: StarterOption[];
  versions: StarterOption[];
  defaultVersionId: string;
  /** The Ready line per version id ("English · v2 Draft · up to 10 minutes"). */
  readyLines: Record<string, string>;
  readyMax: Record<string, number>;
  usageHref: string;
  settingsLine: string | null;
  settingsHref: string | null;
}) {
  const c = labClient();
  const s = useVoiceSnapshot(c);
  const [scenario, setScenario] = useState("");
  const [versionId, setVersionId] = useState(defaultVersionId);
  const start = useStartCall();
  const busy = !isIdlePhase(s.phase) && !STARTER_PHASES.has(s.phase);
  const own = STARTER_PHASES.has(s.phase);
  const view: BarView = own
    ? barView(s, Date.now(), { usageHref })
    : barView({ ...s, phase: "idle" }, Date.now(), { readyLine: readyLines[versionId] ?? "" });
  const onAction = (a: BarAction) => {
    if (a.kind === "cancel") c.cancel();
    else if (a.kind === "end_other") void endOtherCall(slug);
    else if (a.kind === "start" || a.kind === "try_again") start({ slug, lab, versionId: versionId || null, scenario: scenario || null, maxSec: readyMax[versionId] ?? null });
  };
  return (
    <section className="sas-panel lab-call" aria-labelledby="lab-call-h" data-voice-starter="">
      <h2 id="lab-call-h" className="sas-sr">{t("lab.voice.call_heading")}</h2>
      <div className="lab-call__bar">
        <VoiceCallBar view={view} onAction={onAction} actionDisabled={busy} />
        {s.phase === "unavailable" ? (
          <button type="button" className={`${buttonClass("ghost", "sm")} lab-call__dismiss`} onClick={() => c.cancel()}>{t("voice.cancel")}</button>
        ) : null}
      </div>
      <div className="lab-call__pickers">
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="lab-call-scenario">{t("lab.scenario")}</label>
          <select className="sas-select" id="lab-call-scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={busy}>
            <option value="">{t("lab.scenario_none")}</option>
            {scenarios.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="lab-call-ver">{t("lab.version_label")}</label>
          <select className="sas-select" id="lab-call-ver" value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={busy}>
            {versions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      {settingsLine ? (
        <div className="lab-call__foot">
          <span className="sas-small" data-voice-settings-line="">{settingsLine}</span>
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
