"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { deleteRecording } from "@/lib/voice/recording-playback";

/**
 * "Delete recording…" on a call's player (seller side): the account check as every account action
 * (requireAccount), then the call's audio is deleted and the row says so; the written lines stay.
 * Returns to `back` when it is a page of this account, else the account's home.
 */
export async function deleteRecordingAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const sessionId = String(form.get("sessionId") ?? "");
  await deleteRecording(appDb, actorOf(access), access.account.id, sessionId);
  const base = `/app/${access.account.slug}`;
  const back = String(form.get("back") ?? "");
  revalidatePath(base, "layout");
  redirect(back === base || back.startsWith(`${base}/`) || back.startsWith(`${base}?`) ? back : base);
}
