"use server";

import { isUuid } from "@/lib/security/ids";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { createIntakeKey, previewLead, revokeIntakeKey, setIntakeKeyMarket } from "@/lib/leads/service";
import { consentSourceIntake, parseJsonObject, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";
import { t, type Locale } from "@/lib/i18n";
import { inviteMember, parseNotifications, removeMember, saveContactHours, saveNotifications } from "@/lib/accounts/company";
import { parseContactHours } from "@/lib/accounts/contact-hours";
import { renewInvite } from "@/lib/accounts/service";
import { addConnection, addTemplate, refreshTemplateStatuses, removeConnection, removeTemplate, setConnectionStatus, setTesterNumbers } from "@/lib/channels/connections";
import { defaultTransport } from "@/lib/channels/twilio";
import { rateLimit } from "@/lib/security/rate-limit";

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
  const inviteId = String(form.get("inviteId") ?? "");
  const renewed = isUuid(inviteId) ? await renewInvite(appDb, actorOf(access), access.account.id, inviteId) : null;
  if (!renewed) return { status: "error", message: t("settings.users.err.invite_gone") };
  revalidatePath(`/app/${access.account.slug}/settings`);
  const { invite, token } = renewed;
  return { status: "created", email: invite.email, name: invite.inviteeName, expiresAt: invite.expiresAt.toISOString(), url: await inviteUrl(token) };
}

export async function removeMemberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const memberId = String(form.get("memberId") ?? "");
  if (!isUuid(memberId)) redirect(settingsPath(access.account.slug, "users"));
  const r = await removeMember(appDb, actorOf(access), access.account.id, memberId);
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
  const keyId = String(form.get("keyId") ?? "");
  if (isUuid(keyId)) await revokeIntakeKey(appDb, actorOf(access), access.account.id, keyId);
  revalidatePath(`/app/${access.account.slug}/settings`);
}

/** Links an intake key to a market (or to none: then country and phone choose the market). */
export async function setIntakeKeyMarketAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const keyId = String(form.get("keyId") ?? "");
  const marketId = String(form.get("marketId") ?? "");
  const ok = isUuid(keyId) && (marketId === "" || isUuid(marketId))
    ? await setIntakeKeyMarket(appDb, actorOf(access), access.account.id, keyId, marketId || null)
    : false;
  revalidatePath(`/app/${access.account.slug}/settings`);
  redirect(`${settingsPath(access.account.slug, "intake")}&${ok ? "key_market=1" : "key_market_error=1"}`);
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
    // As the intake endpoint: consent by default, a consent note is optional.
    consentByDefault: true,
    consentSource: consentSourceIntake("sample"),
  });
  if (!lead.ok) {
    return { status: "checked", result: "rejected", text: t("settings.sample.rejected", { reason: Object.values(lead.errors)[0] ?? "" }) };
  }
  const p = await previewLead(appDb, account.id, lead.value);
  if (p.result === "created") return { status: "checked", result: "created", text: t("settings.sample.created") };
  if (p.result === "updated") return { status: "checked", result: "updated", text: t("settings.sample.updated", { name: p.leadName }) };
  return { status: "checked", result: "rejected", text: t("settings.sample.rejected", { reason: p.reason }) };
}

// ---------------------------------------------------------------------------
// WhatsApp (P6.8): numbers and templates. Same pattern: access first, then
// only this account's id goes to the service.
// ---------------------------------------------------------------------------

const whatsappBack = (slug: string, q: string) => `${settingsPath(slug, "whatsapp")}&${q}`;

export async function addWhatsappNumberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const marketId = String(form.get("marketId") ?? "");
  const r = await addConnection(appDb, actorOf(access), access.account, {
    senderNumber: String(form.get("senderNumber") ?? ""),
    displayName: String(form.get("displayName") ?? ""),
    messagingServiceSid: String(form.get("messagingServiceSid") ?? ""),
    marketId: isUuid(marketId) ? marketId : null,
  });
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, r.ok ? "saved=number" : `error=${r.reason}`));
}

export async function setWhatsappNumberStatusAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("connectionId") ?? "");
  const status = String(form.get("status") ?? "") === "disabled" ? "disabled" : "active";
  const ok = isUuid(id) && (await setConnectionStatus(appDb, actorOf(access), access.account.id, id, status));
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, ok ? `saved=${status}` : "error=not_found"));
}

export async function removeWhatsappNumberAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("connectionId") ?? "");
  const ok = isUuid(id) && (await removeConnection(appDb, actorOf(access), access.account.id, id));
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, ok ? "saved=removed" : "error=not_found"));
}

export async function setTesterNumbersAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("connectionId") ?? "");
  const r = isUuid(id)
    ? await setTesterNumbers(appDb, actorOf(access), access.account, id, String(form.get("testers") ?? ""))
    : { ok: false as const, reason: "not_found" as const };
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, r.ok ? "saved=testers" : `error=${r.reason}`));
}

export async function addTemplateAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const purpose = String(form.get("purpose") ?? "") === "follow_up" ? "follow_up" : "opener";
  // Each add calls Twilio: 30 per account per hour.
  if (!(await rateLimit(appDb, `wa-template:${access.account.id}`, { limit: 30, windowSeconds: 3600 })).ok) redirect(whatsappBack(access.account.slug, "error=rate_limited"));
  const r = await addTemplate(appDb, defaultTransport(), actorOf(access), access.account.id, { contentSid: String(form.get("contentSid") ?? ""), purpose });
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, r.ok ? "saved=template" : `error=${r.reason}`));
}

export async function refreshTemplatesAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  if (!(await rateLimit(appDb, `wa-refresh:${access.account.id}`, { limit: 30, windowSeconds: 3600 })).ok) redirect(whatsappBack(access.account.slug, "error=rate_limited"));
  await refreshTemplateStatuses(appDb, defaultTransport(), access.account.id);
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, "saved=refreshed"));
}

export async function removeTemplateAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("templateId") ?? "");
  const ok = isUuid(id) && (await removeTemplate(appDb, actorOf(access), access.account.id, id));
  revalidatePath(`/app/${access.account.slug}`, "layout");
  redirect(whatsappBack(access.account.slug, ok ? "saved=template_removed" : "error=not_found"));
}
