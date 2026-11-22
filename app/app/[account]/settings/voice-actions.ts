"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { setVoiceBuyerCalls } from "@/lib/voice/buyer";
import { voiceMode } from "@/lib/voice/settings";
import { parseRecordingSettings, saveRecordingSettings } from "@/lib/voice/recording-settings";

/**
 * Settings › Voice: "Let buyers call the agent", call recording and the recording notice. Re-checks access on the
 * server (as the other settings) and that voice calls are on for the platform.
 */
export async function saveVoiceBuyerCallsAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const back = `/app/${access.account.slug}/settings?section=voice`;
  if (voiceMode() === "off") redirect(`/app/${access.account.slug}/settings`);
  await setVoiceBuyerCalls(appDb, actorOf(access), access.account.id, form.get("buyerCalls") === "on");
  // Call recording and its notice (company level): validated as two booleans, saved and audited on the server.
  await saveRecordingSettings(appDb, actorOf(access), access.account.id, parseRecordingSettings(form));
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(`${back}&saved=voice`);
}
