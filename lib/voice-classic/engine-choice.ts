/**
 * Which voice engine runs a call: "current" (lib/voice/engine.ts, the default and the only one for buyers),
 * "classic" (lib/voice-classic/engine.ts, the 20 Nov engine) or "guarded" ("Classic + guards": today's engine with
 * the Classic model side and today's guards, lib/voice-guarded) or "guarded_silent" (guarded plus, on Gemini, the
 * silent bookkeeping probe: lib/voice-guarded/silent-probe.ts), picked in the test lab by platform admins only.
 * The choice is stored on the session (voice_sessions.settings.engine) and read from the row by the socket.
 * Pure and import-safe from client code.
 */
import { voiceLabAccess } from "@/lib/voice/lab";

export const VOICE_ENGINES = ["current", "classic", "guarded", "guarded_silent"] as const;
export type VoiceEngineName = (typeof VOICE_ENGINES)[number];
export const CLASSIC_ENGINE = "classic" as const satisfies VoiceEngineName;
export const GUARDED_ENGINE = "guarded" as const satisfies VoiceEngineName;
export const GUARDED_SILENT_ENGINE = "guarded_silent" as const satisfies VoiceEngineName;

/** The engines that run today's engine with the guarded profile (lib/voice-guarded/profile.ts). */
export const isGuardedEngine = (e: VoiceEngineName): e is typeof GUARDED_ENGINE | typeof GUARDED_SILENT_ENGINE => e === GUARDED_ENGINE || e === GUARDED_SILENT_ENGINE;

/** The i18n key of an engine's label (the select, the call card, the header pill). */
export const engineLabelKey = (engine: VoiceEngineName | null | undefined) =>
  engine === CLASSIC_ENGINE ? "lab.voice.engine.classic"
    : engine === GUARDED_ENGINE ? "lab.voice.engine.guarded"
      : engine === GUARDED_SILENT_ENGINE ? "lab.voice.engine.guarded_silent"
        : "lab.voice.engine.current";

/** An engine other than Current, as stored or posted ("classic", "guarded", "guarded_silent"); null for anything else. */
export const otherEngine = (v: unknown): Exclude<VoiceEngineName, "current"> | null =>
  (v === CLASSIC_ENGINE || v === GUARDED_ENGINE || v === GUARDED_SILENT_ENGINE ? v : null);

/** The engine a session runs on, from its settings JSON: another engine only when stored so; anything else is Current. */
export function sessionEngine(settings: unknown): VoiceEngineName {
  const stored = settings && typeof settings === "object" ? (settings as { engine?: unknown }).engine : null;
  return otherEngine(stored) ?? "current";
}

/**
 * The engine a test-lab call starts on: what the form posted, honoured only for a platform admin (the same check as
 * the voice model picker and the whole voice lab: lib/voice/lab.ts voiceLabAccess). Anyone else gets Current.
 */
export function labEngineChoice(user: { role: string } | null | undefined, posted: unknown, env: Record<string, string | undefined> = process.env): VoiceEngineName {
  if (voiceLabAccess(user, env) !== "ok") return "current";
  return otherEngine(posted) ?? "current";
}
