"use server";

import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { createIntakeKey, revokeIntakeKey } from "@/lib/leads/service";

export type KeyState = { status: "idle" } | { status: "created"; name: string; key: string };

export async function createIntakeKeyAction(_prev: KeyState, form: FormData): Promise<KeyState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const name = String(form.get("name") ?? "").slice(0, 60);
  const { row, key } = await createIntakeKey(appDb, actorOf(access), access.account.id, name);
  revalidatePath(`/app/${access.account.slug}/settings`);
  return { status: "created", name: row.name, key };
}

export async function revokeIntakeKeyAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  await revokeIntakeKey(appDb, actorOf(access), access.account.id, String(form.get("keyId") ?? ""));
  revalidatePath(`/app/${access.account.slug}/settings`);
}
