"use server";

/**
 * The buyer turns text messages back on from the chat menu (public: the chat
 * token is the only credential, re-verified here). POST only. Writes
 * `sms.resumed` (lib/sms/service resumeSms), which the SMS rules read.
 */
import { redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { isSimulatedLead } from "@/lib/simulator/rules";
import { resolveChatLink } from "@/lib/simulator/service";
import { chatPath } from "@/lib/simulator/token";
import { resumeSms } from "@/lib/sms/service";

export async function resumeSmsAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  // The key holds a hash, never the token.
  if (!(await rateLimit(appDb, `sms-resume:${hashKey(token)}`, { limit: 20, windowSeconds: 600 })).ok) redirect(chatPath(token));
  const link = await resolveChatLink(appDb, token);
  if (!link || isSimulatedLead(link.ctx.lead)) redirect(chatPath(token));
  await resumeSms(appDb, link.ctx.account.id, link.ctx.lead.id);
  redirect(`${chatPath(token)}?sms=on`);
}
