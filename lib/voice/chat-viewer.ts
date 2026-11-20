/**
 * Who is looking at a public buyer chat (/chat/<token>)? The chat routes are public in proxy.ts, but
 * clerkMiddleware still runs on them (it authenticates every matched request and returns early only
 * from our handler), so `auth()` reads the browser's Clerk session here. Server-only.
 *
 * Used to show the seller's own staff why "Switch to voice" is off (lib/voice/buyer.ts buyerVoiceView).
 * An anonymous viewer costs only the local session check: no database read, no call to Clerk.
 */
import { auth } from "@clerk/nextjs/server";
import { appDb } from "@/lib/auth/account";
import { ensureUser } from "@/lib/ensure-user";
import { seesBuyerVoiceReasons } from "./buyer";

/** True when the viewer is signed in as a member of `accountId` or as a platform admin (super admin). */
export async function chatViewerIsStaff(accountId: string): Promise<boolean> {
  try {
    const { userId } = await auth();
    if (!userId) return false;
    return await seesBuyerVoiceReasons(appDb, await ensureUser(), accountId);
  } catch {
    // No Clerk context (or Clerk unreachable): treat as an anonymous buyer, who is never told why.
    return false;
  }
}
