/**
 * The voice bubble's cross-tab link: the chat tab (which runs the call) and an order form tab of the same
 * conversation talk over a BroadcastChannel whose name only the server can make. Server-only.
 *
 * The name is an HMAC of the conversation id with a server secret (never a raw token or id), so a page
 * gets it only when the server authorised it: the chat page from its chat token, the order form page
 * from its form token when the form's lead has that chat conversation. A form of another lead gets
 * another name (or none), so it can never join the call.
 */
import { createHmac } from "node:crypto";
import type { Db } from "@/db/types";
import { serverSecret } from "@/lib/orders/token";
import { buyerConversation } from "./buyer";
import { voiceMode } from "./settings";

/** The channel name for a conversation's call ("sas-voice-" + 22 url-safe characters). */
export function voiceTabKey(conversationId: string): string {
  const mac = createHmac("sha256", serverSecret("ORDER_LINK_SECRET")).update(`voice-tab:${conversationId}`).digest();
  return `sas-voice-${mac.subarray(0, 16).toString("base64url")}`;
}

/**
 * The key for an order form page, or null: voice calls are on and the form's lead has a buyer chat
 * conversation (the one whose chat page can run a call). The caller has already resolved the form from
 * its signed token (lib/orders/service loadForm), which is the authorisation.
 */
export async function voiceTabKeyForForm(
  db: Db, form: { accountId: string; leadId: string }, env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (voiceMode(env) === "off") return null;
  const conv = await buyerConversation(db, { account: { id: form.accountId }, lead: { id: form.leadId } } as Parameters<typeof buyerConversation>[1]);
  return conv ? voiceTabKey(conv.id) : null;
}
