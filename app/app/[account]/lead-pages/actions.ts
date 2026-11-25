"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { readOpener } from "@/lib/agent/core/opener";
import { currentPlaybook } from "@/lib/agent/service";
import {
  addLeadPageOrigin, createLeadPage, getLeadPage, removeLeadPageOrigin, goLiveLeadPage, issuePreviewLink, pauseLeadPage, removeLeadPageBanner, resumeLeadPage, saveLeadPageBanner, updateLeadPage,
} from "@/lib/lead-pages/service";
import { rawFromForm } from "@/lib/lead-pages/view";
import { fileStore } from "@/lib/sources/blob";

// Server actions are public endpoints: each one re-checks access with
// requireAccount() and passes only that account's id to the lead page
// services, which look every page up inside the account. Every change is
// audited by the service (lib/lead-pages/service.ts).

export type LeadPageFormState = { errors: Record<string, string> } | null;

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const base = (slug: string) => `/app/${slug}/lead-pages`;

async function bannerBytes(f: FormData): Promise<Uint8Array | null> {
  const v = f.get("banner");
  if (!v || typeof v === "string" || v.size === 0) return null;
  return new Uint8Array(await v.arrayBuffer());
}

/**
 * Add or edit a page (the add/edit form): saves the settings, then the banner
 * when one was chosen, then goes live when the seller pressed "Go live".
 * Field errors come back to the form; a refused banner or go-live lands on the
 * page with the reason.
 */
export async function saveLeadPageAction(_prev: LeadPageFormState, form: FormData): Promise<LeadPageFormState> {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const actor = actorOf(access);
  const pageId = str(form, "pageId");
  const existing = pageId ? await getLeadPage(appDb, account.id, pageId) : null;
  if (pageId && !existing) return { errors: { form: "This page no longer exists." } };
  const intent = str(form, "intent");

  if (intent === "remove_banner" && existing) {
    await removeLeadPageBanner(appDb, actor, account.id, existing.id, fileStore());
    revalidatePath(base(account.slug));
    redirect(`${base(account.slug)}/${existing.id}/edit?saved=banner_removed`);
  }

  const topics = readOpener((await currentPlaybook(appDb, account.id))?.opener).topics;
  const raw = rawFromForm(form, topics, existing);
  const r = existing ? await updateLeadPage(appDb, actor, account, existing.id, raw) : await createLeadPage(appDb, actor, account, raw);
  if (!r.ok) return { errors: Object.fromEntries(Object.entries(r.errors).filter((e): e is [string, string] => typeof e[1] === "string")) };
  const page = r.page;
  const at = `${base(account.slug)}/${page.id}`;
  revalidatePath(base(account.slug));

  const bytes = await bannerBytes(form);
  if (bytes) {
    const b = await saveLeadPageBanner(appDb, actor, account.id, page.id, bytes, fileStore());
    if (!b.ok) redirect(`${at}/edit?banner_error=${b.reason}`);
  }
  if (intent === "preview") {
    // "Save and preview" (the snippet's right column): saved, then a 24-hour preview link on the page view.
    const link = await issuePreviewLink(appDb, actor, account.id, page.id);
    const token = link ? new URL(link.path, "http://x").searchParams.get("preview") ?? "" : "";
    redirect(`${at}?pl=${encodeURIComponent(token)}#link`);
  }
  if (intent === "live" && page.status !== "live") {
    const g = page.status === "paused" ? await resumeLeadPage(appDb, actor, account.id, page.id) : await goLiveLeadPage(appDb, actor, account.id, page.id);
    if (!g.ok) redirect(g.reason === "blocked" ? `${at}?blocked=${g.blockers.join(",")}` : base(account.slug));
    redirect(`${at}?saved=live`);
  }
  redirect(`${at}?saved=${existing ? "saved" : "draft"}`);
}

/** Go live, pause or resume from the page view. */
export async function setLeadPageStatusAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const actor = actorOf(access);
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  const op = str(form, "op");
  const r = op === "pause" ? await pauseLeadPage(appDb, actor, account.id, page.id)
    : op === "resume" ? await resumeLeadPage(appDb, actor, account.id, page.id)
    : op === "live" ? await goLiveLeadPage(appDb, actor, account.id, page.id)
    : null;
  revalidatePath(base(account.slug));
  const at = `${base(account.slug)}/${page.id}`;
  if (!r) redirect(at);
  if (!r.ok) redirect(r.reason === "blocked" ? `${at}?blocked=${r.blockers.join(",")}` : base(account.slug));
  redirect(`${at}?saved=${op === "pause" ? "paused" : "live"}`);
}

/** A 24-hour preview link of the form ("Check before going live"); its test leads are left out of the numbers. Audited. */
export async function previewLinkAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  const link = await issuePreviewLink(appDb, actorOf(access), account.id, page.id);
  if (!link) redirect(base(account.slug));
  const token = new URL(link.path, "http://x").searchParams.get("preview") ?? "";
  redirect(`${base(account.slug)}/${page.id}?pl=${encodeURIComponent(token)}#link`);
}

/**
 * Adds one other address the form may run on (the page view's "Add", or "Seen on …, add it?").
 * The same validation as the edit form; audited as lead_page.origins_changed.
 */
export async function addOriginAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  const at = `${base(account.slug)}/${page.id}`;
  const host = str(form, "host");
  if (!host) redirect(`${at}#link`);
  const r = await addLeadPageOrigin(appDb, actorOf(access), account, page.id, host);
  revalidatePath(base(account.slug));
  redirect(r.ok ? `${at}?saved=origin_added#link` : `${at}?origin_error=1#link`);
}

/** Removes one other address (audited as lead_page.origins_changed). */
export async function removeOriginAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  await removeLeadPageOrigin(appDb, actorOf(access), account, page.id, str(form, "host"));
  revalidatePath(base(account.slug));
  redirect(`${base(account.slug)}/${page.id}?saved=origin_removed#link`);
}
