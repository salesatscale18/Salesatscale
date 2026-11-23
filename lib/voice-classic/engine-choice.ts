/**
 * Which voice engine runs a call: "current" (lib/voice/engine.ts, the default and the only one for buyers),
 * "classic" (lib/voice-classic/engine.ts, the 20 Nov engine) or "guarded" ("Classic + guards": today's engine with
 * the Classic model side and today's guards, lib/voice-guarded), picked in the test lab by platform admins only.
 * The choice is stored on the session (voice_sessions.settings.engine) and read from the row by the socket.
 * Pure and import-safe from client code.
 */
import { voiceLabAccess } from "@/lib/voice/lab";

export const VOICE_ENGINES = ["current", "classic", "guarded"] as const;
export type VoiceEngineName = (typeof VOICE_ENGINES)[number];
export const CLASSIC_ENGINE = "classic" as const satisfies VoiceEngineName;
export const GUARDED_ENGINE = "guarded" as const satisfies VoiceEngineName;

/** An engine other than Current, as stored or posted ("classic", "guarded"); null for anything else. */
const otherEngine = (v: unknown): VoiceEngineName | null => (v === CLASSIC_ENGINE || v === GUARDED_ENGINE ? v : null);

/** The engine a session runs on, from its settings JSON: "classic" or "guarded" only when stored so; anything else is Current. */
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
