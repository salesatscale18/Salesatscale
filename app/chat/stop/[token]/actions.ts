"use server";

/**
 * The buyer stops SMS (public: the signed stop token is the only credential,
 * re-verified by stopSms). POST only, so link-preview bots that open the SMS
 * link never stop anything.
 */
import { redirect } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { hashKey, rateLimit } from "@/lib/security/rate-limit";
import { stopSms } from "@/lib/sms/service";
import { stopPath } from "@/lib/sms/token";

export async function stopSmsAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  // The key holds a hash, never the token.
  if ((await rateLimit(appDb, `sms-stop:${hashKey(token)}`, { limit: 20, windowSeconds: 600 })).ok) await stopSms(appDb, token);
  redirect(stopPath(token));
}
