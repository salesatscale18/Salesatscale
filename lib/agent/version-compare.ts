/**
 * Compare versions (Versions and test lab › Compare): loads the two versions and
 * their stored scenario results for one account, then compares them with the pure
 * lib/agent/version-diff.ts. Read-only: no writes, no model calls. Scenario
 * results are the test lab's own (latestScenarioResults: the latest test chat
 * per scenario on a version, checked by the deterministic scenario check).
 */
import type { Db } from "@/db/types";
import type { AgentVersion } from "@/db/schema";
import { realtimeUsdPerMinute } from "@/lib/ai/models";
import { versionModelId } from "@/lib/voice/settings";
import { SCENARIOS, type Scenario } from "./scenarios";
import { latestScenarioResults, scenarioTable } from "./scenario-results";
import { listVersions } from "./service";
import { diffVersions, orderScenarios, type ChangeRow, type ScenarioChange, type ScenarioOutcome } from "./version-diff";

export type CompareScenarioRow = {
  scenario: Scenario;
  before: ScenarioOutcome;
  after: ScenarioOutcome;
  change: ScenarioChange;
  beforeChat: string | null;
  afterChat: string | null;
};

export type VersionComparison = {
  versions: AgentVersion[];
  before: AgentVersion;
  after: AgentVersion;
  changes: ChangeRow[];
  scenarios: CompareScenarioRow[];
};

/**
 * The two versions to compare: the ids asked for when they belong to the account,
 * else the defaults: live on the left, the draft on the right (or the two newest).
 */
export function pickVersions<V extends { id: string; status: string }>(versions: readonly V[], a?: string, b?: string): { before: V; after: V } | null {
  if (versions.length === 0) return null;
  const byId = (id?: string) => (id ? versions.find((v) => v.id === id) : undefined);
  const after = byId(b) ?? versions.find((v) => v.status === "draft") ?? versions[0];
  const live = versions.find((v) => v.status === "live");
  const before = byId(a) ?? (live && live.id !== after.id ? live : versions.find((v) => v.id !== after.id)) ?? after;
  return { before, after };
}

/** The voice cost per minute of `to` against `from`, from the price table; null without prices. */
export function voiceCostRatio(from: string, to: string): number | null {
  const a = realtimeUsdPerMinute(from);
  const b = realtimeUsdPerMinute(to);
  return a === null || b === null || a <= 0 ? null : b / a;
}

/** Null when the account has no versions yet. `languages`: the account's buyer languages (the scenarios shown). */
export async function loadVersionComparison(
  db: Db, accountId: string, opts: { a?: string; b?: string; languages: readonly string[]; platformDetails: boolean },
): Promise<VersionComparison | null> {
  const versions = await listVersions(db, accountId);
  const pick = pickVersions(versions, opts.a, opts.b);
  if (!pick) return null;
  const { before, after } = pick;
  const [ra, rb] = await Promise.all([latestScenarioResults(db, accountId, before.id), latestScenarioResults(db, accountId, after.id)]);
  const scenarios = SCENARIOS.filter((s) => opts.languages.includes(s.language));
  const ta = scenarioTable(scenarios, ra).rows;
  const tb = scenarioTable(scenarios, rb).rows;
  const rows = orderScenarios(scenarios.map((scenario, i) => ({
    scenario, before: ta[i].result, after: tb[i].result, beforeChat: ta[i].conversationId, afterChat: tb[i].conversationId,
  })));
  const changes = diffVersions(before, after, {
    platformDetails: opts.platformDetails,
    voiceModel: { before: versionModelId(before.voiceSettings), after: versionModelId(after.voiceSettings) },
    voiceCostRatio,
  });
  return { versions, before, after, changes, scenarios: rows };
}

/** How many changes `after` holds against `before` (the Versions list's "{n} changes from live"). */
export function countChanges(before: AgentVersion, after: AgentVersion, platformDetails: boolean): number {
  return diffVersions(before, after, {
    platformDetails,
    voiceModel: { before: versionModelId(before.voiceSettings), after: versionModelId(after.voiceSettings) },
  }).length;
}
