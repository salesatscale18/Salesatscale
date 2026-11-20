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
import { maxCallSeconds, resolveVoiceSettings, voiceCapabilities, voiceMode, voiceModelId } from "@/lib/voice/settings";
import { voiceLabAccess } from "@/lib/voice/lab";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
import { minorPerUsd, voiceSocketUrl } from "./voice-server";
import type { VoiceUnavailableReason } from "@/lib/voice/client/state";
import type { VoiceSettingsFormState } from "@/components/sas/voice/voice-settings-form";

const path = (slug: string) => `/app/${slug}/setup/test-lab`;

export type StartVoiceCallResult =
  | {
      ok: true; conversationId: string; sessionId: string; ticket: string; wsUrl: string; mode: "scripted" | "live"; maxSec: number;
      fx: { currency: string; minorPerUsd: number | null };
    }
  /**
   * `retryAt` (ISO): when a rate-limited caller may try again. `ownCall`: the
   * running call that blocks a new one was started by this user (they may end it).
   */
  | { ok: false; reason: VoiceUnavailableReason; retryAt?: string; ownCall?: boolean };

/** Starts a test-lab call: a new voice test conversation on the chosen version and scenario, and its one-time socket ticket. */
export async function startVoiceCallAction(input: { slug: string; versionId?: string | null; scenario?: string | null; language?: string | null }): Promise<StartVoiceCallResult> {
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
  const s = await createVoiceSession(appDb, { accountId: a.account.id, conversationId: conv.conversationId, userId: a.user.id, isTest: true });
  if (!s.ok) {
    const reason: VoiceUnavailableReason =
      s.reason === "spend_cap" || s.reason === "platform_budget" || s.reason === "rate_limited" || s.reason === "voice_off" || s.reason === "account_paused" || s.reason === "already_in_call"
        ? s.reason : "error";
    return { ok: false, reason, ...(s.retryAt ? { retryAt: s.retryAt.toISOString() } : {}) };
  }
  revalidatePath(path(a.account.slug));
  const maxSec = maxCallSeconds({ settings: conv.version.voiceSettings, deadlineSec: deploymentCallLimitSec() });
  return {
    ok: true, conversationId: conv.conversationId, sessionId: s.sessionId, ticket: s.ticket, wsUrl: await voiceSocketUrl(), mode: s.mode, maxSec,
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
  const caps = voiceCapabilities(voiceModelId());
  const current = resolveVoiceSettings(draft.voiceSettings);
  const str = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)) : "");
  // Settings the model does not offer are not in the form: their stored values are kept.
  const input = {
    voice: caps.voices.length ? str("voice") : draft.voiceSettings?.voice,
    pace: caps.pace ? str("pace") : draft.voiceSettings?.pace,
    style: caps.style ? str("style") : draft.voiceSettings?.style,
    fillers: caps.fillers ? form.get("fillers") === "on" : current.fillers,
    maxCallSec: str("maxCallSec"),
  };
  const r = await saveDraftVoiceSettings(appDb, a.account.id, input);
  if (!r.ok) return { errors: r.errors };
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?voice_saved=${draft.version}`);
}
