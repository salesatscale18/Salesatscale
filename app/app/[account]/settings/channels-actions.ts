"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { smsConfig } from "@/lib/sms/rules";
import { accountSmsTestNumbers, saveSmsTestNumbers } from "@/lib/sms/settings";

// Server actions are public endpoints: each re-checks access with requireAccount() and
// changes only that account's own SMS test numbers (lib/sms/settings.ts).

const back = (slug: string, q: string) => `/app/${slug}/settings?section=channels&${q}`;

/** The account's current list: its own, else the platform default it starts from. */
async function currentNumbers(accountId: string) {
  return smsConfig(process.env, await accountSmsTestNumbers(appDb, accountId)).testNumbers;
}

/** Settings › Channels › SMS: add a test number. */
export async function addSmsTestNumberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const number = String(form.get("number") ?? "").slice(0, 40);
  const r = await saveSmsTestNumbers(appDb, actorOf(access), access.account, [...(await currentNumbers(access.account.id)), number]);
  revalidatePath(`/app/${access.account.slug}/settings`);
  redirect(back(access.account.slug, r.ok ? "saved=added" : `error=${r.reason}`));
}

/** Settings › Channels › SMS: remove a test number. */
export async function removeSmsTestNumberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const number = String(form.get("number") ?? "");
  const r = await saveSmsTestNumbers(appDb, actorOf(access), access.account, (await currentNumbers(access.account.id)).filter((n) => n !== number));
  revalidatePath(`/app/${access.account.slug}/settings`);
  redirect(back(access.account.slug, r.ok ? "saved=removed" : `error=${r.reason}`));
}
