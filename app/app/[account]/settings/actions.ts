"use server";

import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { createIntakeKey, previewLead, revokeIntakeKey } from "@/lib/leads/service";
import { parseJsonObject, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";
import { t, type Locale } from "@/lib/i18n";

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

export type SampleState =
  | { status: "idle" }
  | { status: "checked"; result: "created" | "updated" | "rejected"; text: string };

/** "Check a sample": validation only, never writes (shared production DB). */
export async function checkSampleAction(_prev: SampleState, form: FormData): Promise<SampleState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const { account } = access;
  const body = parseJsonObject(String(form.get("sample") ?? "").slice(0, 32 * 1024));
  if (!body) return { status: "checked", result: "rejected", text: t("settings.sample.not_json") };
  const lead = parseLead(rawFromIntakeBody(body), account.market, {
    language: (account.languages[0] ?? "en") as Locale,
    now: new Date(),
    requireConsentText: true,
  });
  if (!lead.ok) {
    return { status: "checked", result: "rejected", text: t("settings.sample.rejected", { reason: Object.values(lead.errors)[0] ?? "" }) };
  }
  const p = await previewLead(appDb, account.id, lead.value);
  if (p.result === "created") return { status: "checked", result: "created", text: t("settings.sample.created") };
  if (p.result === "updated") return { status: "checked", result: "updated", text: t("settings.sample.updated", { name: p.leadName }) };
  return { status: "checked", result: "rejected", text: t("settings.sample.rejected", { reason: p.reason }) };
}
