import type { NextRequest } from "next/server";
import { appDb, requireAccount } from "@/lib/auth/account";
import { recordingResponse } from "@/lib/voice/recording-playback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A call's recording (seller side), streamed as a WAV with Range support. Access as every account page:
 * requireAccount (signed in, a member of this account, or a super admin acting as one; anyone else gets 404).
 * Only this account's calls; no public or signed URL is ever handed out.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ account: string; sessionId: string }> }) {
  const { account: slug, sessionId } = await params;
  const access = await requireAccount(slug);
  // ?download=1: the same audio as an attachment (the player's Download).
  return recordingResponse(appDb, access.account.id, sessionId, req.headers.get("range"), { download: new URL(req.url).searchParams.get("download") === "1" });
}
