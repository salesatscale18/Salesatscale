/**
 * What every Playbook view reads (home, each part, Sales plays): the draft
 * (created from live when missing), the live version, the draft bar's change
 * count and the part lines. Server only; scoped by the account.
 */
import { actorOf, appDb } from "@/lib/auth/account";
import type { AccountAccess } from "@/lib/accounts/service";
import { seesPlatformDetails } from "@/lib/auth/display";
import { agentNameLanguages, autoNameModel, refreshAgentNameAuto } from "@/lib/agent/names-auto";
import { ensureDraftVersion, liveVersion } from "@/lib/agent/service";
import { countChanges } from "@/lib/agent/version-compare";
import { pendingPlaySuggestions } from "@/lib/pipeline/service";
import { setupProgress } from "@/lib/overview/setup";
import type { AgentVersion } from "@/db/schema";
import type { Db } from "@/db/types";
import { partHref, PLAYBOOK_PARTS, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { partLines, type PartLine } from "./summaries";
import { playsOverview, playsSummary, type PlayOverview, type PlaysSummary } from "./plays/overview";

export type DraftBarData = {
  slug: string;
  draftVersion: number;
  live: { version: number } | null;
  /** Unpublished changes: the number of rows Compare with live lists (null when nothing is live). */
  changes: number | null;
  compareHref: string | null;
};

/**
 * The draft bar's count: exactly the rows Compare versions shows for live → draft
 * (the same diffVersions call, with the same platform-details rule as the test lab).
 */
export function draftChangeCount(live: AgentVersion | null, draft: AgentVersion, platformDetails: boolean): number | null {
  return live ? countChanges(live, draft, platformDetails) : null;
}

/** The draft bar for this draft and live version (Playbook pages and the draft from sources). */
export function draftBarOf(access: AccountAccess, draft: AgentVersion, live: AgentVersion | null): DraftBarData {
  const lab = `/app/${access.account.slug}/setup/test-lab`;
  return {
    slug: access.account.slug, draftVersion: draft.version, live: live ? { version: live.version } : null,
    changes: draftChangeCount(live, draft, seesPlatformDetails(access)),
    compareHref: live ? `${lab}/compare?a=${live.id}&b=${draft.id}` : null,
  };
}

export type PlaybookData = {
  base: string;
  home: string;
  lab: string;
  draft: AgentVersion;
  live: AgentVersion | null;
  progress: ReadonlySet<string>;
  plays: PlayOverview[];
  playsSummary: PlaysSummary;
  lines: Record<PlaybookPart, PartLine>;
  hrefs: Record<PlaybookPart, string>;
  bar: DraftBarData;
  /** The market languages of the agent's name (for its "Names in other languages" rows). */
  nameLanguages: string[];
};

export async function loadPlaybook(access: AccountAccess, db: Db = appDb): Promise<PlaybookData> {
  const { account } = access;
  const [first, live, progress, pending] = await Promise.all([
    ensureDraftVersion(db, account.id), liveVersion(db, account.id), setupProgress(db, account), pendingPlaySuggestions(db, account.id),
  ]);
  // Automatic name versions (C2): made once when the name or the market languages changed; a view only
  // fills languages never tried for this name (a failed try is retried on save, not on every view).
  const refreshed = await refreshAgentNameAuto(db, account.id, autoNameModel(), { actor: actorOf(access) });
  const draft: AgentVersion = { ...first, playbook: refreshed.playbook };
  const nameLanguages = await agentNameLanguages(db, account.id, draft.playbook.agentName);
  const base = `/app/${account.slug}`;
  const home = `${base}/setup/playbook`;
  const lab = `${base}/setup/test-lab`;
  const plays = playsOverview(draft.playbook, pending);
  const summary = playsSummary(plays);
  return {
    base, home, lab, draft, live, progress, plays, playsSummary: summary, nameLanguages,
    lines: partLines(draft.playbook, { plays: summary }),
    hrefs: Object.fromEntries(PLAYBOOK_PARTS.map((p) => [p, partHref(home, p)])) as Record<PlaybookPart, string>,
    bar: draftBarOf(access, draft, live),
  };
}
