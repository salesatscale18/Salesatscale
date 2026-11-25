/**
 * Archived lead pages (no schema change): `options.archivedAt` (ISO time) and
 * `options.archivedBy` (user id) in the page's existing jsonb. An archived page
 * is stored as paused, so every public path refuses sends as for a paused page;
 * on top of that its snippet config is not served and preview links do not work.
 * "Archived" is a display state only: the status enum stays draft/live/paused.
 * Pure: safe anywhere.
 */
import type { LeadPage } from "@/db/schema";
import type { LeadPageStatus } from "./rules";

export type LeadPageDisplayState = LeadPageStatus | "archived";

type WithOptions = { options?: Record<string, unknown> | null };

/** When the page was archived, or null. */
export function archivedAtOf(page: WithOptions): string | null {
  const v = page.options?.archivedAt;
  return typeof v === "string" && v ? v : null;
}

export const isArchived = (page: WithOptions): boolean => archivedAtOf(page) !== null;

/** The pill's state: "archived" over the stored status. */
export const displayStateOf = (page: Pick<LeadPage, "status"> & WithOptions): LeadPageDisplayState => (isArchived(page) ? "archived" : page.status);

/** The page's options with the archive marks set. */
export const archivedOptions = (options: Record<string, unknown> | null | undefined, at: Date, by: string | null): Record<string, unknown> =>
  ({ ...(options ?? {}), archivedAt: at.toISOString(), archivedBy: by });

/** The page's options without the archive marks. */
export function unarchivedOptions(options: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const rest = { ...(options ?? {}) };
  delete rest.archivedAt;
  delete rest.archivedBy;
  return rest;
}

export type SubmissionCounts = { real: number; test: number; testLeads: number };

/** Which way out applies: a page with real (non-preview) submissions is archived; any other page can be deleted. */
export const wayOut = (counts: Pick<SubmissionCounts, "real">): "delete" | "archive" => (counts.real > 0 ? "archive" : "delete");
