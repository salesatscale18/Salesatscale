"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { setVoiceBuyerCalls } from "@/lib/voice/buyer";
import { voiceMode } from "@/lib/voice/settings";

/**
 * Settings › Voice: "Let buyers call the agent". Re-checks access on the
 * server (as the other settings) and that voice calls are on for the platform.
 */
export async function saveVoiceBuyerCallsAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const back = `/app/${access.account.slug}/settings?section=voice`;
  if (voiceMode() === "off") redirect(`/app/${access.account.slug}/settings`);
  await setVoiceBuyerCalls(appDb, actorOf(access), access.account.id, form.get("buyerCalls") === "on");
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(`${back}&saved=voice`);
}
