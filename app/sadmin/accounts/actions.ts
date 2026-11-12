"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { parseCreateAccount, type FieldErrors } from "@/lib/accounts/rules";
import { createAccount, createInvite, getAccountById, pauseAccount, resumeAccount } from "@/lib/accounts/service";

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
  | { status: "created"; accountId: string; tradeName: string; ownerEmail: string; inviteUrl: string };

export async function createAccountAction(_prev: CreateAccountState, form: FormData): Promise<CreateAccountState> {
  const me = await requireSuperAdmin();
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).filter((v): v is string => typeof v === "string");
    raw[key] = key === "languages" ? all : (all[0] ?? "");
  }
  const parsed = parseCreateAccount(raw);
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values: raw };
  const { account, inviteToken } = await createAccount(appDb, { userId: me.id, actingAs: false }, parsed.value);
  revalidatePath("/sadmin/accounts");
  return {
    status: "created",
    accountId: account.id,
    tradeName: account.tradeName,
    ownerEmail: parsed.value.ownerEmail,
    inviteUrl: await inviteUrl(inviteToken),
  };
}

export type InviteState = { status: "idle" } | { status: "error"; message: string } | { status: "created"; email: string; inviteUrl: string };

export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const me = await requireSuperAdmin();
  const accountId = String(form.get("accountId") ?? "");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: "error", message: "Enter a valid email address." };
  const account = await getAccountById(appDb, accountId);
  if (!account) notFound();
  const { token } = await createInvite(appDb, { userId: me.id, actingAs: false }, account.id, { email });
  revalidatePath(`/sadmin/accounts/${account.id}`);
  return { status: "created", email, inviteUrl: await inviteUrl(token) };
}

export async function pauseAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const id = String(form.get("accountId") ?? "");
  await pauseAccount(appDb, { userId: me.id, actingAs: true }, id);
  revalidatePath(`/sadmin/accounts/${id}`);
}

export async function resumeAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const id = String(form.get("accountId") ?? "");
  await resumeAccount(appDb, { userId: me.id, actingAs: true }, id);
  revalidatePath(`/sadmin/accounts/${id}`);
}

/** Logs the entry, then opens the seller workspace in acting-as mode. */
export async function enterAccountAction(form: FormData) {
  const me = await requireSuperAdmin();
  const account = await getAccountById(appDb, String(form.get("accountId") ?? ""));
  if (!account) notFound();
  await writeAudit(appDb, { userId: me.id, actingAs: true }, {
    accountId: account.id,
    action: "account.entered",
    targetType: "account",
    targetId: account.id,
  });
  redirect(`/app/${account.slug}`);
}
