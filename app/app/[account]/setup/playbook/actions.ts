"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import type { PlaybookErrors, PlaybookRowsInput } from "@/lib/agent/playbook";
import { ENTRY_PARTS, readPlaybookChange, savePlaybookChange, type EntryPart } from "@/lib/agent/playbook-save";
import { autoNameModel } from "@/lib/agent/names-auto";
import { cookies } from "next/headers";
import { HANDOFF_NOTICE_COOKIE, HANDOFF_NOTICE_MAX_AGE, withDismissed } from "@/lib/agent/handoff-notice";

const playbookPath = (slug: string) => `/app/${slug}/setup/playbook`;

/**
 * Dismisses the Limits notice on unknown questions (O1) for this user: their id
 * goes into the notice cookie, so it stays hidden in this browser. The playbook
 * is not saved: this action only reads the account slug.
 */
export async function dismissHandoffNoticeAction(form: FormData): Promise<void> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const jar = await cookies();
  jar.set(HANDOFF_NOTICE_COOKIE, withDismissed(jar.get(HANDOFF_NOTICE_COOKIE)?.value, a.user.id), {
    path: "/", maxAge: HANDOFF_NOTICE_MAX_AGE, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production",
  });
  revalidatePath(playbookPath(a.account.slug), "layout");
  redirect(`${playbookPath(a.account.slug)}/limits`);
}

/** A row's save: done, or refused with the errors keyed by input name (any part of the playbook). */
export type RowSaveResult = { ok: true } | { ok: false; errors: PlaybookErrors };

/**
 * Saves ONE change from a part's row (read first, edit one row) into the
 * draft. Every rule is checked on the server (savePlaybookChange re-checks the
 * whole playbook), with the same audit as the editor's save.
 */
export async function savePlaybookRowAction(slug: string, raw: unknown): Promise<RowSaveResult> {
  const a = await requireAccount(String(slug ?? ""));
  const change = readPlaybookChange(raw);
  if (!change) return { ok: false, errors: { form: "This change could not be read. Reload the page and try again." } };
  // Automatic name versions are made here, once, when the name or the market languages changed (C2).
  const r = await savePlaybookChange(appDb, a.account.id, change, { names: autoNameModel(), actor: actorOf(a) });
  if (!r.ok) return { ok: false, errors: r.errors };
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved" });
  revalidatePath(playbookPath(a.account.slug), "layout");
  return { ok: true };
}

/**
 * On a refused save the submitted values come back, so the part's editor shows
 * what the seller typed (React resets uncontrolled inputs to their
 * defaultValue after an action; without this, edits were lost).
 */
export type PlaybookFormState = { status: "idle" } | { status: "error"; errors: PlaybookErrors; values: PlaybookRowsInput };

/** The part view each whole-editor part returns to. */
const PART_VIEW: Record<EntryPart, string> = { name: "agent", opening: "opening", asks: "asks", objections: "objections", after: "after" };

/**
 * Saves a part's whole editor (Opening, What it asks, Objections, After the
 * order: their inputs as in the one-page form) into the draft. The rest of the
 * playbook stays as stored; every rule is checked on the server.
 */
export async function savePlaybookPartAction(_prev: PlaybookFormState, form: FormData): Promise<PlaybookFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const part = String(form.get("part") ?? "");
  if (!(ENTRY_PARTS as readonly string[]).includes(part)) redirect(playbookPath(a.account.slug));
  const entries = [...form.entries()].filter(([k]) => k !== "slug" && k !== "part" && !k.startsWith("$")).map(([k, v]) => [k, typeof v === "string" ? v : ""] as [string, string]);
  const r = await savePlaybookChange(appDb, a.account.id, { kind: "part", part: part as EntryPart, entries }, { names: autoNameModel(), actor: actorOf(a) });
  if (!r.ok) return { status: "error", errors: r.errors, values: r.values ?? ({} as PlaybookRowsInput) };
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved" });
  revalidatePath(playbookPath(a.account.slug), "layout");
  redirect(`${playbookPath(a.account.slug)}/${PART_VIEW[part as EntryPart]}?saved=1`);
}
