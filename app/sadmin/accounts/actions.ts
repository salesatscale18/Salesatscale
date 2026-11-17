"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { isUuid } from "@/lib/security/ids";
import { writeAudit } from "@/lib/accounts/audit";
import { parseCreateAccount, type FieldErrors } from "@/lib/accounts/rules";
import { createAccount, createInvite, getAccountById, pauseAccount, renewInvite, resumeAccount } from "@/lib/accounts/service";
import { createDemoAccount, removeDemoAccount } from "@/lib/demo/seed";

// Every action re-checks super_admin on the server: actions are public endpoints.

async function inviteUrl(token: string): Promise<string> {
  const configured = process.env.APP_URL?.replace(/\/+$/, "");
  if (configured) return `${configured}/invite/${token}`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/invite/${token}`;
}

export type CreateAccountState =
  | { status: "idle" }
  | { status: "error"; errors: FieldErrors; values: Record<string, string | string[]> }
  | { status: "created"; accountId: string; link: InviteLink };

/** What the one-time invite-link panel shows. */
export type InviteLink = { name: string | null; email: string; expiresAt: string; url: string };

export async function createAccountAction(_prev: CreateAccountState, form: FormData): Promise<CreateAccountState> {
  const me = await requireSuperAdmin();
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).filter((v): v is string => typeof v === "string");
    raw[key] = key === "languages" ? all : (all[0] ?? "");
  }
  const parsed = parseCreateAccount(raw);
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values: raw };
  const { account, invite, inviteToken } = await createAccount(appDb, { userId: me.id, actingAs: false }, parsed.value, new Date(), { homeMarket: true });
  revalidatePath("/sadmin/accounts");
  return {
    status: "created",
    accountId: account.id,
    link: { name: invite.inviteeName, email: invite.email, expiresAt: invite.expiresAt.toISOString(), url: await inviteUrl(inviteToken) },
  };
}

export type InviteState = { status: "idle" } | { status: "error"; message: string } | { status: "created"; link: InviteLink };

export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const me = await requireSuperAdmin();
  const accountId = String(form.get("accountId") ?? "");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim() || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: "error", message: "Enter a valid email address." };
  if (!isUuid(accountId)) notFound();
  const account = await getAccountById(appDb, accountId);
  if (!account) notFound();
  const { invite, token } = await createInvite(appDb, { userId: me.id, actingAs: false }, account.id, { email, name });
  revalidatePath(`/sadmin/accounts/${account.id}`);
  return { status: "created", link: { name, email, expiresAt: invite.expiresAt.toISOString(), url: await inviteUrl(token) } };
}

/** "Create new link": cancels the pending invite and shows a fresh link once. */
export async function renewInviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const me = await requireSuperAdmin();
  const accountId = String(form.get("accountId") ?? "");
  const inviteId = String(form.get("inviteId") ?? "");
  if (!isUuid(accountId) || !isUuid(inviteId)) return { status: "error", message: "This invite was already used or cancelled. Reload the page." };
  const renewed = await renewInvite(appDb, { userId: me.id, actingAs: false }, accountId, inviteId);
  if (!renewed) return { status: "error", message: "This invite was already used or cancelled. Reload the page." };
  revalidatePath(`/sadmin/accounts/${accountId}`);
  const { invite, token } = renewed;
  return { status: "created", link: { name: invite.inviteeName, email: invite.email, expiresAt: invite.expiresAt.toISOString(), url: await inviteUrl(token) } };
}

export async function pauseAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const id = String(form.get("accountId") ?? "");
  if (!isUuid(id)) notFound();
  const row = await pauseAccount(appDb, { userId: me.id, actingAs: true }, id);
  revalidatePath(`/sadmin/accounts/${id}`);
  if (row) revalidatePath(`/app/${row.slug}`, "layout");
}

export async function resumeAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const id = String(form.get("accountId") ?? "");
  if (!isUuid(id)) notFound();
  const row = await resumeAccount(appDb, { userId: me.id, actingAs: true }, id);
  revalidatePath(`/sadmin/accounts/${id}`);
  if (row) revalidatePath(`/app/${row.slug}`, "layout");
}

/** Logs the entry, then opens the seller workspace in acting-as mode. */
export async function enterAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const accountId = String(form.get("accountId") ?? "");
  if (!isUuid(accountId)) notFound();
  const account = await getAccountById(appDb, accountId);
  if (!account) notFound();
  await writeAudit(appDb, { userId: me.id, actingAs: true }, {
    accountId: account.id,
    action: "account.entered",
    targetType: "account",
    targetId: account.id,
  });
  redirect(`/app/${account.slug}`);
}

/**
 * "Create demo account": seeds a complete, live Polar Demo account (no AI
 * call) and opens it with a note of what was created. The owner invite goes to
 * the signed-in super admin. Super admin is checked here and again in the seed.
 */
export async function createDemoAccountAction() {
  const me = await requireSuperAdmin();
  let r: Awaited<ReturnType<typeof createDemoAccount>>;
  try {
    // A super admin without an email gets the invite on a reserved .example address (never delivered).
    r = await createDemoAccount(appDb, me, { ownerEmail: me.email ?? "owner@polar-demo.example" });
  } catch (e) {
    // notFound/redirect are not called inside the try, so only seed errors land here.
    console.error("[demo] create failed", e instanceof Error ? e.message : e);
    revalidatePath("/sadmin/accounts");
    redirect("/sadmin/accounts?demo=failed");
  }
  if (!r.ok) notFound();
  const s = r.summary;
  revalidatePath("/sadmin/accounts");
  redirect(`/sadmin/accounts/${s.accountId}?demo=created&items=3&sources=${s.sources}&facts=${s.facts}&leads=${s.leads}`);
}

/** "Delete demo account": only accounts the seed created; they are paused, not hard-deleted. */
export async function removeDemoAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const id = String(form.get("accountId") ?? "");
  if (!isUuid(id)) notFound();
  const r = await removeDemoAccount(appDb, me, id);
  if (!r.ok) notFound();
  const row = await getAccountById(appDb, id);
  revalidatePath("/sadmin/accounts");
  revalidatePath(`/sadmin/accounts/${id}`);
  if (row) revalidatePath(`/app/${row.slug}`, "layout");
  redirect(`/sadmin/accounts/${id}?demo=removed`);
}
