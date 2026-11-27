"use server";

import { cookies } from "next/headers";
import { appDb } from "@/lib/auth/account";
import { handoverWrittenOpener, recordHandoverChoice } from "@/lib/lead-pages/handover";
import { LEAD_COOKIE } from "@/lib/lead-pages/tokens";
import { chatViewerIsStaff } from "@/lib/voice/chat-viewer";

/**
 * The buyer picked how to talk on the hand-over ("Talk now" = voice; "Chat in writing" or
 * "Continue to the chat" = text): stored on the submission, and the chat open recorded
 * (never for the seller's signed-in staff). The token and the browser's sas_lp cookie are
 * the only credentials; the same checks as the page apply (lib/lead-pages/handover.ts).
 */
export async function chooseHandoverAction(token: string, choice: "voice" | "text"): Promise<{ ok: boolean }> {
  if (typeof token !== "string" || (choice !== "voice" && choice !== "text")) return { ok: false };
  const cookie = (await cookies()).get(LEAD_COOKIE)?.value ?? null;
  const r = await recordHandoverChoice(appDb, { token, choice, cookie, staffViewer: chatViewerIsStaff });
  return { ok: r.ok };
}

/**
 * The written opener before the chat is revealed ("Chat in writing", "Continue to the chat") or after a call that
 * could not start ("Talk now" posts nothing: the call speaks first). Idempotent; the same credentials as above.
 */
export async function writtenOpenerAction(token: string): Promise<{ ok: boolean }> {
  if (typeof token !== "string") return { ok: false };
  const cookie = (await cookies()).get(LEAD_COOKIE)?.value ?? null;
  const r = await handoverWrittenOpener(appDb, { token, cookie });
  return { ok: r.ok };
}
