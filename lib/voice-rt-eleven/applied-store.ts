/**
 * Stores what ElevenLabs speech actually used on a call (./speaker.ts ElevenApplied) on its session, under
 * voice_sessions.settings.elevenApplied (JSON, no schema change), merged into the settings the engine stored. Called
 * by the socket once the engine has stored the call, so the call card ("This call": Voice, Speaking) says what was
 * heard, also after a fallback. Server-only.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { voiceSessions } from "@/db/schema";
import type { ElevenApplied } from "./speaker";

export async function storeElevenApplied(db: Db, sessionId: string, applied: ElevenApplied): Promise<void> {
  const patch = JSON.stringify({ elevenApplied: applied });
  await db.update(voiceSessions)
    .set({ settings: sql`coalesce(${voiceSessions.settings}, '{}'::jsonb) || ${patch}::jsonb` })
    .where(eq(voiceSessions.id, sessionId));
}
