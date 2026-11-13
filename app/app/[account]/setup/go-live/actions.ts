"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { goLive, saveRollout } from "@/lib/accounts/go-live";

const path = (slug: string) => `/app/${slug}/setup/go-live`;

/** Go live: the checklist is computed again on the server; the button state is never trusted. */
export async function goLiveAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const r = await goLive(appDb, actorOf(a), a.account.id);
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(r.ok ? `${path(a.account.slug)}?live=1` : `${path(a.account.slug)}?error=${r.reason}`);
}

export async function saveRolloutAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const ok = await saveRollout(appDb, actorOf(a), a.account.id, String(form.get("rollout") ?? ""));
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?${ok ? "rollout=1" : "error=rollout"}`);
}
