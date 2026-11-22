"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { deleteRecording } from "@/lib/voice/recording-playback";

/**
 * "Delete recording…" on a call's player (seller side, account admins only): the account check as every account
 * action (requireAccount), the admin role from the access row, then the call's audio is deleted and the row says
 * so; the written lines stay. A role that may not delete changes nothing (deleteRecording returns "forbidden").
 * Returns to `back` when it is a page of this account, else the account's home.
 */
export async function deleteRecordingAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const sessionId = String(form.get("sessionId") ?? "");
  // Account admins only (recordings are kept as evidence): checked here, on the server, from the access row.
  await deleteRecording(appDb, { role: access.role, actor: actorOf(access) }, access.account.id, sessionId);
  // A role that may not delete: nothing changes (the item is not shown to it either).
  const base = `/app/${access.account.slug}`;
  const back = String(form.get("back") ?? "");
  revalidatePath(base, "layout");
  redirect(back === base || back.startsWith(`${base}/`) || back.startsWith(`${base}?`) ? back : base);
}
