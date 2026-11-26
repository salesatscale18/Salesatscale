/**
 * Preview runs (owner rule 26 Nov): what "Open" and "Start over" open, and the "Start over" link
 * inside a preview run (the preview form, its hand-over and its conversation).
 *
 * - "Open": the preview link as before. A send with the number of this page's latest preview run
 *   continues that run (lib/lead-pages/intake.ts).
 * - "Start over": the same link with `fresh` (hosted form: `&fresh=1`; the snippet on the seller's
 *   page: `&sas-fresh=1` in the fragment): the form opens empty and its send makes a NEW preview run
 *   (a new test lead and a new conversation with the opener), even with the same number.
 * - The seller's own form has no "Start over": its test code is a fixed hidden field on their form.
 *
 * The link inside a run is decided on the server from the run (a preview submission on a preview-run
 * lead): it is never rendered for a real buyer. It carries a new preview token (24 hours), so a run
 * opened from an older link can still start over.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadPages, leadPageSubmissions, type LeadPage } from "@/db/schema";
import { isPreviewRunLead } from "@/lib/leads/unverified";
import { isArchived } from "./archive";
import { previewTokenFor } from "./tokens";
import { snippetPreviewUrl } from "./view";

type PageLink = Pick<LeadPage, "publicKey" | "connection" | "address">;

/** The hosted form's query flag and the snippet's fragment flag of "Start over". */
export const FRESH_PARAM = "fresh";
export const SNIPPET_FRESH = "sas-fresh=1";

/**
 * Where the preview opens: the seller's page with the token in the fragment (snippet with an address),
 * else the hosted form (`base` = the app's address, or "" for a same-site path). Null for the seller's own form.
 */
export function previewFormUrl(page: PageLink, token: string, opts: { fresh?: boolean; base?: string } = {}): string | null {
  if (page.connection === "own_form") return null;
  if (page.connection === "snippet" && page.address) {
    return `${snippetPreviewUrl(page.address, token)}${opts.fresh ? `&${SNIPPET_FRESH}` : ""}`;
  }
  return `${opts.base ?? ""}/p/${page.publicKey}?preview=${encodeURIComponent(token)}${opts.fresh ? `&${FRESH_PARAM}=1` : ""}`;
}

/** "Start over" from inside a run: the empty preview form again (a new token), or null (own form, archived page). */
export function startOverUrl(page: PageLink & Pick<LeadPage, "id" | "options">, now: Date, base = ""): string | null {
  if (isArchived(page)) return null;
  return previewFormUrl(page, previewTokenFor(page.id, now), { fresh: true, base });
}

/**
 * "Start over" for a lead's conversation: only for a preview-run lead, from the page of its latest
 * preview submission (sent through our form or the snippet). Account-scoped. Null for every real lead.
 */
export async function startOverForLead(db: Db, accountId: string, lead: { id: string; phone: string }, now: Date, base = ""): Promise<string | null> {
  if (!isPreviewRunLead(lead)) return null;
  const [row] = await db.select({ page: leadPages, via: leadPageSubmissions.via }).from(leadPageSubmissions)
    .innerJoin(leadPages, and(eq(leadPages.id, leadPageSubmissions.pageId), eq(leadPages.accountId, leadPageSubmissions.accountId)))
    .where(and(eq(leadPageSubmissions.accountId, accountId), eq(leadPageSubmissions.leadId, lead.id), eq(leadPageSubmissions.preview, true)))
    .orderBy(desc(leadPageSubmissions.createdAt)).limit(1);
  if (!row || row.via === "own_form") return null;
  return startOverUrl(row.page, now, base);
}
