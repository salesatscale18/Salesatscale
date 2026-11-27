/**
 * Whether anything was said in a call: a line from the agent or the buyer stored with its voice session. A call with
 * none (the model never connected, the agent never spoke, the buyer hung up first) gets no "Voice call ended · 0:00"
 * line and no call row anywhere (lib/agent/thread-markers.ts isUnsaidCall; owner, 26 Nov 2026). Every end path that
 * stores the end line asks this first: the engines (Current, the pipeline, Classic) and the stale close.
 */
import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { Db } from "@/db/types";

export async function callHasLines(db: Db, accountId: string, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.voiceSessionId, sessionId))).limit(1);
  return !!row;
}
