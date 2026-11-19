/**
 * The no-cost voice harness page (live voice): the REAL call component, "This
 * call" card and voice settings form, bundled with esbuild and served by
 * tests/e2e/voice/harness-server.ts against the REAL engine on PGlite with the
 * free scripted model. Not part of the app or its build.
 *
 * Views (?view=): call (default; ?scenario=ready_buyer), states (every call
 * bar state, for screenshots; the states that cannot be reached naturally are
 * built here from fabricated snapshots, not through the shipped component's
 * API), settings (the side panel).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "@/components/sas/icon";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { VoiceCall, useNow, useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { VoiceCallStats } from "@/components/sas/voice/voice-call-stats";
import { VoiceSettingsForm, type VoiceSettingsFormState } from "@/components/sas/voice/voice-settings-form";
import { t } from "@/lib/i18n";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { INITIAL_SNAPSHOT, elapsedSec, type VoiceSnapshot } from "@/lib/voice/client/state";
import { barView, type CostFormat } from "@/lib/voice/client/view";
import { callLimitShort } from "@/lib/voice/lab";
import type { ResolvedVoiceSettings, VoiceCapabilities } from "@/lib/voice/settings";

type Config = {
  versionLabel: string; version: number; caps: VoiceCapabilities; settings: ResolvedVoiceSettings; scenarios: Record<string, { title: string; expected: string }>;
  fx: CostFormat; maxSec: number;
};

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready_buyer";
const client = new VoiceClient();
(window as unknown as { __voice: VoiceClient }).__voice = client;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

function CallView({ cfg }: { cfg: Config }) {
  const s = useVoiceSnapshot(client);
  const now = useNow(s.phase === "live");
  const sc = cfg.scenarios[scenario];
  const start = () => {
    client.begin({ maxSec: cfg.maxSec, mode: "scripted" });
    void (async () => {
      if (!(await client.prepare())) return;
      const r = await json<{ sessionId: string; ticket: string; wsUrl: string; maxSec: number; mode: "scripted" }>("/api/call", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }),
      });
      (window as unknown as { __call: unknown }).__call = r;
      client.start(r);
    })();
  };
  return (
    <div className="hx-page">
      <section className="sas-panel hx-call" aria-labelledby="hx-h" style={{ overflow: "clip" }}>
        <div className="sas-panel__body hx-head">
          <h2 id="hx-h" className="sas-heading">{t("lab.chat_with", { version: cfg.version })}</h2>
          <StatusPill object="agent_version" state="draft" />
          <span className="sas-pill"><Icon name="phone-call" />{t("voice.pill.call")}</span>
          <span className="sas-pill"><Icon name="flask-conical" />{t("voice.pill.scripted")}</span>
          <span className="sas-small hx-when">English · started 19 Nov 2026, 10:42</span>
        </div>
        <VoiceCall
          client={client} onStart={start}
          context={{ readyLine: `English · ${cfg.versionLabel} · up to ${callLimitShort(cfg.maxSec)}`, savedNote: t("voice.ended.saved"), usageHref: "#usage", fx: cfg.fx }}
          emptyText={t("voice.transcript.empty")}
        />
      </section>
      <div className="hx-side">
        {sc ? (
          <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="hx-sc">
            <h2 id="hx-sc" className="sas-heading">{t("lab.scenario_check", { title: sc.title })}</h2>
            <span><span className="sas-pill"><Icon name="clock" />{t("lab.scenario_result.not_yet")}</span></span>
            <span className="sas-small">{t("lab.scenario_expected", { text: sc.expected })}</span>
          </section>
        ) : null}
        {s.phase !== "idle" ? (
          <VoiceCallStats
            durationSec={elapsedSec(s, now)} maxSec={s.maxSec} costMicros={s.costMicros} scripted={s.mode === "scripted"} fx={cfg.fx}
            answerMsAvg={s.answerMsAvg} live={s.phase !== "ended"} endReason={s.phase === "ended" ? s.endReason : null} errorCode={s.errorCode}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Every bar state from a fabricated snapshot (harness only). */
function StatesView({ cfg }: { cfg: Config }) {
  const now = Date.now();
  const live = (o: Partial<VoiceSnapshot>): VoiceSnapshot => ({ ...INITIAL_SNAPSHOT, phase: "live", connectedAt: now - 38_000, durationSec: 38, maxSec: cfg.maxSec, mode: "scripted", ...o });
  const ctx = { readyLine: `English · ${cfg.versionLabel} · up to ${callLimitShort(cfg.maxSec)}`, savedNote: t("voice.ended.saved"), usageHref: "#usage", fx: cfg.fx };
  const states: [string, VoiceSnapshot][] = [
    ["1 · Ready", INITIAL_SNAPSHOT],
    ["2 · Microphone permission", { ...INITIAL_SNAPSHOT, phase: "mic_prompt" }],
    ["2b · Microphone blocked", { ...INITIAL_SNAPSHOT, phase: "mic_blocked" }],
    ["2c · No microphone", { ...INITIAL_SNAPSHOT, phase: "no_mic" }],
    ["3 · Connecting", { ...INITIAL_SNAPSHOT, phase: "connecting" }],
    ["4 · Listening", live({ live: "listening", connectedAt: now - 11_000, durationSec: 11 })],
    ["5 · Agent speaking", live({ live: "speaking" })],
    ["6 · Agent checking", live({ live: "checking", connectedAt: now - 31_000, durationSec: 31 })],
    ["7 · Muted", live({ live: "listening", muted: true, connectedAt: now - 64_000, durationSec: 64 })],
    ["8 · Reconnecting", { ...live({}), phase: "reconnecting", connectedAt: now - 137_000, durationSec: 137 }],
    ["9 · Ended (scripted)", { ...INITIAL_SNAPSHOT, phase: "ended", durationSec: 252, mode: "scripted", endReason: "user_hangup" }],
    ["9b · Ended (live)", { ...INITIAL_SNAPSHOT, phase: "ended", durationSec: 252, mode: "live", costMicros: 373_000, endReason: "user_hangup" }],
    ["9c · Ended · connection lost", { ...INITIAL_SNAPSHOT, phase: "ended", durationSec: 80, mode: "scripted", endReason: "connection_lost" }],
    ["10 · Calls are paused", { ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "spend_cap" }],
    ["10b · Too many calls", { ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "rate_limited", retryAt: new Date(Math.ceil(now / 3_600_000) * 3_600_000).toISOString() }],
    ["10c · Call already running (yours)", { ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "already_in_call", ownCall: true }],
    ["10d · Call already running (someone else)", { ...INITIAL_SNAPSHOT, phase: "unavailable", unavailable: "already_in_call", ownCall: false }],
    ["Notice · limit soon", live({ live: "speaking", notice: "limit_soon", connectedAt: now - 230_000, durationSec: 230 })],
  ];
  return (
    <div className="hx-grid">
      {states.map(([label, snap]) => (
        <div key={label} className="hx-cell" data-state-cell={label}>
          <span className="sas-label">{label}</span>
          <VoiceCallBar view={barView(snap, now, ctx)} />
        </div>
      ))}
    </div>
  );
}

function SettingsView({ cfg }: { cfg: Config }) {
  const [saved, setSaved] = useState<string | null>(null);
  const action = async (_prev: VoiceSettingsFormState, form: FormData): Promise<VoiceSettingsFormState> => {
    const r = await json<{ ok: boolean; errors?: Record<string, string> }>("/api/settings", { method: "POST", body: new URLSearchParams(form as unknown as Record<string, string>) });
    if (r.ok) setSaved(new Date().toISOString());
    return r.ok ? { ok: true } : { errors: r.errors };
  };
  return (
    <div className="hx-page">
      <section className="sas-panel hx-call">
        <div className="sas-panel__body hx-head">
          <h2 className="sas-heading">{t("lab.chat_with", { version: cfg.version })}</h2>
          <StatusPill object="agent_version" state="draft" />
        </div>
        {saved ? <div className="sas-alert sas-alert--success" role="status" data-saved=""><Icon name="check-circle" /><span>{t("voice.settings.saved", { version: cfg.version })}</span></div> : null}
      </section>
      {/* The list kit's SidePanel markup (next/link is not available outside Next). */}
      <div className="sas-sp">
        <span className="sas-sp__scrim hx-scrim" aria-hidden="true" />
        <section className="sas-sp__panel" role="dialog" aria-modal="true" aria-labelledby="hx-sp-title" data-sidepanel="">
          <header className="sas-sp__head">
            <div className="sas-sp__titles">
              <h2 id="hx-sp-title" className="sas-heading">{t("voice.settings.title")}</h2>
              <div className="sas-sp__meta">{t("voice.settings.meta", { version: cfg.version })}</div>
            </div>
            <a className="sas-sp__close" aria-label={t("kit.close")} href="?view=call"><Icon name="x" /></a>
          </header>
          <div className="sas-sp__body">
            <VoiceSettingsForm action={action} slug="harness" caps={cfg.caps} initial={cfg.settings} version={cfg.version} closeHref="?view=call" deploymentLimitSec={270} />
          </div>
        </section>
      </div>
    </div>
  );
}

function App({ cfg }: { cfg: Config }) {
  const view = params.get("view") ?? "call";
  return (
    <div className="sas-app" data-theme={params.get("theme") === "dark" ? "dark" : "light"}>
      <main className="hx-main">
        {view === "states" ? <StatesView cfg={cfg} /> : view === "settings" ? <SettingsView cfg={cfg} /> : <CallView cfg={cfg} />}
      </main>
    </div>
  );
}

void json<Config>(`/api/config${params.get("model") ? `?model=${encodeURIComponent(params.get("model")!)}` : ""}`).then((cfg) => createRoot(document.getElementById("root")!).render(<App cfg={cfg} />));
