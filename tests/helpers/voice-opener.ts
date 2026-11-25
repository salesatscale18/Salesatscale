/**
 * "Protect the opening line" is on by default on test calls (lib/voice/settings.ts openerProtectionFor): the buyer's
 * audio does not reach the model while the opener plays. Tests that check what happens DURING the opener without it
 * (a barge-in on the opener, mic audio forwarded at once) switch it off on the account's versions for their run.
 */
import { eq } from "drizzle-orm";
import { agentVersions } from "@/db/schema";
import type { TestDb } from "./db";

export async function withOpenerUnprotected<T>(db: TestDb, accountId: string, fn: () => Promise<T>): Promise<T> {
  const versions = await db.select({ id: agentVersions.id, voiceSettings: agentVersions.voiceSettings }).from(agentVersions).where(eq(agentVersions.accountId, accountId));
  for (const v of versions) {
    await db.update(agentVersions).set({ voiceSettings: { ...(v.voiceSettings ?? {}), openerProtected: false } as never }).where(eq(agentVersions.id, v.id));
  }
  try {
    return await fn();
  } finally {
    for (const v of versions) await db.update(agentVersions).set({ voiceSettings: v.voiceSettings }).where(eq(agentVersions.id, v.id));
  }
}
