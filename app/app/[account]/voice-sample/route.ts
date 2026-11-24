import type { NextRequest } from "next/server";
import { appDb, requireAccount } from "@/lib/auth/account";
import { voiceSampleResponse } from "@/lib/voice-rt-eleven/sample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Play sample" (Voice settings › Voice): a short WAV of the chosen ElevenLabs speaking model, voice and steadiness.
 * The account as every account page resolves it (requireAccount: anyone else gets 404); platform admins only, the
 * request validated, rate-limited, budget-checked and generated once per combination (lib/voice-rt-eleven/sample.ts).
 * POST (it can spend): body { model, voice, stability, language }.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const access = await requireAccount(slug);
  const body = await req.json().catch(() => null);
  return voiceSampleResponse({ user: access.user, accountId: access.account.id, body }, { db: appDb });
}
