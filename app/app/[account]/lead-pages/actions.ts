"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { readOpener } from "@/lib/agent/core/opener";
import { currentPlaybook } from "@/lib/agent/service";
import {
  addLeadPageOrigin, archiveLeadPage, createLeadPage, deleteLeadPage, getLeadPage, unarchiveLeadPage, removeLeadPageOrigin, goLiveLeadPage, issuePreviewLink, pauseLeadPage, removeLeadPageBanner, resumeLeadPage, saveLeadPageBanner, updateLeadPage,
} from "@/lib/lead-pages/service";
import { EXTRA_ORIGINS_MAX } from "@/lib/lead-pages/rules";
import { rawFromForm } from "@/lib/lead-pages/view";
import { fileStore } from "@/lib/sources/blob";

// Server actions are public endpoints: each one re-checks access with
// requireAccount() and passes only that account's id to the lead page
// services, which look every page up inside the account. Every change is
// audited by the service (lib/lead-pages/service.ts).

/**
 * What a refused save sends back: the field errors, the connection that was chosen and whether
 * a banner file came with it (nothing is uploaded until the rest is valid). With JS the form stays
 * mounted and keeps everything; after a fresh page (sent before the script ran) the form re-checks
 * the connection and asks for the image again.
 */
export type LeadPageFormState = { errors: Record<string, string>; connection?: string; bannerSent?: boolean } | null;

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
  if (!r.ok) {
    const file = form.get("banner");
    return {
      errors: Object.fromEntries(Object.entries(r.errors).filter((e): e is [string, string] => typeof e[1] === "string")),
      connection: str(form, "connection") || undefined,
      bannerSent: !!file && typeof file !== "string" && file.size > 0,
    };
  }
  const page = r.page;
  const at = `${base(account.slug)}/${page.id}`;
  // The first save of a new page lands on its link / snippet / form address, marked once (?created=1).
  const created = existing ? "" : "&created=1";
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
    if (!g.ok) redirect(g.reason === "blocked" ? `${at}?blocked=${g.blockers.join(",")}${created}` : g.reason === "archived" ? `${at}?way_error=archived` : base(account.slug));
    redirect(`${at}?saved=live${created}${created ? "#link" : ""}`);
  }
  redirect(existing ? `${at}?saved=saved` : `${at}?saved=draft${created}#link`);
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
  // A refusal always lands on the page view, where the reasons and their fixes are shown.
  if (!r.ok) redirect(r.reason === "blocked" ? `${at}?blocked=${r.blockers.join(",")}` : r.reason === "archived" ? `${at}?way_error=archived` : base(account.slug));
  // From a list row's ⋯ menu: back on the list.
  if (str(form, "back") === "list") redirect(landing(form, account.slug, page.id, `done=${op === "pause" ? "paused" : "live"}`));
  redirect(`${at}?saved=${op === "pause" ? "paused" : "live"}`);
}

/** A 24-hour preview link of the form ("Check before going live"); its test leads are left out of the numbers. Audited. */
export async function previewLinkAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  const link = await issuePreviewLink(appDb, actorOf(access), account.id, page.id);
  // No preview link for an archived page: it takes no sends at all.
  if (!link) redirect(`${base(account.slug)}/${page.id}?way_error=archived`);
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
  // Each refusal says why, next to the Add field (the page view's "Other addresses").
  if (!host) redirect(`${at}?origin_error=1#link`);
  if (page.extraOrigins.length >= EXTRA_ORIGINS_MAX) redirect(`${at}?origin_error=max#link`);
  const r = await addLeadPageOrigin(appDb, actorOf(access), account, page.id, host);
  revalidatePath(base(account.slug));
  if (r.ok) redirect(`${at}?saved=origin_added#link`);
  // The new address itself, or the page's other settings (then saving the page through Edit shows which).
  redirect(`${at}?origin_error=${"extraOrigins" in r.errors ? "1" : "page"}#link`);
}

/** Removes one other address (audited as lead_page.origins_changed). */
export async function removeOriginAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const page = await getLeadPage(appDb, account.id, str(form, "pageId"));
  if (!page) redirect(base(account.slug));
  const r = await removeLeadPageOrigin(appDb, actorOf(access), account, page.id, str(form, "host"));
  revalidatePath(base(account.slug));
  // Not "Address removed." when it was not: the reason shows next to the list.
  redirect(`${base(account.slug)}/${page.id}?${r.ok ? "saved=origin_removed" : "origin_error=page"}#link`);
}

/** Where a list-row or page-view action lands: back on the list (keeping "Show archived") or on the page. */
function landing(form: FormData, slug: string, pageId: string, query: string): string {
  if (str(form, "back") !== "list") return `${base(slug)}/${pageId}?${query}`;
  const archived = str(form, "archived") === "1" ? "archived=1&" : "";
  return `${base(slug)}?${archived}${query}`;
}

/**
 * Delete a page from the confirm step. The server decides again whether Delete applies (no
 * real submissions): a page that got a lead meanwhile is kept and the seller is told to
 * archive it. Test submissions go with the page; test leads stay in Leads. Audited.
 */
export async function deleteLeadPageAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const pageId = str(form, "pageId");
  const r = await deleteLeadPage(appDb, actorOf(access), account.id, pageId, fileStore());
  revalidatePath(base(account.slug));
  if (r.ok) redirect(`${base(account.slug)}?done=deleted`);
  if (r.reason === "not_found") redirect(base(account.slug));
  redirect(landing(form, account.slug, pageId, `way_error=${r.reason}`));
}

/** Archive a page with real submissions (the server re-checks that it has them). Audited. */
export async function archiveLeadPageAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const pageId = str(form, "pageId");
  const r = await archiveLeadPage(appDb, actorOf(access), account.id, pageId);
  revalidatePath(base(account.slug));
  if (!r.ok && r.reason === "not_found") redirect(base(account.slug));
  redirect(landing(form, account.slug, pageId, r.ok ? "done=archived" : `way_error=${r.reason}`));
}

/** Unarchive: the page comes back paused, never live. Audited. */
export async function unarchiveLeadPageAction(form: FormData) {
  const access = await requireAccount(str(form, "slug"));
  const { account } = access;
  const pageId = str(form, "pageId");
  const r = await unarchiveLeadPage(appDb, actorOf(access), account.id, pageId);
  revalidatePath(base(account.slug));
  if (!r.ok && r.reason === "not_found") redirect(base(account.slug));
  redirect(landing(form, account.slug, pageId, r.ok ? "done=unarchived" : `way_error=${r.reason}`));
}
