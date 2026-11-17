/**
 * The knowledge -> playbook pipeline (mvp-plan 3.14, P8.4): plan (stage 0,
 * no AI), then stage 1 (facts) and stage 2 (playbook suggestions), each a
 * `pipeline_runs` row with its token usage and estimated cost. Every function
 * takes `accountId` and only touches that account's rows.
 *
 * Where results live (no new tables; see the lane report):
 * - facts: `knowledge_facts` (status suggested, with source id and locator);
 * - playbook items: `playbook_suggestions`;
 * - contradictions, gaps, "about" lines and statements kept back because they
 *   are about one customer: in the facts run's `usage` jsonb, under `result`
 *   (the token counts stay at the top level, where the usage roll-up reads them).
 *
 * Model calls go through a PipelineLlm wrapped in budgetGuarded. Tests pass
 * ScriptedPipelineLlm; nothing here calls the real API by itself.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  agentVersions, catalogVersions, knowledgeFacts, markets, pipelineRuns, playbookSuggestions, sellerAccounts, sourceSections, sources,
  type PipelineRun, type Playbook, type PlaybookSuggestion,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { answeredQuestionKey, normalizeQuestion, QUESTION_PREFIX } from "@/lib/agent/knowledge";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { defaultPlaybook, parsePlayCard } from "@/lib/agent/playbook";
import { ensureDraft, entriesOf, listPriceLists, setEntry } from "@/lib/pricing/price-lists";
import { applyLimitToPlaybook, effectiveSetting, limitPreview, type LimitContext, type LimitPreview } from "./limits";
import { itemsOf, setDraftItemTexts } from "@/lib/catalog/service";
import { estimateCostMicros, modelFor } from "@/lib/ai/models";
import { AiBudgetError, budgetGuarded, spendState } from "@/lib/ai/usage";
import { isUuid } from "@/lib/security/ids";
import {
  assembleCorpus, estimateAnalysis, inputHash, LARGE_CORPUS_TOKENS, sourceChunks, tokensOf, trimCorpus,
  type AnalysisEstimate, type CorpusSource,
} from "./corpus";
import type { PipelineLlm, PipelineRequest, PipelineUsage } from "./llm";
import { mergeSuggestions } from "./merge";
import { FACTS_INSTRUCTION, FACTS_ONE_SOURCE_INSTRUCTION, PROMPT_VERSION as FACTS_VERSION } from "./prompts/facts";
import { playbookInstruction, PROMPT_VERSION as PLAYBOOK_VERSION, type PlaybookStageData } from "./prompts/playbook";
import { FACTS_TOOL, PLAYBOOK_TOOL, PROMPT_VERSION as SYSTEM_VERSION } from "./prompts/system";
import {
  limitSetting, normalizeStatement, parseFactsOutput, parsePlaybookOutput,
  type CatalogItemPayload, type CleanFact, type CorpusIndex, type CustomerNote, type FactsResult, type Gap, type LimitPayload, type SourceAbout,
  type SuggestionKind, type SuggestionPayload,
} from "./validate";

/** Sources that go into the corpus: read, with text (a partly failed source still has usable text). */
export const CORPUS_STATUSES = ["ready", "partly_failed"] as const;
/** A run still queued or running after this long stopped (the function ended): shown as failed. */
export const STALE_RUN_MS = 15 * 60 * 1000;
/** Max output per call: streamed, so large is fine. */
const MAX_TOKENS = 32_000;
const EFFORT = "medium" as const;
const LIGHT_EFFORT = "low" as const;

// ---------------------------------------------------------------------------
// Run data stored in pipeline_runs.usage
// ---------------------------------------------------------------------------

export type ContradictionRecord = { topic: string; summary: string; factIds: string[] };
export type FactsRunResult = {
  factsAdded: number;
  contradictions: ContradictionRecord[];
  gaps: Gap[];
  sourceAbout: SourceAbout[];
  customerSpecific: CustomerNote[];
  dropped: FactsResult["dropped"];
};
export type PlaybookRunResult = { suggestions: number; dropped: number; callsInCorpus: number };

/** pipeline_runs.usage: token counts at the top level (the usage roll-up reads them), results under `result`. */
export type RunData = { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number; result?: FactsRunResult | PlaybookRunResult };

export function runData(run: Pick<PipelineRun, "usage">): RunData | null {
  return (run.usage as RunData | null) ?? null;
}

const addUsage = (a: PipelineUsage, b: PipelineUsage): PipelineUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
const noUsage = (): PipelineUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

// ---------------------------------------------------------------------------
// Stage 0: plan (no AI)
// ---------------------------------------------------------------------------

/** The ready sources with their sections, sources by id and sections by position. */
export async function loadCorpusSources(db: Db, accountId: string): Promise<(CorpusSource & { changed: boolean })[]> {
  const rows = await db
    .select({ id: sources.id, kind: sources.kind, title: sources.title, language: sources.language, textHash: sources.textHash })
    .from(sources)
    .where(and(eq(sources.accountId, accountId), inArray(sources.status, [...CORPUS_STATUSES])))
    .orderBy(asc(sources.id));
  if (rows.length === 0) return [];
  const secs = await db
    .select({ sourceId: sourceSections.sourceId, position: sourceSections.position, locator: sourceSections.locator, heading: sourceSections.heading, text: sourceSections.text })
    .from(sourceSections)
    .where(and(eq(sourceSections.accountId, accountId), inArray(sourceSections.sourceId, rows.map((r) => r.id))))
    .orderBy(asc(sourceSections.sourceId), asc(sourceSections.position));
  return rows
    .map((r) => ({
      id: r.id, kind: r.kind, title: r.title, language: r.language, changed: r.textHash === null,
      sections: secs.filter((x) => x.sourceId === r.id).map(({ position, locator, heading, text }) => ({ position, locator, heading, text })),
    }))
    .filter((s) => s.sections.length > 0);
}

export function corpusIndex(list: CorpusSource[]): CorpusIndex {
  return new Map(list.map((s) => [s.id, { kind: s.kind, title: s.title, locators: new Set(s.sections.map((x) => x.locator)) }]));
}

/** The playbook suggestions build on: the draft, else the live version, else none. */
async function workingPlaybook(db: Db, accountId: string): Promise<Playbook | null> {
  const [v] = await db
    .select({ playbook: agentVersions.playbook })
    .from(agentVersions)
    .where(and(eq(agentVersions.accountId, accountId), inArray(agentVersions.status, ["draft", "live"])))
    .orderBy(sql`case when ${agentVersions.status} = 'draft' then 0 else 1 end`)
    .limit(1);
  return v?.playbook ?? null;
}

/** Facts (approved and suggested), catalog summary and playbook: what stage 2 gets after the corpus. */
export async function playbookStageData(db: Db, accountId: string, callsInCorpus: number): Promise<PlaybookStageData> {
  const facts = await db
    .select({ topic: knowledgeFacts.topic, statement: knowledgeFacts.statement, status: knowledgeFacts.status })
    .from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.status, ["approved", "suggested"])))
    .orderBy(asc(knowledgeFacts.topic), asc(knowledgeFacts.statement));
  const [version] = await db
    .select({ id: catalogVersions.id })
    .from(catalogVersions)
    .where(and(eq(catalogVersions.accountId, accountId), inArray(catalogVersions.status, ["published", "draft"])))
    .orderBy(sql`case when ${catalogVersions.status} = 'published' then 0 else 1 end`)
    .limit(1);
  const items = version ? await itemsOf(db, accountId, version.id) : [];
  return {
    facts,
    catalog: items.filter((i) => i.active).map((i) => ({
      sku: i.sku, name: i.name, kind: i.kind ?? "product", unit: i.unit, charge: i.chargeType === "recurring" ? `recurring per ${i.period ?? "month"}` : "one-time",
      plainName: i.plainName, valueLine: i.valueLine,
    })),
    playbook: await workingPlaybook(db, accountId),
    calls: callsInCorpus,
  };
}

const playbookHash = (model: string, corpus: string, data: PlaybookStageData) =>
  inputHash({ versions: [SYSTEM_VERSION, PLAYBOOK_VERSION], model, corpus, data });

async function doneRunWithHash(db: Db, accountId: string, kind: "facts" | "playbook", hash: string) {
  const [r] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.kind, kind), eq(pipelineRuns.status, "done"), eq(pipelineRuns.inputHash, hash)))
    .limit(1);
  return r?.id ?? null;
}

export type AnalysisPlan = {
  sources: (CorpusSource & { changed: boolean })[];
  /** Sources new or changed since their last analysis. */
  changed: number;
  corpus: string;
  corpusTokens: number;
  large: boolean;
  model: string;
  lightModel: string;
  facts: { hash: string; reuse: boolean };
  /** The stage 2 hash with today's facts; recomputed after stage 1 when it runs. */
  playbook: { hash: string; reuse: boolean };
  estimate: AnalysisEstimate;
  /** What the confirm click must echo back: the run starts only if nothing changed since the estimate. */
  token: string;
};

/** Stage 0: corpus, hashes, reuse and the estimate. Null when there is nothing to analyse. */
export async function planAnalysis(db: Db, accountId: string, env: Record<string, string | undefined> = process.env): Promise<AnalysisPlan | null> {
  const list = await loadCorpusSources(db, accountId);
  if (list.length === 0) return null;
  const model = modelFor("pipeline", env);
  const lightModel = modelFor("pipeline_light", env);
  const corpus = assembleCorpus(list);
  const corpusTokens = tokensOf(corpus);
  const large = corpusTokens > LARGE_CORPUS_TOKENS;
  const factsModel = large ? lightModel : model;
  const factsHash = inputHash({ versions: [SYSTEM_VERSION, FACTS_VERSION], model: factsModel, corpus });
  const calls = list.filter((s) => s.kind === "call").length;
  const data = await playbookStageData(db, accountId, calls);
  const stage2Corpus = large ? assembleCorpus(trimCorpus(list)) : corpus;
  const pbHash = playbookHash(model, stage2Corpus, data);
  const factsReuse = !!(await doneRunWithHash(db, accountId, "facts", factsHash));
  const pbReuse = factsReuse && !!(await doneRunWithHash(db, accountId, "playbook", pbHash));
  const estimate = estimateAnalysis({
    corpusTokens,
    chunkTokens: large ? list.flatMap((s) => sourceChunks(s).map(tokensOf)) : undefined,
    trimmedTokens: large ? tokensOf(stage2Corpus) : undefined,
    runFacts: !factsReuse,
    runPlaybook: !pbReuse,
    dataTokens: tokensOf(JSON.stringify(data)),
    model, lightModel,
  });
  return {
    sources: list, changed: list.filter((s) => s.changed).length, corpus, corpusTokens, large, model, lightModel,
    facts: { hash: factsHash, reuse: factsReuse }, playbook: { hash: pbHash, reuse: pbReuse }, estimate,
    token: `${factsHash.slice(0, 16)}${pbHash.slice(0, 16)}`,
  };
}

// ---------------------------------------------------------------------------
// Runs: start, stale, list
// ---------------------------------------------------------------------------

export class PipelineRefused extends Error {
  constructor(public reason: "busy" | "capped" | "nothing" | "changed", message: string) {
    super(message);
    this.name = "PipelineRefused";
  }
}

/** Runs queued or running for too long are marked failed (the function ended). Returns how many. */
export async function failStaleRuns(db: Db, accountId: string, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STALE_RUN_MS);
  const rows = await db.update(pipelineRuns)
    .set({ status: "failed", error: "The run stopped before it finished.", finishedAt: now })
    .where(and(eq(pipelineRuns.accountId, accountId), inArray(pipelineRuns.status, ["queued", "running"]), lt(pipelineRuns.createdAt, before)))
    .returning({ id: pipelineRuns.id });
  return rows.length;
}

export async function activeRun(db: Db, accountId: string, now = new Date()) {
  await failStaleRuns(db, accountId, now);
  const [r] = await db.select().from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), inArray(pipelineRuns.status, ["queued", "running"]))).limit(1);
  return r ?? null;
}

export async function listRuns(db: Db, accountId: string, limit = 6) {
  return db.select().from(pipelineRuns).where(eq(pipelineRuns.accountId, accountId)).orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id)).limit(limit);
}

export type StartedRuns = { factsRunId: string | null; playbookRunId: string | null };

/**
 * Checks and queues a run: refuses when another run is active, when the
 * account's AI spend is capped, or when the sources changed since the
 * estimate the seller confirmed (`token`). Stages whose results are reused get
 * no run row.
 */
export async function startAnalysis(db: Db, accountId: string, plan: AnalysisPlan, opts: { token?: string; now?: Date } = {}): Promise<StartedRuns> {
  if (opts.token !== undefined && opts.token !== plan.token) throw new PipelineRefused("changed", "Your sources changed since the estimate. Check the new estimate.");
  if (await activeRun(db, accountId, opts.now)) throw new PipelineRefused("busy", "An analysis is already running.");
  if ((await spendState(db, accountId, opts.now))?.state === "capped") throw new PipelineRefused("capped", "This month's AI spend cap is reached.");
  const sourceIds = plan.sources.map((s) => s.id);
  const factsRunId = plan.facts.reuse ? null : randomUUID();
  const playbookRunId = plan.playbook.reuse ? null : randomUUID();
  const rows = [
    ...(factsRunId ? [{ id: factsRunId, accountId, kind: "facts" as const, status: "queued" as const, model: plan.large ? plan.lightModel : plan.model, sourceIds, inputHash: plan.facts.hash }] : []),
    // The stage 2 hash is known only after stage 1; set when the stage runs.
    ...(playbookRunId ? [{ id: playbookRunId, accountId, kind: "playbook" as const, status: "queued" as const, model: plan.model, sourceIds, inputHash: plan.facts.reuse ? plan.playbook.hash : null }] : []),
  ];
  if (rows.length) await db.insert(pipelineRuns).values(rows);
  return { factsRunId, playbookRunId };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type AnalysisResult = {
  facts: { reused: boolean; added: number; contradictions: number; gaps: number } | null;
  playbook: { reused: boolean; suggestions: number } | null;
  failed: string | null;
};

const runWhere = (accountId: string, id: string) => and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.id, id));

async function finishRun(db: Db, accountId: string, id: string, model: string, usage: PipelineUsage, calls: number, result: RunData["result"] | undefined, error: string | null) {
  await db.update(pipelineRuns).set({
    status: error ? "failed" : "done",
    error,
    finishedAt: new Date(),
    usage: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, calls, ...(result ? { result } : {}) } as RunData,
    costEstimateMicros: estimateCostMicros(model, usage) ?? null,
  }).where(runWhere(accountId, id));
}

/** Errors of runs stopped by a spend limit (shown as "Stopped at spend cap"). */
export const BUDGET_STOP = "The platform's monthly AI budget is used up.";
export const CAP_STOP = "Stopped: this month's AI spend cap is reached.";

/** The status pill of a run (design system "Analysis run"). */
export function runPillState(r: Pick<PipelineRun, "status" | "error">): "running" | "completed" | "stopped_cap" | "failed" {
  if (r.status === "queued" || r.status === "running") return "running";
  if (r.status === "done") return "completed";
  return r.error === BUDGET_STOP || r.error === CAP_STOP ? "stopped_cap" : "failed";
}

/** Plain words for a failed call. */
function failureText(e: unknown): string {
  if (e instanceof AiBudgetError) return BUDGET_STOP;
  if (e instanceof StageError) return e.message;
  logAiFailure("pipeline", e);
  return "The AI request failed. Try again later.";
}

/**
 * Logs why a model call failed (HTTP status, API error type and message, request id), never
 * the request body or keys, so a failed run can be diagnosed from the runtime logs.
 */
export function logAiFailure(where: string, e: unknown) {
  const err = e as { name?: string; status?: number; message?: string; requestID?: string; request_id?: string; error?: { error?: { type?: string; message?: string }; type?: string } };
  const apiType = err.error?.error?.type ?? err.error?.type;
  console.error(`[${where}] AI request failed`, JSON.stringify({
    name: err.name, status: err.status, type: apiType, requestId: err.requestID ?? err.request_id,
    message: String(err.error?.error?.message ?? err.message ?? e).slice(0, 600),
  }));
}
class StageError extends Error {}

/** One call that must return the named tool. */
async function callTool(llm: PipelineLlm, req: PipelineRequest, tool: string) {
  const res = await llm.create(req);
  if (res.stopReason === "max_tokens") throw Object.assign(new StageError("The answer was too long and was cut off."), { usage: res.usage, model: res.model });
  if (res.stopReason === "refusal") throw Object.assign(new StageError("The model declined this material."), { usage: res.usage, model: res.model });
  if (!res.tool || res.tool.name !== tool) throw Object.assign(new StageError("The model did not return results."), { usage: res.usage, model: res.model });
  return res;
}
const usageOf = (e: unknown): PipelineUsage => ((e as { usage?: PipelineUsage }).usage ?? noUsage());

function mergeFactsResults(parts: FactsResult[]): FactsResult {
  const seen = new Set<string>();
  const out: FactsResult = { facts: [], contradictions: [], gaps: [], sourceAbout: [], customerSpecific: [], dropped: { noEvidence: 0, customerSpecific: 0, pricing: 0, duplicates: 0 } };
  const gapSeen = new Set<string>();
  for (const p of parts) {
    for (const f of p.facts) {
      const k = normalizeStatement(f.statement);
      if (seen.has(k)) { out.dropped.duplicates++; continue; }
      seen.add(k);
      out.facts.push(f);
    }
    out.contradictions.push(...p.contradictions);
    for (const g of p.gaps) if (!gapSeen.has(normalizeStatement(g.question))) { gapSeen.add(normalizeStatement(g.question)); out.gaps.push(g); }
    for (const a of p.sourceAbout) if (!out.sourceAbout.some((x) => x.sourceId === a.sourceId)) out.sourceAbout.push(a);
    out.customerSpecific.push(...p.customerSpecific);
    for (const k of Object.keys(out.dropped) as (keyof FactsResult["dropped"])[]) out.dropped[k] += p.dropped[k];
  }
  out.gaps = out.gaps.slice(0, 10);
  return out;
}

const factLabel = (index: CorpusIndex, f: CleanFact) => {
  const e = f.evidence[0];
  return `${index.get(e.sourceId)?.title ?? "Source"} · ${e.locator}`.slice(0, 200);
};

/** Stores stage 1: new suggested facts (deduplicated against every fact of the account), contradiction sides as facts. */
async function storeFacts(db: Db, accountId: string, index: CorpusIndex, parsed: FactsResult): Promise<FactsRunResult> {
  const existing = await db.select({ id: knowledgeFacts.id, statement: knowledgeFacts.statement }).from(knowledgeFacts).where(eq(knowledgeFacts.accountId, accountId));
  const byStatement = new Map(existing.map((f) => [normalizeStatement(f.statement), f.id]));
  const rows: (typeof knowledgeFacts.$inferInsert)[] = [];
  const dropped = { ...parsed.dropped };
  const add = (f: CleanFact): string => {
    const key = normalizeStatement(f.statement);
    const have = byStatement.get(key);
    if (have) return have;
    const id = randomUUID();
    byStatement.set(key, id);
    rows.push({
      id, accountId, topic: f.topic.slice(0, 60), statement: f.statement.slice(0, 1000), sourceLabel: factLabel(index, f),
      sourceId: f.evidence[0].sourceId, sourceLocator: f.evidence[0].locator.slice(0, 120), language: f.language, status: "suggested",
    });
    return id;
  };
  let added = 0;
  for (const f of parsed.facts) {
    const before = rows.length;
    add(f);
    if (rows.length > before) added++;
    else dropped.duplicates++;
  }
  const contradictions: ContradictionRecord[] = parsed.contradictions.map((c) => ({
    topic: c.topic, summary: c.summary, factIds: [...new Set(c.options.map(add))],
  })).filter((c) => c.factIds.length >= 2);
  for (let i = 0; i < rows.length; i += 200) await db.insert(knowledgeFacts).values(rows.slice(i, i + 200));
  return { factsAdded: added, contradictions, gaps: parsed.gaps, sourceAbout: parsed.sourceAbout, customerSpecific: parsed.customerSpecific, dropped };
}

/**
 * Stage 1 and stage 2, one after the other. Each stage's run row moves
 * queued -> running -> done (or failed, with the usage spent so far). The
 * model client is wrapped in the platform budget guard.
 */
export async function executeAnalysis(db: Db, rawLlm: PipelineLlm, accountId: string, plan: AnalysisPlan, runs: StartedRuns): Promise<AnalysisResult> {
  const llm = budgetGuarded(db, rawLlm);
  const index = corpusIndex(plan.sources);
  const result: AnalysisResult = { facts: null, playbook: null, failed: null };
  const bothRun = !!runs.factsRunId && !!runs.playbookRunId;

  // Stage 1: facts
  if (runs.factsRunId) {
    const id = runs.factsRunId;
    const model = plan.large ? plan.lightModel : plan.model;
    await db.update(pipelineRuns).set({ status: "running", startedAt: new Date() }).where(runWhere(accountId, id));
    let usage = noUsage();
    let calls = 0;
    try {
      const parts: FactsResult[] = [];
      if (plan.large) {
        for (const s of plan.sources) {
          for (const chunk of sourceChunks(s)) {
            const res = await callTool(llm, { model, effort: LIGHT_EFFORT, corpus: chunk, cacheCorpus: false, instruction: FACTS_ONE_SOURCE_INSTRUCTION, maxTokens: MAX_TOKENS, fallbacks: false }, FACTS_TOOL)
              .catch((e) => { usage = addUsage(usage, usageOf(e)); calls++; throw e; });
            usage = addUsage(usage, res.usage);
            calls++;
            parts.push(parseFactsOutput(res.tool!.input, index));
          }
        }
      } else {
        const res = await callTool(llm, { model, effort: EFFORT, corpus: plan.corpus, cacheCorpus: bothRun, instruction: FACTS_INSTRUCTION, maxTokens: MAX_TOKENS, fallbacks: true }, FACTS_TOOL)
          .catch((e) => { usage = addUsage(usage, usageOf(e)); calls++; throw e; });
        usage = res.usage;
        calls = 1;
        parts.push(parseFactsOutput(res.tool!.input, index));
      }
      const stored = await storeFacts(db, accountId, index, mergeFactsResults(parts));
      await finishRun(db, accountId, id, model, usage, calls, stored, null);
      result.facts = { reused: false, added: stored.factsAdded, contradictions: stored.contradictions.length, gaps: stored.gaps.length };
    } catch (e) {
      const msg = failureText(e);
      await finishRun(db, accountId, id, model, usage, calls, undefined, msg);
      if (runs.playbookRunId) await finishRun(db, accountId, runs.playbookRunId, plan.model, noUsage(), 0, undefined, "Not started: finding facts failed.");
      result.failed = msg;
      return result;
    }
  } else result.facts = { reused: true, added: 0, contradictions: 0, gaps: 0 };

  // Stage 2: playbook suggestions. Stage 1 may have used up the account's cap: stop then.
  if (runs.playbookRunId && runs.factsRunId && (await spendState(db, accountId))?.state === "capped") {
    await finishRun(db, accountId, runs.playbookRunId, plan.model, noUsage(), 0, undefined, CAP_STOP);
    result.failed = CAP_STOP;
    return result;
  }
  if (runs.playbookRunId) {
    const id = runs.playbookRunId;
    const calls = plan.sources.filter((s) => s.kind === "call").length;
    const data = await playbookStageData(db, accountId, calls);
    const stage2Sources = plan.large ? trimCorpus(plan.sources) : plan.sources;
    const corpus = plan.large ? assembleCorpus(stage2Sources) : plan.corpus;
    const hash = playbookHash(plan.model, corpus, data);
    if (await doneRunWithHash(db, accountId, "playbook", hash)) {
      // Same facts, catalog and playbook as a finished run: reuse it, no call.
      await db.delete(pipelineRuns).where(runWhere(accountId, id));
      result.playbook = { reused: true, suggestions: 0 };
    } else {
      await db.update(pipelineRuns).set({ status: "running", startedAt: new Date(), inputHash: hash }).where(runWhere(accountId, id));
      let usage = noUsage();
      try {
        const res = await callTool(llm, {
          model: plan.model, effort: EFFORT, corpus, cacheCorpus: bothRun && !plan.large, instruction: playbookInstruction(data), maxTokens: MAX_TOKENS, fallbacks: true,
        }, PLAYBOOK_TOOL).catch((e) => { usage = usageOf(e); throw e; });
        usage = res.usage;
        const parsed = parsePlaybookOutput(res.tool!.input, index, { skus: new Set(data.catalog.map((c) => c.sku)) });
        if (parsed.suggestions.length) {
          // created_at one millisecond apart keeps the model's order (lists sort by it).
          const at = Date.now();
          await db.insert(playbookSuggestions).values(parsed.suggestions.map((s, i) => ({
            id: randomUUID(), accountId, runId: id, kind: storedKind(s.payload.kind), payload: s.payload as unknown as Record<string, unknown>, evidence: s.evidence,
            createdAt: new Date(at + i),
          })));
        }
        await finishRun(db, accountId, id, plan.model, usage, 1, { suggestions: parsed.suggestions.length, dropped: parsed.dropped, callsInCorpus: calls }, null);
        result.playbook = { reused: false, suggestions: parsed.suggestions.length };
      } catch (e) {
        const msg = failureText(e);
        await finishRun(db, accountId, id, plan.model, usage, 1, undefined, msg);
        result.failed = msg;
        return result;
      }
    }
  } else result.playbook = { reused: true, suggestions: 0 };

  await markAnalysed(db, accountId, plan);
  return result;
}

/**
 * Sets text_hash on the analysed sources, so they no longer count as changed.
 * Only sources whose text is still what the plan read (same sections) are marked.
 */
async function markAnalysed(db: Db, accountId: string, plan: AnalysisPlan) {
  const current = new Map((await loadCorpusSources(db, accountId)).map((s) => [s.id, assembleCorpus([s])]));
  for (const s of plan.sources) {
    if (current.get(s.id) !== assembleCorpus([s])) continue;
    await db.update(sources)
      .set({ textHash: sql`encode(sha256(convert_to(${sources.extractedText}, 'UTF8')), 'hex')` })
      .where(and(eq(sources.accountId, accountId), eq(sources.id, s.id)));
  }
}

/** Plan, start and execute in one go (tests, scripts). Throws PipelineRefused when refused. */
export async function analyzeSources(db: Db, llm: PipelineLlm, accountId: string, opts: { token?: string; now?: Date } = {}): Promise<AnalysisResult> {
  const plan = await planAnalysis(db, accountId);
  if (!plan) throw new PipelineRefused("nothing", "Add a source first.");
  const runs = await startAnalysis(db, accountId, plan, opts);
  return executeAnalysis(db, llm, accountId, plan, runs);
}

// ---------------------------------------------------------------------------
// Knowledge page: contradictions, gaps, approve all, source about
// ---------------------------------------------------------------------------

async function doneFactsRuns(db: Db, accountId: string, limit = 10) {
  return db.select().from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.kind, "facts"), eq(pipelineRuns.status, "done"), isNotNull(pipelineRuns.usage)))
    .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id))
    .limit(limit);
}

const factsResult = (r: PipelineRun) => (runData(r)?.result as FactsRunResult | undefined) ?? null;

export type OpenContradiction = { runId: string; index: number; topic: string; summary: string; facts: (typeof knowledgeFacts.$inferSelect)[] };

/**
 * Contradictions still waiting for a choice: two or more of their facts are
 * still suggested and none is approved. Newest run first.
 */
export async function openContradictions(db: Db, accountId: string): Promise<OpenContradiction[]> {
  const runs = await doneFactsRuns(db, accountId);
  const all = runs.flatMap((r) => (factsResult(r)?.contradictions ?? []).map((c, index) => ({ runId: r.id, index, c })));
  const ids = [...new Set(all.flatMap((x) => x.c.factIds))].filter(isUuid);
  if (ids.length === 0) return [];
  const facts = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.id, ids)));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: OpenContradiction[] = [];
  const seen = new Set<string>();
  for (const { runId, index, c } of all) {
    const fs = c.factIds.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => !!f);
    const key = [...c.factIds].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.some((f) => f.status === "approved")) continue;
    if (fs.filter((f) => f.status === "suggested").length < 2) continue;
    out.push({ runId, index, topic: c.topic, summary: c.summary, facts: fs.filter((f) => f.status !== "rejected") });
  }
  return out;
}

/** Fact ids in open contradictions: "Approve all" leaves them for the seller's choice. */
async function contradictedFactIds(db: Db, accountId: string): Promise<Set<string>> {
  return new Set((await openContradictions(db, accountId)).flatMap((c) => c.facts.map((f) => f.id)));
}

/** Resolves a contradiction: the chosen fact is approved and the others rejected, or a typed answer becomes an approved fact. */
export async function resolveContradiction(
  db: Db, actor: Actor, accountId: string, input: { runId: string; index: number; choice: string; other?: string },
): Promise<boolean> {
  if (!isUuid(input.runId)) return false;
  const [run] = await db.select().from(pipelineRuns).where(and(runWhere(accountId, input.runId), eq(pipelineRuns.kind, "facts")));
  const c = run ? factsResult(run)?.contradictions[input.index] : undefined;
  if (!c) return false;
  const ids = c.factIds.filter(isUuid);
  const facts = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.id, ids)));
  if (facts.length === 0) return false;
  if (input.choice === "other") {
    const text = (input.other ?? "").trim();
    if (!text) return false;
    await db.insert(knowledgeFacts).values({ accountId, topic: c.topic.slice(0, 60), statement: text.slice(0, 1000), sourceLabel: "Your answer", status: "approved", createdByUserId: actor.userId });
    await db.update(knowledgeFacts).set({ status: "rejected" }).where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.id, ids)));
  } else {
    if (!ids.includes(input.choice)) return false;
    await db.update(knowledgeFacts).set({ status: "approved" }).where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.id, input.choice)));
    const rest = ids.filter((x) => x !== input.choice);
    if (rest.length) await db.update(knowledgeFacts).set({ status: "rejected" }).where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.id, rest)));
  }
  await writeAudit(db, actor, { accountId, action: "knowledge.contradiction_resolved", targetType: "pipeline_run", targetId: input.runId, details: { index: input.index, choice: input.choice === "other" ? "other" : "fact" } });
  return true;
}

/** Approves every suggested fact (of one topic, or all), except facts in an open contradiction. Returns how many. */
export async function approveAllSuggestedFacts(db: Db, accountId: string, topic?: string): Promise<number> {
  const held = [...(await contradictedFactIds(db, accountId))];
  const rows = await db.update(knowledgeFacts).set({ status: "approved" }).where(and(
    eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "suggested"),
    topic ? eq(knowledgeFacts.topic, topic) : undefined,
    held.length ? sql`${knowledgeFacts.id} not in (${sql.join(held.map((id) => sql`${id}::uuid`), sql`, `)})` : undefined,
  )).returning({ id: knowledgeFacts.id });
  return rows.length;
}

/** Questions the sources do not answer (latest analysis), minus the ones answered since. */
export async function sourceGaps(db: Db, accountId: string): Promise<Gap[]> {
  const [run] = await doneFactsRuns(db, accountId, 1);
  const gaps = run ? factsResult(run)?.gaps ?? [] : [];
  if (gaps.length === 0) return [];
  const answered = new Set(
    (await db.select({ s: knowledgeFacts.sourceLabel }).from(knowledgeFacts)
      .where(and(eq(knowledgeFacts.accountId, accountId), like(knowledgeFacts.sourceLabel, `${QUESTION_PREFIX}%`))))
      .map((r) => answeredQuestionKey(r.s)).filter((k): k is string => !!k),
  );
  return gaps.filter((g) => !answered.has(normalizeQuestion(g.question)));
}

/** What each source is about, from the latest analyses (newest wins). */
export async function sourceAboutMap(db: Db, accountId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await doneFactsRuns(db, accountId)) {
    for (const a of factsResult(r)?.sourceAbout ?? []) if (!out.has(a.sourceId)) out.set(a.sourceId, a.about);
  }
  return out;
}

/** Statements kept back from one source because they are about one customer (latest analysis that read it). */
export async function customerNotes(db: Db, accountId: string, sourceId: string): Promise<CustomerNote[]> {
  for (const r of await doneFactsRuns(db, accountId)) {
    if (!r.sourceIds.includes(sourceId)) continue;
    return (factsResult(r)?.customerSpecific ?? []).filter((n) => n.sourceId === sourceId);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Evidence links
// ---------------------------------------------------------------------------

export type EvidenceLink = { sourceId: string; locator: string; title: string; kind: string; href: string };

/** Where each (source, locator) pair is: the source title and a link to the section on the source page. */
export async function locateEvidence(db: Db, accountId: string, slug: string, pairs: { sourceId: string; locator: string }[]): Promise<Map<string, EvidenceLink>> {
  const ids = [...new Set(pairs.map((p) => p.sourceId))].filter(isUuid);
  const out = new Map<string, EvidenceLink>();
  if (ids.length === 0) return out;
  const [srcs, secs] = await Promise.all([
    db.select({ id: sources.id, title: sources.title, kind: sources.kind }).from(sources).where(and(eq(sources.accountId, accountId), inArray(sources.id, ids))),
    db.select({ sourceId: sourceSections.sourceId, locator: sourceSections.locator, position: sourceSections.position }).from(sourceSections)
      .where(and(eq(sourceSections.accountId, accountId), inArray(sourceSections.sourceId, ids))),
  ]);
  const src = new Map(srcs.map((s) => [s.id, s]));
  const pos = new Map<string, number>();
  for (const s of secs) {
    const k = `${s.sourceId}|${s.locator}`;
    if (!pos.has(k)) pos.set(k, s.position);
  }
  for (const p of pairs) {
    const s = src.get(p.sourceId);
    if (!s) continue;
    const k = `${p.sourceId}|${p.locator}`;
    const at = pos.get(k);
    const anchor = at === undefined ? "" : `#${s.kind === "call" ? "l" : "s"}-${at}`;
    out.set(k, { sourceId: s.id, locator: p.locator, title: s.title, kind: s.kind, href: `/app/${slug}/setup/sources/${s.id}${anchor}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Playbook suggestions: review and merge
// ---------------------------------------------------------------------------

export type Suggestion = Omit<PlaybookSuggestion, "payload" | "kind"> & { kind: SuggestionKind; payload: SuggestionPayload };

/**
 * The P11 kinds (opener, play facts, own play card, catalog item texts) are
 * not values of the `playbook_suggestion_kind` enum yet (this lane adds no
 * migration). They are stored with STORED_AS in the kind column and told
 * apart by `payload.kind`; every reader goes through `suggestionKind`. Once a
 * migration adds the values, storedKind can return the kind itself.
 */
const P11_KINDS = new Set<SuggestionKind>(["opener", "play_content", "play_card", "catalog_item"]);
const STORED_AS = "discovery_question" as const;
type DbKind = PlaybookSuggestion["kind"];
export function storedKind(kind: SuggestionKind): DbKind {
  return P11_KINDS.has(kind) ? STORED_AS : (kind as DbKind);
}
/** A stored row's real kind. */
export function suggestionKind(row: { kind: string; payload: unknown }): SuggestionKind {
  const p = (row.payload ?? {}) as { kind?: unknown };
  return typeof p.kind === "string" && P11_KINDS.has(p.kind as SuggestionKind) ? (p.kind as SuggestionKind) : (row.kind as SuggestionKind);
}
const asSuggestion = (row: PlaybookSuggestion): Suggestion => ({ ...row, kind: suggestionKind(row) } as Suggestion);
/** Kinds applied the moment they are approved (and final then): limits, and catalog item texts (into the catalog draft). */
export const APPLIED_ON_APPROVAL: ReadonlySet<SuggestionKind> = new Set(["limit", "catalog_item"]);

/** The latest finished playbook run and its suggestions (rejected ones included), in kind order. */
export async function latestSuggestions(db: Db, accountId: string): Promise<{ run: PipelineRun | null; items: Suggestion[] }> {
  const [run] = await db.select().from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.kind, "playbook"), eq(pipelineRuns.status, "done")))
    .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id)).limit(1);
  if (!run) return { run: null, items: [] };
  const items = await db.select().from(playbookSuggestions)
    .where(and(eq(playbookSuggestions.accountId, accountId), eq(playbookSuggestions.runId, run.id)))
    .orderBy(asc(playbookSuggestions.createdAt), asc(playbookSuggestions.id));
  return { run, items: items.map(asSuggestion) };
}

/** Suggestions of the latest run whose evidence comes from one source (a call's suggestions panel). */
export async function suggestionsForSource(db: Db, accountId: string, sourceId: string): Promise<Suggestion[]> {
  const { items } = await latestSuggestions(db, accountId);
  return items.filter((s) => s.evidence.some((e) => e.sourceId === sourceId));
}

const suggestionWhere = (accountId: string, id: string) => and(eq(playbookSuggestions.accountId, accountId), eq(playbookSuggestions.id, id));

/** Accept or reject one suggestion. Null when it is not this account's. */
export async function decideSuggestion(db: Db, actor: Actor, accountId: string, id: string, status: "accepted" | "rejected" | "suggested", now = new Date()) {
  if (!isUuid(id)) return null;
  const [raw] = await db.select().from(playbookSuggestions).where(suggestionWhere(accountId, id));
  if (!raw) return null;
  const before = asSuggestion(raw);
  if (APPLIED_ON_APPROVAL.has(before.kind)) {
    // An approved limit has changed a setting, approved item texts the catalog draft: final here (change it where it lives).
    if (before.status === "accepted" || before.status === "edited") return before;
    if (status === "accepted" && before.kind === "limit") await applyLimit(db, actor, accountId, before, now);
    if (status === "accepted" && before.kind === "catalog_item" && !(await applyCatalogItem(db, actor, accountId, before))) return null;
  }
  const [row] = await db.update(playbookSuggestions)
    .set({ status, decidedByUserId: status === "suggested" ? null : actor.userId, decidedAt: status === "suggested" ? null : now })
    .where(suggestionWhere(accountId, id)).returning();
  if (row) await writeAudit(db, actor, { accountId, action: `playbook.suggestion_${status}`, targetType: "playbook_suggestion", targetId: id, details: { kind: before.kind } });
  return row ? asSuggestion(row) : null;
}

/**
 * Accepts every open suggestion of the latest run, of one kind group. Limits
 * are never accepted in bulk; catalog item texts are applied one by one.
 */
export async function acceptAllSuggestions(db: Db, actor: Actor, accountId: string, kinds: SuggestionPayload["kind"][], now = new Date()): Promise<number> {
  const { run, items } = await latestSuggestions(db, accountId);
  const allowed = kinds.filter((k) => k !== "limit");
  if (!run || allowed.length === 0) return 0;
  const ids: string[] = [];
  for (const s of items) {
    if (s.status !== "suggested" || !(allowed as SuggestionKind[]).includes(s.kind)) continue;
    if (s.kind === "catalog_item" && !(await applyCatalogItem(db, actor, accountId, s))) continue;
    ids.push(s.id);
  }
  if (ids.length === 0) return 0;
  const rows = await db.update(playbookSuggestions)
    .set({ status: "accepted", decidedByUserId: actor.userId, decidedAt: now })
    .where(and(eq(playbookSuggestions.accountId, accountId), eq(playbookSuggestions.runId, run.id), eq(playbookSuggestions.status, "suggested"), inArray(playbookSuggestions.id, ids)))
    .returning({ id: playbookSuggestions.id });
  if (rows.length) await writeAudit(db, actor, { accountId, action: "playbook.suggestions_accepted", targetType: "pipeline_run", targetId: run.id, details: { n: rows.length, kinds: allowed } });
  return rows.length;
}

/** The text fields a seller may edit per kind, with their limits. */
export const EDITABLE: Record<SuggestionPayload["kind"], { name: string; max: number; required: boolean }[]> = {
  goal: [{ name: "text", max: 1000, required: true }],
  tone: [{ name: "text", max: 300, required: true }],
  field: [{ name: "label", max: 60, required: true }, { name: "example", max: 200, required: false }],
  discovery_question: [{ name: "label", max: 60, required: true }, { name: "question", max: 200, required: true }],
  objection: [{ name: "objection", max: 200, required: true }, { name: "answer", max: 600, required: true }],
  limit: [{ name: "rule", max: 200, required: true }],
  never: [{ name: "rule", max: 200, required: true }],
  // P11. At least one opener input and one item text is required (checked in editSuggestion).
  opener: [{ name: "leadsAskAbout", max: 120, required: false }, { name: "openingQuestion", max: 200, required: false }],
  play_content: [{ name: "content", max: 600, required: true }],
  // The moves ("do", one per line) are checked with parsePlayCard.
  play_card: [{ name: "when", max: 200, required: true }, { name: "example", max: 300, required: true }, { name: "notThis", max: 300, required: true }],
  catalog_item: [{ name: "plainName", max: 60, required: false }, { name: "valueLine", max: 200, required: false }],
};

/** Saves an edited suggestion (status edited = accepted with changes). Field stages and limit percentages are edited too. */
export async function editSuggestion(db: Db, actor: Actor, accountId: string, id: string, values: Record<string, string>, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUuid(id)) return { ok: false, error: "missing" };
  const [raw] = await db.select().from(playbookSuggestions).where(suggestionWhere(accountId, id));
  if (!raw) return { ok: false, error: "missing" };
  const row = asSuggestion(raw);
  const payload = { ...(row.payload as unknown as Record<string, unknown>) };
  const kind = row.kind;
  if (kind === "catalog_item" && (row.status === "accepted" || row.status === "edited")) return { ok: false, error: "applied" };
  for (const f of EDITABLE[kind]) {
    const v = (values[f.name] ?? "").replace(/\s+/g, " ").trim();
    if (f.required && !v) return { ok: false, error: "required" };
    if (v.length > f.max) return { ok: false, error: "too_long" };
    payload[f.name] = v;
  }
  if (kind === "field" && ["before_quote", "before_order_form", "optional"].includes(values.stage ?? "")) payload.stage = values.stage;
  if (kind === "opener" && !payload.leadsAskAbout && !payload.openingQuestion) return { ok: false, error: "required" };
  if (kind === "catalog_item" && !payload.plainName && !payload.valueLine) return { ok: false, error: "required" };
  if (kind === "play_card") {
    const card = parsePlayCard({ when: String(payload.when), do: values.do ?? "", example: String(payload.example), notThis: String(payload.notThis) });
    if (!card.ok) return { ok: false, error: "card" };
    payload.do = card.value.do;
  }
  if (kind === "limit") {
    if (row.status === "accepted" || row.status === "edited") return { ok: false, error: "applied" };
    // The value of the setting the limit updates.
    const setting = limitSetting(payload as unknown as LimitPayload);
    if (setting === "discount") {
      const pct = Number((values.maxDiscountPercent ?? "").trim());
      if (!Number.isFinite(pct) || pct <= 0 || pct > 50) return { ok: false, error: "discount" };
      payload.maxDiscountPercent = pct;
    }
    if (setting === "custom_pricing") {
      const qty = Number((values.qty ?? "").trim());
      if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) return { ok: false, error: "qty" };
      payload.qty = qty;
    }
    if (setting === "offer_meeting" || setting === "hand_off") {
      const when = (values.when ?? "").replace(/\s+/g, " ").trim();
      if (!when) return { ok: false, error: "required" };
      if (when.length > 300) return { ok: false, error: "too_long" };
      payload.when = when;
    }
  }
  if (kind === "limit") await applyLimit(db, actor, accountId, { ...row, payload } as Suggestion, now);
  if (kind === "catalog_item" && !(await applyCatalogItem(db, actor, accountId, { ...row, payload } as Suggestion))) return { ok: false, error: "missing" };
  await db.update(playbookSuggestions).set({ payload, status: "edited", decidedByUserId: actor.userId, decidedAt: now }).where(suggestionWhere(accountId, id));
  await writeAudit(db, actor, { accountId, action: "playbook.suggestion_edited", targetType: "playbook_suggestion", targetId: id, details: { kind } });
  return { ok: true };
}

/**
 * "Save as agent draft vN": merges the accepted and edited suggestions of the
 * latest run into the draft playbook (created from the live one when
 * missing). Returns the draft version and how many items were merged.
 */
export async function saveSuggestionsToDraft(db: Db, actor: Actor, accountId: string): Promise<{ version: number; merged: number }> {
  const { items } = await latestSuggestions(db, accountId);
  // Limits and catalog item texts were applied when approved; everything else merges here.
  const chosen = items.filter((s) => (s.status === "accepted" || s.status === "edited") && !APPLIED_ON_APPROVAL.has(s.kind));
  const draft = await ensureDraftVersion(db, accountId);
  if (chosen.length === 0) return { version: draft.version, merged: 0 };
  const ids = [...new Set(chosen.flatMap((s) => s.evidence.map((e) => e.sourceId)))].filter(isUuid);
  const links = ids.length
    ? await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(eq(sources.accountId, accountId), inArray(sources.id, ids)))
    : [];
  const title = new Map(links.map((l) => [l.id, l.title]));
  const playbook = mergeSuggestions(draft.playbook, chosen.map((s) => {
    const e = s.evidence[0];
    return { payload: { ...s.payload, kind: s.kind } as SuggestionPayload, source: e ? `${title.get(e.sourceId) ?? "Source"} ${e.locator}` : undefined };
  }));
  await saveDraftPlaybook(db, accountId, playbook, "Suggestions from your sources");
  await writeAudit(db, actor, { accountId, action: "playbook.suggestions_saved", targetType: "agent_version", targetId: draft.id, details: { version: draft.version, merged: chosen.length } });
  return { version: draft.version, merged: chosen.length };
}

// ---------------------------------------------------------------------------
// Limits: preview and apply on approval (lib/pipeline/limits.ts)
// ---------------------------------------------------------------------------

/** Today's values the limits would change: the working playbook and the custom-pricing quantity per SKU. */
export async function limitContext(db: Db, accountId: string, skus: string[]): Promise<LimitContext> {
  const pb = await workingPlaybook(db, accountId)
    ?? (await db.select({ name: sellerAccounts.tradeName, bp: sellerAccounts.maxDiscountBp }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId))
      .then(([a]) => (a ? defaultPlaybook(a.name, a.bp) : null)));
  const customPricing: LimitContext["customPricing"] = new Map();
  const wanted = [...new Set(skus.map((x) => x.toUpperCase()))];
  if (wanted.length) {
    const [lists, ms] = await Promise.all([
      listPriceLists(db, accountId),
      db.select({ lineageId: markets.priceListLineageId, isHome: markets.isHome }).from(markets).where(eq(markets.accountId, accountId)),
    ]);
    // The home market's price list first, then the others.
    const home = new Set(ms.filter((m) => m.isHome && m.lineageId).map((m) => m.lineageId!));
    const ordered = [...lists.filter((l) => home.has(l.lineageId)), ...lists.filter((l) => !home.has(l.lineageId))];
    for (const l of ordered) {
      const entries = await entriesOf(db, accountId, l.shown.id);
      for (const sku of wanted) {
        const e = entries.find((x) => x.sku === sku);
        if (e && !customPricing.has(sku)) customPricing.set(sku, { lineageId: l.lineageId, listName: l.shown.name, current: e.customPricingFromQty });
      }
    }
  }
  return {
    maxDiscountBp: pb?.maxDiscountBp ?? 0, offerMeetingWhen: pb?.offerMeetingWhen ?? "", handOffWhen: pb?.handOffWhen ?? "", customPricing,
  };
}

/** What approving each limit of the list changes, by suggestion id. */
export async function limitPreviews(db: Db, accountId: string, items: Suggestion[]): Promise<Map<string, LimitPreview>> {
  const limits = items.filter((s) => s.payload.kind === "limit") as (Suggestion & { payload: LimitPayload })[];
  if (limits.length === 0) return new Map();
  const ctx = await limitContext(db, accountId, limits.flatMap((s) => (s.payload.sku ? [s.payload.sku] : [])));
  return new Map(limits.map((s) => [s.id, limitPreview(s.payload, ctx)]));
}

/**
 * Applies an approved limit: the discount cap, meeting or hand-over triggers
 * and exceptions go into the draft playbook; a custom-pricing quantity goes
 * into the price list's draft for that item. Never touches neverDo.
 */
async function applyLimit(db: Db, actor: Actor, accountId: string, s: Suggestion, now: Date) {
  const p = s.payload as LimitPayload;
  const ctx = await limitContext(db, accountId, p.sku ? [p.sku] : []);
  const setting = effectiveSetting(p, ctx);
  if (setting === "custom_pricing") {
    const target = ctx.customPricing.get(p.sku!)!;
    const draft = await ensureDraft(db, actor, accountId, target.lineageId);
    const entry = draft ? (await entriesOf(db, accountId, draft.id)).find((e) => e.sku === p.sku) : undefined;
    if (draft && entry) {
      await setEntry(db, actor, accountId, target.lineageId, {
        sku: entry.sku, oneTimeCharged: entry.oneTimeCharged, oneTimeMinor: entry.oneTimeMinor, oneTimeTiers: entry.oneTimeTiers,
        recurringCharged: entry.recurringCharged, recurringMinor: entry.recurringMinor, recurringPeriod: entry.recurringPeriod, recurringTiers: entry.recurringTiers,
        customPricingFromQty: p.qty ?? null,
      });
    }
  } else {
    const draft = await ensureDraftVersion(db, accountId);
    const e = s.evidence[0];
    const next = applyLimitToPlaybook(draft.playbook, p, setting, {
      id: s.id, approvedAt: now.toISOString(), approvedBy: actor.userId, ...(e ? { evidence: { sourceId: e.sourceId, locator: e.locator, quote: e.quote } } : {}),
    });
    await saveDraftPlaybook(db, accountId, next);
  }
  await writeAudit(db, actor, { accountId, action: "playbook.limit_applied", targetType: "playbook_suggestion", targetId: s.id, details: { setting, rule: p.rule.slice(0, 200) } });
}

/**
 * Applies approved item texts (P11): the plain name and value line go into the
 * catalog draft's item with that SKU. False when the SKU is no longer in the catalog.
 */
async function applyCatalogItem(db: Db, actor: Actor, accountId: string, s: Suggestion): Promise<boolean> {
  const p = s.payload as CatalogItemPayload;
  const ok = await setDraftItemTexts(db, accountId, p.sku, { plainName: p.plainName, valueLine: p.valueLine });
  if (ok) await writeAudit(db, actor, { accountId, action: "catalog.item_texts_applied", targetType: "playbook_suggestion", targetId: s.id, details: { sku: p.sku } });
  return ok;
}

// ---------------------------------------------------------------------------
// Sources: "Approved" once every fact found in a source is reviewed
// ---------------------------------------------------------------------------

/** Per source: how many of its facts are still suggested and how many are approved. */
export async function sourceFactCounts(db: Db, accountId: string): Promise<Map<string, { suggested: number; approved: number }>> {
  const rows = await db
    .select({ sourceId: knowledgeFacts.sourceId, status: knowledgeFacts.status, n: sql<string>`count(*)` })
    .from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), isNotNull(knowledgeFacts.sourceId)))
    .groupBy(knowledgeFacts.sourceId, knowledgeFacts.status);
  const out = new Map<string, { suggested: number; approved: number }>();
  for (const r of rows) {
    const c = out.get(r.sourceId!) ?? { suggested: 0, approved: 0 };
    if (r.status === "suggested") c.suggested += Number(r.n);
    if (r.status === "approved") c.approved += Number(r.n);
    out.set(r.sourceId!, c);
  }
  return out;
}

/** The status a source shows: "approved" instead of "ready" when its facts are all reviewed and one is approved. */
export function sourceDisplayStatus<S extends string>(status: S, counts: { suggested: number; approved: number } | undefined): S | "approved" {
  return status === "ready" && counts && counts.suggested === 0 && counts.approved > 0 ? "approved" : status;
}
