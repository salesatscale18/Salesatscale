"use server";

/**
 * Test-lab voice calls (live voice, release 1). Every action checks on the
 * server: the account (requireAccount, as the other test-lab actions), the
 * role (platform admins only, also when acting as an account) and the voice
 * mode (VOICE_REALTIME not off). Nobody else gets anything back.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listVersions } from "@/lib/agent/service";
import { scenarioById } from "@/lib/agent/scenarios";
import { isUuid } from "@/lib/security/ids";
import { spendCapped, platformBudget } from "@/lib/ai/usage";
import { usdRate } from "@/lib/ai/models";
import { createVoiceSession, endUserTestVoiceSessions, runningTestVoiceSession, saveDraftVoiceSettings, startVoiceTestConversation } from "@/lib/voice/service";
import { maxCallSeconds, resolveVoiceSettings, sentCallVoice, versionModelId, type CallVoiceInfo, voiceCapabilities, voiceMode, voiceModelLabel } from "@/lib/voice/settings";
import { voiceLabAccess } from "@/lib/voice/lab";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
import { isGatewayPipelineEngine, isPipelineEngine, labEngineChoice, type VoiceEngineName } from "@/lib/voice-classic/engine-choice";
import { classicModelId } from "@/lib/voice-classic/settings";
import { PIPELINE_LISTEN_MODEL, PIPELINE_SPEAK_MODEL, PIPELINE_VOICE_NAME } from "@/lib/voice-pipeline/models";
import { pipelineModelsLabel, thinkModelLabel } from "@/lib/voice-pipeline/summary";
import { pipelineThinkModelFor, SCRIPTED_THINK_MODEL } from "@/lib/voice-pipeline";
import { minorPerUsd, voiceSocketUrl } from "./voice-server";
import type { VoiceUnavailableReason } from "@/lib/voice/client/state";
import type { VoiceSettingsFormState } from "@/components/sas/voice/voice-settings-form";

const path = (slug: string) => `/app/${slug}/setup/test-lab`;

export type StartVoiceCallResult =
  | {
      ok: true; conversationId: string; sessionId: string; ticket: string; wsUrl: string; mode: "scripted" | "live"; maxSec: number;
      /** The call's voice model, as its label ("GPT-Realtime mini"): its version's (a Classic call: Gemini). */
      model: string;
      /** The voice engine the call runs on (platform admins pick it; anyone else gets Current). */
      engine: VoiceEngineName;
      /** A Classic call on a version set to a non-Gemini model: it runs on Gemini instead (the page says so). */
      classicOnGemini?: boolean;
      /** The voice and fillers this call starts with ("default": no voice sent, the model's own). */
      voiceUsed: CallVoiceInfo;
      fx: { currency: string; minorPerUsd: number | null };
    }
  /**
   * `retryAt` (ISO): when a rate-limited caller may try again. `ownCall`: the
   * running call that blocks a new one was started by this user (they may end it).
   */
  | { ok: false; reason: VoiceUnavailableReason; retryAt?: string; ownCall?: boolean };

/** Starts a test-lab call: a new voice test conversation on the chosen version and scenario, and its one-time socket ticket. */
export async function startVoiceCallAction(input: { slug: string; versionId?: string | null; scenario?: string | null; language?: string | null; engine?: string | null }): Promise<StartVoiceCallResult> {
  const a = await requireAccount(String(input?.slug ?? ""));
  const gate = voiceLabAccess(a.user);
  if (gate === "not_admin") return { ok: false, reason: "not_allowed" };
  if (gate === "voice_off") return { ok: false, reason: "voice_off" };
  const mode = voiceMode();
  if (a.account.status === "paused") return { ok: false, reason: "account_paused" };
  // A live call is refused at the caps before anything is created (scripted calls cost nothing).
  if (mode === "live") {
    if (await spendCapped(appDb, a.account.id)) return { ok: false, reason: "spend_cap" };
    if ((await platformBudget(appDb)).exceeded) return { ok: false, reason: "platform_budget" };
  }
  // One test call per account at a time (release 1); the caller may end their own.
  const running = await runningTestVoiceSession(appDb, a.account.id);
  if (running) return { ok: false, reason: "already_in_call", ownCall: running.startedByUserId === a.user.id };
  // The call starts in the buyer language picked (a scenario brings its own, as for a chat), if the account speaks it.
  const scenario = scenarioById(String(input?.scenario ?? ""));
  const wanted = scenario?.language ?? String(input?.language ?? "en");
  const language = a.account.languages.includes(wanted) ? wanted : "en";
  const rawVersion = input?.versionId;
  const versionId = isUuid(rawVersion) ? rawVersion : undefined;
  const conv = await startVoiceTestConversation(appDb, a.account.id, a.user.id, { scenario: scenario && scenario.language === language ? scenario.id : null, versionId, language });
  if (!conv) return { ok: false, reason: "error" };
  // The voice engine: honoured from a platform admin only (checked here on the server); anyone else gets Current.
  const engine = labEngineChoice(a.user, input?.engine);
  const s = await createVoiceSession(appDb, { accountId: a.account.id, conversationId: conv.conversationId, userId: a.user.id, isTest: true }, { engine });
  if (!s.ok) {
    const reason: VoiceUnavailableReason =
      s.reason === "spend_cap" || s.reason === "platform_budget" || s.reason === "rate_limited" || s.reason === "voice_off" || s.reason === "account_paused" || s.reason === "already_in_call"
        ? s.reason : "error";
    return { ok: false, reason, ...(s.retryAt ? { retryAt: s.retryAt.toISOString() } : {}) };
  }
  revalidatePath(path(a.account.slug));
  const maxSec = maxCallSeconds({ settings: conv.version.voiceSettings, deadlineSec: deploymentCallLimitSec() });
  const callModel = engine === "classic" ? classicModelId(versionModelId(conv.version.voiceSettings)) : versionModelId(conv.version.voiceSettings);
  const resolved = resolveVoiceSettings(conv.version.voiceSettings);
  // A pipeline engine: its three models (listening; thinking = Gemini 3.8 Flash on "pipeline" (VOICE_PIPELINE_TEXT_MODEL
  // overrides it), Gemini 3.5 Flash-Lite on "pipeline_lite", the version's chat model on "pipeline_chat"; speaking) and its one voice.
  const pipeline = isPipelineEngine(engine);
  const thinkModel = s.mode === "scripted" ? SCRIPTED_THINK_MODEL : isGatewayPipelineEngine(engine) ? pipelineThinkModelFor(engine, process.env) : conv.version.model;
  const voiceUsed: CallVoiceInfo = pipeline ? { voice: PIPELINE_VOICE_NAME, fillers: false } : { voice: sentCallVoice(resolved.voice, callModel) ?? "default", fillers: resolved.fillers };
  return {
    ok: true, conversationId: conv.conversationId, sessionId: s.sessionId, ticket: s.ticket, wsUrl: await voiceSocketUrl(), mode: s.mode, maxSec,
    model: pipeline ? pipelineModelsLabel({ listenModel: PIPELINE_LISTEN_MODEL, thinkModel: thinkModelLabel(thinkModel), speakModel: PIPELINE_SPEAK_MODEL })
      : voiceModelLabel(engine === "classic" ? classicModelId(versionModelId(conv.version.voiceSettings)) : versionModelId(conv.version.voiceSettings)),
    engine, ...(engine === "classic" && classicModelId(versionModelId(conv.version.voiceSettings)) !== versionModelId(conv.version.voiceSettings) ? { classicOnGemini: true } : {}),
    voiceUsed,
    fx: { currency: a.account.currency, minorPerUsd: minorPerUsd(usdRate(a.account.currency)) },
  };
}

/** "End that call": ends this user's running test calls on the account (the relay notices within a few seconds). */
export async function endMyVoiceCallAction(input: { slug: string }): Promise<{ ok: boolean }> {
  const a = await requireAccount(String(input?.slug ?? ""));
  if (voiceLabAccess(a.user) !== "ok") return { ok: false };
  await endUserTestVoiceSessions(appDb, a.account.id, a.user.id);
  revalidatePath(path(a.account.slug));
  return { ok: true };
}

/** Saves the draft version's voice settings from the side panel, then closes it. */
export async function saveVoiceSettingsAction(_prev: VoiceSettingsFormState, form: FormData): Promise<VoiceSettingsFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  if (voiceLabAccess(a.user) !== "ok") return { failed: true };
  const draft = (await listVersions(appDb, a.account.id)).find((v) => v.status === "draft");
  if (!draft) return { failed: true };
  const current = resolveVoiceSettings(draft.voiceSettings);
  const str = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)) : "");
  // The model picked at the top of the panel (validated in saveDraftVoiceSettings); the rest is what it offers.
  const model = str("model") || versionModelId(draft.voiceSettings);
  const caps = voiceCapabilities(model);
  // Settings the model does not offer are not in the form: their stored values are kept (a voice of another
  // model's list is dropped by the validation when the model changes).
  const input = {
    model: str("model") || draft.voiceSettings?.model,
    voice: caps.voices.length ? str("voice") : draft.voiceSettings?.voice,
    pace: caps.pace ? str("pace") : draft.voiceSettings?.pace,
    style: caps.style ? str("style") : draft.voiceSettings?.style,
    pauseMs: caps.pauseMs ? str("pauseMs") : draft.voiceSettings?.pauseMs,
    interrupt: caps.interruptSensitivity ? str("interrupt") : draft.voiceSettings?.interrupt,
    fillers: caps.fillers ? form.get("fillers") === "on" : current.fillers,
    maxCallSec: str("maxCallSec"),
  };
  const r = await saveDraftVoiceSettings(appDb, a.account.id, input);
  if (!r.ok) return { errors: r.errors };
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?voice_saved=${draft.version}`);
}
