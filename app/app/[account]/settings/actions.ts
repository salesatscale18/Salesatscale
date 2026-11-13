"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { createIntakeKey, previewLead, revokeIntakeKey } from "@/lib/leads/service";
import { parseJsonObject, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";
import { t, type Locale } from "@/lib/i18n";
import { inviteMember, parseNotifications, removeMember, saveContactHours, saveNotifications } from "@/lib/accounts/company";
import { parseContactHours } from "@/lib/accounts/contact-hours";
import { renewInvite } from "@/lib/accounts/service";

// ---------------------------------------------------------------------------
// Users, notifications, contact hours. Every action re-resolves access with
// requireAccount and passes only that account's id to the service.
// ---------------------------------------------------------------------------

const settingsPath = (slug: string, section: string) => `/app/${slug}/settings?section=${section}`;

async function inviteUrl(token: string): Promise<string> {
  const configured = process.env.APP_URL?.replace(/\/+$/, "");
  if (configured) return `${configured}/invite/${token}`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/invite/${token}`;
}

export type UserInviteState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; email: string; name: string | null; expiresAt: string; url: string };

export async function inviteUserAction(_prev: UserInviteState, form: FormData): Promise<UserInviteState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const r = await inviteMember(appDb, actorOf(access), access.account.id, { email: String(form.get("email") ?? ""), name: String(form.get("name") ?? "") });
  if (!r.ok) return { status: "error", message: t(r.reason === "already_member" ? "settings.users.err.already_member" : "settings.users.err.email") };
  revalidatePath(`/app/${access.account.slug}/settings`);
  return { status: "created", email: r.invite.email, name: r.invite.inviteeName, expiresAt: r.invite.expiresAt.toISOString(), url: await inviteUrl(r.token) };
}

export async function renewUserInviteAction(_prev: UserInviteState, form: FormData): Promise<UserInviteState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const renewed = await renewInvite(appDb, actorOf(access), access.account.id, String(form.get("inviteId") ?? ""));
  if (!renewed) return { status: "error", message: t("settings.users.err.invite_gone") };
  revalidatePath(`/app/${access.account.slug}/settings`);
  const { invite, token } = renewed;
  return { status: "created", email: invite.email, name: invite.inviteeName, expiresAt: invite.expiresAt.toISOString(), url: await inviteUrl(token) };
}

export async function removeMemberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const r = await removeMember(appDb, actorOf(access), access.account.id, String(form.get("memberId") ?? ""));
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(`${settingsPath(access.account.slug, "users")}&${r.ok ? "removed=1" : `error=${r.reason}`}`);
}

const rawOf = (form: FormData) => Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));

export async function saveNotificationsAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  await saveNotifications(appDb, actorOf(access), access.account.id, parseNotifications(rawOf(form)));
  revalidatePath(`/app/${access.account.slug}/settings`);
  redirect(`${settingsPath(access.account.slug, "notifications")}&saved=1`);
}

export async function saveContactHoursAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const parsed = parseContactHours(rawOf(form));
  if (!parsed.ok) redirect(`${settingsPath(access.account.slug, "hours")}&error=${encodeURIComponent(parsed.error)}`);
  await saveContactHours(appDb, actorOf(access), access.account.id, parsed.value);
  revalidatePath(`/app/${access.account.slug}/settings`);
  redirect(`${settingsPath(access.account.slug, "hours")}&saved=1`);
}

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
