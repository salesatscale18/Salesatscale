"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { currentLegal, parseSettings, saveLegalSection, saveOrderFormSettings, sectionKeyOf, STARTER_SECTIONS } from "@/lib/orders/settings";

const path = (slug: string) => `/app/${slug}/setup/order-form`;

export async function saveSettingsAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = parseSettings(raw, form.getAll("fields").map(String));
  if (!parsed.ok) redirect(`${path(a.account.slug)}?error=${encodeURIComponent(parsed.error)}`);
  await saveOrderFormSettings(appDb, a.account.id, parsed.value);
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "order_form.settings_saved" });
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?saved=1`);
}

export async function saveSectionAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  const language = String(form.get("language") ?? "");
  if (!title || !body || !a.account.languages.includes(language)) redirect(`${path(a.account.slug)}?error=${encodeURIComponent("Enter a title and the text.")}`);
  const key = String(form.get("sectionKey") ?? "") || sectionKeyOf(String(form.get("keyTitle") ?? "") || title);
  const v = await saveLegalSection(appDb, a.account.id, a.user.id, { sectionKey: key, title, language, body });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "order_form.legal_saved", details: { key, language, version: v } });
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?legal=${key}.${language}.${v}`);
}

export async function removeSectionAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const key = String(form.get("sectionKey") ?? "");
  for (const s of (await currentLegal(appDb, a.account.id)).filter((x) => x.sectionKey === key)) {
    await saveLegalSection(appDb, a.account.id, a.user.id, { sectionKey: key, title: s.title, language: s.language, body: s.body, active: false });
  }
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "order_form.legal_removed", details: { key } });
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

export async function starterAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  for (const s of STARTER_SECTIONS) {
    for (const lang of a.account.languages) {
      const [title, body] = lang === "he" ? s.he : s.en;
      await saveLegalSection(appDb, a.account.id, a.user.id, { sectionKey: s.key, title, language: lang, body });
    }
  }
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?starter=1`);
}
