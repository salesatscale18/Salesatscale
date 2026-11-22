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
 * Stage 1 reads only the sources new or changed since the last finished
 * analysis (planAnalysis explains when it reads them all); stage 2 always
 * reads the whole corpus. Both stages run on the "pipeline" model, also for
 * large corpora ("pipeline_light" is for other jobs).
 *
 * Model calls go through a PipelineLlm wrapped in budgetGuarded. Tests pass
 * ScriptedPipelineLlm; nothing here calls the real API by itself.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, auditLog, catalogVersions, knowledgeFacts, markets, pipelineRuns, playbookSuggestions, sellerAccounts, sourceSections, sources, users,
  type PipelineRun, type PlayKey, type Playbook, type PlaybookSuggestion,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { answeredQuestionKey, normalizeQuestion, QUESTION_PREFIX } from "@/lib/agent/knowledge";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { defaultPlaybook, OPENER_MAX, parsePlayCard } from "@/lib/agent/playbook";
import { MAX_OPENER_TOPICS, writtenIn } from "@/lib/agent/core/opener";
import { VALUE_LINE_INPUT_MAX } from "@/lib/catalog/rules";
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
import { differs, nearDuplicate, subjectSimilarity, wordsKey } from "./dedup";
import { DOCUMENT_PAGE_TOKENS, documentRefs, loadDocuments, type DocumentRef } from "./documents";
import { fileStore, type FileStore } from "@/lib/sources/blob";
import { FACTS_INSTRUCTION, FACTS_ONE_SOURCE_INSTRUCTION, factsInstruction, KNOWN_FACTS_MAX, knownFactIndex, PROMPT_VERSION as FACTS_VERSION } from "./prompts/facts";
import { playbookInstruction, PROMPT_VERSION as PLAYBOOK_VERSION, type PlaybookStageData } from "./prompts/playbook";
import { FACTS_TOOL, PLAYBOOK_TOOL, PROMPT_VERSION as SYSTEM_VERSION } from "./prompts/system";
import {
  limitSetting, normalizeStatement, openerPayloadTopics, parseFactsOutput, parsePlaybookOutput,
  type CatalogItemPayload, type OpenerPayload, type CleanFact, type CorpusIndex, type CustomerNote, type FactsResult, type Gap, type LimitPayload, type SourceAbout,
  type SuggestionKind, type SuggestionPayload,
} from "./validate";

/** Sources that go into the corpus: read, with text (a partly failed source still has usable text). */
export const CORPUS_STATUSES = ["ready", "partly_failed"] as const;
/** A run still queued or running after this long stopped (the function ended): shown as failed. */
export const STALE_RUN_MS = 15 * 60 * 1000;
/** Max output per call: streamed, so large is fine. */
const MAX_TOKENS = 32_000;
const EFFORT = "medium" as const;

// ---------------------------------------------------------------------------
// Run data stored in pipeline_runs.usage
// ---------------------------------------------------------------------------

export type ContradictionRecord = { topic: string; summary: string; factIds: string[] };
/**
 * A suggested fact that says something different from an approved fact.
 * by: "model" when the model named the known fact, "check" when the code's
 * backstop found it (dedup.ts `differs`).
 */
export type FactConflict = { factId: string; approvedFactId: string; by: "model" | "check" };
export type FactsRunResult = {
  factsAdded: number;
  /** Which sources stage 1 read: all, or only the new and changed ones. Missing on older runs: all. */
  scope?: FactsScope;
  /** Prompt versions and model of the run (factsRules): a later run reads only changed sources when they match. */
  rules?: string;
  contradictions: ContradictionRecord[];
  /** New suggested facts that differ from an approved fact (missing when none, and on older runs). */
  conflicts?: FactConflict[];
  gaps: Gap[];
  sourceAbout: SourceAbout[];
  customerSpecific: CustomerNote[];
  dropped: FactsResult["dropped"];
};
export type FactsScope = "all" | "changed";
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

/** Whether any facts run (stage 1) of this account ever finished. */
async function anyDoneFactsRun(db: Db, accountId: string): Promise<boolean> {
  const [r] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.kind, "facts"), eq(pipelineRuns.status, "done")))
    .limit(1);
  return !!r;
}

export type AnalysisPlan = {
  sources: (CorpusSource & { changed: boolean })[];
  /** Sources new or changed since their last analysis. */
  changed: number;
  /** The whole corpus (stage 2). */
  corpus: string;
  corpusTokens: number;
  /** The whole corpus is large: stage 2 reads a trimmed corpus. */
  large: boolean;
  /** What stage 1 reads: all sources, or only the new and changed ones. */
  factsScope: FactsScope;
  factsSources: (CorpusSource & { changed: boolean })[];
  factsCorpus: string;
  /** The facts corpus is large: stage 1 runs per source chunk (same model). */
  factsLarge: boolean;
  /** PDFs of factsSources that stage 1 also reads as pages (only with a file store; documents.ts). */
  documents: DocumentRef[];
  model: string;
  facts: { hash: string; reuse: boolean };
  /** The stage 2 hash with today's facts; recomputed after stage 1 when it runs. */
  playbook: { hash: string; reuse: boolean };
  estimate: AnalysisEstimate;
  /** What the confirm click must echo back: the run starts only if nothing changed since the estimate. */
  token: string;
  /**
   * No analysis ever finished for this account (facts may still exist: added
   * by hand, or seeded). The Analyze line then never speaks of a "last run".
   */
  firstRun?: boolean;
};

/**
 * What the Analyze line says, from the same reuse decision as the confirm
 * step: nothing to re-run, or what changed (sources, catalog or playbook
 * inputs, or how the analysis works) and the estimated cost. No token counts.
 */
export type AnalysisSummary = {
  nothingToRerun: boolean;
  changed: number;
  total: number;
  /** Stage 1 is reused but the catalog or playbook inputs of stage 2 changed. */
  stage2Changed: boolean;
  /** Stage 1 re-runs although no source changed (the analysis itself was updated). */
  rulesChanged: boolean;
  /** No analysis has finished yet: nothing to compare with. */
  firstRun: boolean;
  costMicros: number;
};

export function analysisSummary(plan: Pick<AnalysisPlan, "changed" | "sources" | "estimate" | "facts" | "playbook" | "firstRun">): AnalysisSummary {
  const nothingToRerun = plan.facts.reuse && plan.playbook.reuse;
  const firstRun = !plan.facts.reuse && plan.firstRun === true;
  return {
    nothingToRerun,
    changed: plan.changed,
    total: plan.sources.length,
    stage2Changed: plan.facts.reuse && !plan.playbook.reuse,
    rulesChanged: !firstRun && !plan.facts.reuse && plan.changed === 0,
    firstRun,
    costMicros: plan.estimate.costMicros,
  };
}

/** The prompt versions and model a facts run used. Runs with the same rules can build on each other. */
export const factsRules = (model: string) => `${SYSTEM_VERSION}|${FACTS_VERSION}|${model}`;

/** The rules of the newest finished facts run, or null (none, or an older run that did not record them). */
async function lastFactsRules(db: Db, accountId: string): Promise<string | null> {
  const [r] = await db.select({ usage: pipelineRuns.usage }).from(pipelineRuns)
    .where(and(eq(pipelineRuns.accountId, accountId), eq(pipelineRuns.kind, "facts"), eq(pipelineRuns.status, "done")))
    .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id))
    .limit(1);
  return (runData(r ?? { usage: null })?.result as FactsRunResult | undefined)?.rules ?? null;
}

/**
 * The seller's approved facts that stage 1 gets after its instruction (so it
 * does not restate them): the newest KNOWN_FACTS_MAX, sorted by topic and
 * statement so the same facts give the same bytes. Each goes to the model
 * with its place in this list as its id (K1, K2, ...: prompts/facts.ts), so
 * the model can name the one a new fact differs from.
 */
export async function knownFacts(db: Db, accountId: string): Promise<KnownFact[]> {
  const rows = await db.select({ id: knowledgeFacts.id, topic: knowledgeFacts.topic, statement: knowledgeFacts.statement }).from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "approved")))
    .orderBy(desc(knowledgeFacts.createdAt), desc(knowledgeFacts.id))
    .limit(KNOWN_FACTS_MAX);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => cmp(a.topic, b.topic) || cmp(a.statement, b.statement) || cmp(a.id, b.id));
}
export type KnownFact = { id: string; topic: string; statement: string };
/** The known facts as the model sees them (no row ids), for the estimate. */
const knownForModel = (known: KnownFact[]) => known.map((f) => ({ topic: f.topic, statement: f.statement }));

/**
 * Stage 0: corpus, hashes, reuse and the estimate. Null when there is nothing to analyse.
 *
 * What stage 1 reads (the safest rule): only the sources new or changed since
 * the last finished analysis (text_hash null: added, re-read or edited, or
 * part of an analysis that did not finish), when the newest finished facts run
 * used the same prompt versions and model. Otherwise every source: on the first
 * analysis, after the analysis rules changed (a new prompt version or model,
 * which also re-reads unchanged sources) and when `full` is set (re-read
 * everything). Nothing new or changed under the same rules: stage 1 is reused.
 * The approved facts are not part of the stage 1 hash: they only keep the
 * model from restating them.
 */
export async function planAnalysis(
  db: Db, accountId: string, env: Record<string, string | undefined> = process.env, opts: { full?: boolean; store?: FileStore | null } = {},
): Promise<AnalysisPlan | null> {
  const list = await loadCorpusSources(db, accountId);
  if (list.length === 0) return null;
  const model = modelFor("pipeline", env);
  const corpus = assembleCorpus(list);
  const corpusTokens = tokensOf(corpus);
  const large = corpusTokens > LARGE_CORPUS_TOKENS;
  const factsScope: FactsScope = !opts.full && (await lastFactsRules(db, accountId)) === factsRules(model) ? "changed" : "all";
  const factsSources = factsScope === "changed" ? list.filter((s) => s.changed) : list;
  const factsCorpus = factsScope === "changed" ? assembleCorpus(factsSources) : corpus;
  const factsCorpusTokens = tokensOf(factsCorpus);
  const factsLarge = factsCorpusTokens > LARGE_CORPUS_TOKENS;
  // PDFs read as pages (only with a file store): their files are part of the hash.
  const store = opts.store === undefined ? fileStore(env) : opts.store;
  const documents = store ? await documentRefs(db, accountId, factsSources.map((s) => s.id)) : [];
  // The scope is part of the hash: a run over the changed sources never stands in for a full one.
  const factsData = {
    ...(factsScope === "changed" ? { scope: "changed" } : {}),
    ...(documents.length ? { documents: documents.map((d) => `${d.sourceId}|${d.file.blobPath}|${d.file.size}`) } : {}),
  };
  const factsHash = inputHash({ versions: [SYSTEM_VERSION, FACTS_VERSION], model, corpus: factsCorpus, data: Object.keys(factsData).length ? factsData : undefined });
  const calls = list.filter((s) => s.kind === "call").length;
  const data = await playbookStageData(db, accountId, calls);
  const stage2Corpus = large ? assembleCorpus(trimCorpus(list)) : corpus;
  const pbHash = playbookHash(model, stage2Corpus, data);
  const factsReuse = (factsScope === "changed" && factsSources.length === 0) || !!(await doneRunWithHash(db, accountId, "facts", factsHash));
  const pbReuse = factsReuse && !!(await doneRunWithHash(db, accountId, "playbook", pbHash));
  const known = factsReuse ? [] : await knownFacts(db, accountId);
  const estimate = estimateAnalysis({
    corpusTokens,
    factsCorpusTokens,
    sharedCorpus: factsCorpus === corpus,
    chunkTokens: factsLarge ? factsSources.flatMap((s) => sourceChunks(s).map(tokensOf)) : undefined,
    trimmedTokens: large ? tokensOf(stage2Corpus) : undefined,
    runFacts: !factsReuse,
    runPlaybook: !pbReuse,
    dataTokens: tokensOf(JSON.stringify(data)),
    knownFactsTokens: known.length ? tokensOf(JSON.stringify(knownForModel(known))) : 0,
    documentTokens: documents.reduce((n, d) => n + d.pages * DOCUMENT_PAGE_TOKENS, 0),
    model,
  });
  return {
    sources: list, changed: list.filter((s) => s.changed).length, corpus, corpusTokens, large,
    factsScope, factsSources, factsCorpus, factsLarge, documents, model,
    facts: { hash: factsHash, reuse: factsReuse }, playbook: { hash: pbHash, reuse: pbReuse }, estimate,
    token: `${factsHash.slice(0, 16)}${pbHash.slice(0, 16)}`,
    firstRun: factsReuse ? false : !(await anyDoneFactsRun(db, accountId)),
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
    // The facts run lists the sources it reads (customerNotes looks a source up by it).
    ...(factsRunId ? [{ id: factsRunId, accountId, kind: "facts" as const, status: "queued" as const, model: plan.model, sourceIds: plan.factsSources.map((s) => s.id), inputHash: plan.facts.hash }] : []),
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

/**
 * Stores stage 1: new suggested facts, contradiction sides as facts. A new fact
 * is skipped (counted as a duplicate) when it has the same words as any fact of
 * the account, in any order, case or punctuation, or is a near-duplicate of a
 * fact from the same source (lib/pipeline/dedup.ts; numbers must match).
 *
 * A new fact that says something different from an approved fact is marked
 * against it (FactConflict): when the model names that known fact
 * (known_fact_id), or else when the code finds one of the same topic with
 * nearly the same subject words but other numbers or the opposite negation
 * (dedup.ts `differs`). The seller then replaces the approved fact or keeps it.
 */
async function storeFacts(
  db: Db, accountId: string, index: CorpusIndex, parsed: FactsResult, meta: { scope: FactsScope; rules: string; known: KnownFact[] },
): Promise<FactsRunResult> {
  const existing = await db.select({ id: knowledgeFacts.id, topic: knowledgeFacts.topic, statement: knowledgeFacts.statement, sourceId: knowledgeFacts.sourceId, status: knowledgeFacts.status })
    .from(knowledgeFacts).where(eq(knowledgeFacts.accountId, accountId));
  const approved = existing.filter((f) => f.status === "approved");
  const approvedIds = new Set(approved.map((f) => f.id));
  const topicKey = (t: string) => t.trim().toLowerCase();
  const conflicts: FactConflict[] = [];
  /** The approved fact a new fact differs from: the one the model named, else the code's closest match. */
  const conflictOf = (f: CleanFact): Omit<FactConflict, "factId"> | null => {
    const i = knownFactIndex(f.knownFactRef);
    const named = i !== null ? meta.known[i] : undefined;
    if (named && approvedIds.has(named.id)) return { approvedFactId: named.id, by: "model" };
    let best: { id: string; score: number } | null = null;
    for (const a of approved) {
      if (topicKey(a.topic) !== topicKey(f.topic) || !differs(f.statement, a.statement)) continue;
      const score = subjectSimilarity(f.statement, a.statement);
      if (!best || score > best.score) best = { id: a.id, score };
    }
    return best ? { approvedFactId: best.id, by: "check" } : null;
  };
  const byStatement = new Map(existing.map((f) => [normalizeStatement(f.statement), f.id]));
  const byWords = new Map(existing.map((f) => [wordsKey(f.statement), f.id]));
  const bySource = new Map<string, { id: string; statement: string }[]>();
  const ofSource = (sourceId: string) => {
    let l = bySource.get(sourceId);
    if (!l) bySource.set(sourceId, (l = []));
    return l;
  };
  for (const f of existing) if (f.sourceId) ofSource(f.sourceId).push(f);
  const rows: (typeof knowledgeFacts.$inferInsert)[] = [];
  const dropped = { ...parsed.dropped };
  const add = (f: CleanFact): string => {
    const key = normalizeStatement(f.statement);
    const words = wordsKey(f.statement);
    const sourceId = f.evidence[0].sourceId;
    const have = byStatement.get(key) ?? (words ? byWords.get(words) : undefined)
      ?? ofSource(sourceId).find((x) => nearDuplicate(f.statement, x.statement))?.id;
    if (have) return have;
    const id = randomUUID();
    byStatement.set(key, id);
    if (words) byWords.set(words, id);
    ofSource(sourceId).push({ id, statement: f.statement });
    rows.push({
      id, accountId, topic: f.topic.slice(0, 60), statement: f.statement.slice(0, 1000), sourceLabel: factLabel(index, f),
      sourceId, sourceLocator: f.evidence[0].locator.slice(0, 120), language: f.language, status: "suggested",
    });
    return id;
  };
  let added = 0;
  for (const f of parsed.facts) {
    const before = rows.length;
    const id = add(f);
    if (rows.length > before) {
      added++;
      const c = conflictOf(f);
      if (c) conflicts.push({ factId: id, ...c });
    } else dropped.duplicates++;
  }
  const contradictions: ContradictionRecord[] = parsed.contradictions.map((c) => ({
    topic: c.topic, summary: c.summary, factIds: [...new Set(c.options.map(add))],
  })).filter((c) => c.factIds.length >= 2);
  for (let i = 0; i < rows.length; i += 200) await db.insert(knowledgeFacts).values(rows.slice(i, i + 200));
  return {
    factsAdded: added, scope: meta.scope, rules: meta.rules,
    contradictions, ...(conflicts.length ? { conflicts } : {}), gaps: parsed.gaps, sourceAbout: parsed.sourceAbout, customerSpecific: parsed.customerSpecific, dropped,
  };
}

/**
 * Stage 1 and stage 2, one after the other. Each stage's run row moves
 * queued -> running -> done (or failed, with the usage spent so far). The
 * model client is wrapped in the platform budget guard.
 */
export async function executeAnalysis(
  db: Db, rawLlm: PipelineLlm, accountId: string, plan: AnalysisPlan, runs: StartedRuns, deps: { store?: FileStore | null } = {},
): Promise<AnalysisResult> {
  const llm = budgetGuarded(db, rawLlm);
  const index = corpusIndex(plan.sources);
  const result: AnalysisResult = { facts: null, playbook: null, failed: null };
  const bothRun = !!runs.factsRunId && !!runs.playbookRunId;
  // The corpus is cached only when both stages run and read the same one (stage 1 read every source).
  const sharedCache = bothRun && plan.factsCorpus === plan.corpus && !plan.large && !plan.factsLarge;

  // Stage 1: facts over plan.factsSources, on the main model (also for large corpora).
  if (runs.factsRunId) {
    const id = runs.factsRunId;
    const model = plan.model;
    const factsIndex = corpusIndex(plan.factsSources);
    const known = await knownFacts(db, accountId);
    await db.update(pipelineRuns).set({ status: "running", startedAt: new Date() }).where(runWhere(accountId, id));
    let usage = noUsage();
    let calls = 0;
    try {
      // PDFs read as pages: sent after the corpus block (documents.ts, llm.ts).
      const store = plan.documents.length ? (deps.store === undefined ? fileStore() : deps.store) : null;
      const documents = store ? await loadDocuments(store, plan.documents) : [];
      const parts: FactsResult[] = [];
      if (plan.factsLarge) {
        // One source per call: a source's PDF goes with its first chunk.
        for (const s of plan.factsSources) {
          const doc = documents.filter((d) => d.sourceId === s.id);
          for (const [i, chunk] of sourceChunks(s).entries()) {
            const docs = i === 0 && doc.length ? doc : undefined;
            const instruction = factsInstruction(FACTS_ONE_SOURCE_INSTRUCTION, known, { documents: !!docs });
            const res = await callTool(llm, { model, effort: EFFORT, corpus: chunk, cacheCorpus: false, documents: docs, instruction, maxTokens: MAX_TOKENS, fallbacks: true }, FACTS_TOOL)
              .catch((e) => { usage = addUsage(usage, usageOf(e)); calls++; throw e; });
            usage = addUsage(usage, res.usage);
            calls++;
            parts.push(parseFactsOutput(res.tool!.input, factsIndex));
          }
        }
      } else {
        const res = await callTool(llm, {
          model, effort: EFFORT, corpus: plan.factsCorpus, cacheCorpus: sharedCache,
          documents: documents.length ? documents : undefined,
          instruction: factsInstruction(FACTS_INSTRUCTION, known, { documents: documents.length > 0 }), maxTokens: MAX_TOKENS, fallbacks: true,
        }, FACTS_TOOL)
          .catch((e) => { usage = addUsage(usage, usageOf(e)); calls++; throw e; });
        usage = res.usage;
        calls = 1;
        parts.push(parseFactsOutput(res.tool!.input, factsIndex));
      }
      const stored = await storeFacts(db, accountId, factsIndex, mergeFactsResults(parts), { scope: plan.factsScope, rules: factsRules(model), known });
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
          model: plan.model, effort: EFFORT, corpus, cacheCorpus: sharedCache, instruction: playbookInstruction(data), maxTokens: MAX_TOKENS, fallbacks: true,
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
export async function analyzeSources(
  db: Db, llm: PipelineLlm, accountId: string, opts: { token?: string; now?: Date; full?: boolean; store?: FileStore | null } = {},
): Promise<AnalysisResult> {
  const plan = await planAnalysis(db, accountId, process.env, { full: opts.full, store: opts.store });
  if (!plan) throw new PipelineRefused("nothing", "Add a source first.");
  const runs = await startAnalysis(db, accountId, plan, opts);
  return executeAnalysis(db, llm, accountId, plan, runs, { store: opts.store });
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

/**
 * Suggested facts that differ from an approved fact, waiting for the seller:
 * suggested fact id -> the approved fact. Only while the suggestion is still
 * suggested and the other fact still approved. Newest run first: the first
 * record of a fact wins.
 */
export async function openFactConflicts(db: Db, accountId: string): Promise<Map<string, typeof knowledgeFacts.$inferSelect>> {
  const runs = await doneFactsRuns(db, accountId);
  const all = runs.flatMap((r) => factsResult(r)?.conflicts ?? []).filter((c) => isUuid(c.factId) && isUuid(c.approvedFactId));
  const out = new Map<string, typeof knowledgeFacts.$inferSelect>();
  if (all.length === 0) return out;
  const ids = [...new Set(all.flatMap((c) => [c.factId, c.approvedFactId]))];
  const facts = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, accountId), inArray(knowledgeFacts.id, ids)));
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const c of all) {
    if (out.has(c.factId)) continue;
    const suggested = byId.get(c.factId);
    const approved = byId.get(c.approvedFactId);
    if (suggested?.status === "suggested" && approved?.status === "approved") out.set(c.factId, approved);
  }
  return out;
}

/**
 * When and by whom an approved fact was approved, for the conflict card:
 * - recorded: the newest audit row that approved this fact on its own
 *   (Approve, Replace the approved fact), with the user who clicked;
 * - else a fact added by hand (approved on add): when and by whom it was added;
 * - else (Approve all, a contradiction choice: no per-fact record) only when it was added.
 * Only the first name is returned, never an email.
 */
export type ApprovalInfo = { kind: "approved" | "added"; at: Date; userId: string | null; firstName: string | null };
export async function approvalInfo(
  db: Db, accountId: string, facts: Pick<typeof knowledgeFacts.$inferSelect, "id" | "createdAt" | "createdByUserId">[],
): Promise<Map<string, ApprovalInfo>> {
  const out = new Map<string, ApprovalInfo>();
  if (facts.length === 0) return out;
  const rows = await db.select({ targetId: auditLog.targetId, at: auditLog.createdAt, userId: auditLog.actorUserId, firstName: users.firstName })
    .from(auditLog).leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(
      eq(auditLog.accountId, accountId),
      inArray(auditLog.action, ["knowledge.fact_approved", "knowledge.fact_replaced"]),
      inArray(auditLog.targetId, facts.map((f) => f.id)),
    ))
    .orderBy(desc(auditLog.createdAt));
  for (const r of rows) if (r.targetId && !out.has(r.targetId)) out.set(r.targetId, { kind: "approved", at: r.at, userId: r.userId, firstName: r.firstName });
  const adders = [...new Set(facts.filter((f) => !out.has(f.id) && f.createdByUserId).map((f) => f.createdByUserId!))];
  const names = new Map(adders.length
    ? (await db.select({ id: users.id, firstName: users.firstName }).from(users).where(inArray(users.id, adders))).map((u) => [u.id, u.firstName])
    : []);
  for (const f of facts) {
    if (out.has(f.id)) continue;
    out.set(f.id, f.createdByUserId
      ? { kind: "approved", at: f.createdAt, userId: f.createdByUserId, firstName: names.get(f.createdByUserId) ?? null }
      : { kind: "added", at: f.createdAt, userId: null, firstName: null });
  }
  return out;
}

/**
 * The seller's choice on a suggestion that differs from an approved fact.
 * "replace": the suggestion is approved and the approved fact retired
 * (status rejected: the row and its source link stay, so the history is
 * kept), in one write. "keep": the suggestion is rejected. False when the
 * suggestion is not (or no longer) open for this account.
 */
export async function resolveFactConflict(
  db: Db, actor: Actor, accountId: string, input: { factId: string; choice: "replace" | "keep" },
): Promise<boolean> {
  if (!isUuid(input.factId)) return false;
  const approved = (await openFactConflicts(db, accountId)).get(input.factId);
  if (!approved) return false;
  const one = (id: string) => and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.id, id));
  if (input.choice === "replace") {
    await atomic(db, (q) => [
      q.update(knowledgeFacts).set({ status: "approved" }).where(and(one(input.factId), eq(knowledgeFacts.status, "suggested"))),
      q.update(knowledgeFacts).set({ status: "rejected" }).where(and(one(approved.id), eq(knowledgeFacts.status, "approved"))),
    ]);
  } else {
    await db.update(knowledgeFacts).set({ status: "rejected" }).where(and(one(input.factId), eq(knowledgeFacts.status, "suggested")));
  }
  await writeAudit(db, actor, {
    accountId, action: input.choice === "replace" ? "knowledge.fact_replaced" : "knowledge.fact_kept",
    targetType: "knowledge_fact", targetId: input.factId,
    details: { approvedFactId: approved.id, approvedStatement: approved.statement.slice(0, 300) },
  });
  return true;
}

/**
 * Approves every suggested fact (of one topic, or all), except facts in an
 * open contradiction and facts that differ from an approved fact (both wait
 * for the seller's choice). Returns how many.
 */
export async function approveAllSuggestedFacts(db: Db, accountId: string, topic?: string): Promise<number> {
  const held = [...(await contradictedFactIds(db, accountId)), ...(await openFactConflicts(db, accountId)).keys()];
  const rows = await db.update(knowledgeFacts).set({ status: "approved" }).where(and(
    eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "suggested"),
    topic ? eq(knowledgeFacts.topic, topic) : undefined,
    held.length ? sql`${knowledgeFacts.id} not in (${sql.join(held.map((id) => sql`${id}::uuid`), sql`, `)})` : undefined,
  )).returning({ id: knowledgeFacts.id });
  return rows.length;
}

/** Questions the sources do not answer (latest analysis), minus the ones answered since. */
export async function sourceGaps(db: Db, accountId: string): Promise<Gap[]> {
  // A run that read only the changed sources adds to the gaps of the runs before it, back to the last one that read all.
  const gaps: Gap[] = [];
  const seen = new Set<string>();
  for (const run of await doneFactsRuns(db, accountId)) {
    const r = factsResult(run);
    for (const g of r?.gaps ?? []) {
      const k = normalizeQuestion(g.question);
      if (!seen.has(k)) { seen.add(k); gaps.push(g); }
    }
    if (r?.scope !== "changed") break;
  }
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

/** Open (undecided) suggestions of the latest run per play: how many facts, and whether an own card is suggested. */
export async function pendingPlaySuggestions(db: Db, accountId: string): Promise<Map<PlayKey, { facts: number; card: boolean }>> {
  const { items } = await latestSuggestions(db, accountId);
  const out = new Map<PlayKey, { facts: number; card: boolean }>();
  for (const s of items) {
    if (s.status !== "suggested" || (s.payload.kind !== "play_content" && s.payload.kind !== "play_card")) continue;
    const c = out.get(s.payload.play) ?? { facts: 0, card: false };
    if (s.payload.kind === "play_content") c.facts++;
    else c.card = true;
    out.set(s.payload.play, c);
  }
  return out;
}

/** The latest run's suggestions for one play (any status), for the play page. */
export async function playSuggestions(db: Db, accountId: string, play: PlayKey): Promise<Suggestion[]> {
  const { items } = await latestSuggestions(db, accountId);
  return items.filter((s) => (s.payload.kind === "play_content" || s.payload.kind === "play_card") && s.payload.play === play);
}

/** The open catalog-item suggestion of the latest run for one SKU, if any (the item editor shows it). */
export async function pendingCatalogSuggestion(db: Db, accountId: string, sku: string): Promise<(Suggestion & { payload: CatalogItemPayload }) | null> {
  const { items } = await latestSuggestions(db, accountId);
  const s = items.find((x) => x.status === "suggested" && x.payload.kind === "catalog_item" && x.payload.sku === sku.toUpperCase());
  return (s as (Suggestion & { payload: CatalogItemPayload }) | undefined) ?? null;
}

/**
 * The seller used a suggested item text on the item page and saved the item:
 * the suggestion counts as accepted with changes ("edited") and is not
 * applied again (the item save already wrote the texts). Only an open
 * catalog-item suggestion of this account for that SKU.
 */
export async function acceptCatalogSuggestionFromItem(db: Db, actor: Actor, accountId: string, id: string, sku: string, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [raw] = await db.select().from(playbookSuggestions).where(suggestionWhere(accountId, id));
  if (!raw) return false;
  const s = asSuggestion(raw);
  if (s.status !== "suggested" || s.payload.kind !== "catalog_item" || s.payload.sku !== sku.toUpperCase()) return false;
  await db.update(playbookSuggestions).set({ status: "edited", decidedByUserId: actor.userId, decidedAt: now }).where(suggestionWhere(accountId, id));
  await writeAudit(db, actor, { accountId, action: "playbook.suggestion_edited", targetType: "playbook_suggestion", targetId: id, details: { kind: s.kind, from: "catalog_item" } });
  return true;
}

/**
 * "Edit first" on a suggested own card: the seller edited it on the play page
 * and saved it as their own card. The suggestion records the saved card and
 * counts as accepted with changes, so a later "Save as agent draft" merges the
 * same card. Only an open play-card suggestion of this account for that play.
 */
export async function adoptPlayCardSuggestion(db: Db, actor: Actor, accountId: string, id: string, play: PlayKey, card: { when: string; do: string[]; example: string; notThis: string }): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [raw] = await db.select().from(playbookSuggestions).where(suggestionWhere(accountId, id));
  if (!raw) return false;
  const s = asSuggestion(raw);
  if (s.status !== "suggested" || s.payload.kind !== "play_card" || s.payload.play !== play) return false;
  const r = await editSuggestion(db, actor, accountId, id, { when: card.when, do: card.do.join("\n"), example: card.example, notThis: card.notThis });
  return r.ok;
}

function suggestionWhere(accountId: string, id: string) {
  return and(eq(playbookSuggestions.accountId, accountId), eq(playbookSuggestions.id, id));
}

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
  // The topics (one per line) are checked in editSuggestion.
  opener: [{ name: "openingQuestion", max: 200, required: false }, { name: "openingQuestionHe", max: 200, required: false }],
  play_content: [{ name: "content", max: 600, required: true }],
  // The moves ("do", one per line) are checked with parsePlayCard.
  play_card: [{ name: "when", max: 200, required: true }, { name: "example", max: 300, required: true }, { name: "notThis", max: 300, required: true }],
  catalog_item: [{ name: "plainName", max: 60, required: false }, { name: "valueLine", max: VALUE_LINE_INPUT_MAX, required: false }],
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
  // A discovery question is asked in chat: its role is needed for the quote or helps the pitch.
  if (kind === "discovery_question" && ["before_quote", "optional"].includes(values.stage ?? "")) payload.stage = values.stage;
  if (kind === "opener") {
    // Topics: one English topic per line; a topic kept as it was keeps its Hebrew version.
    const before = openerPayloadTopics(row.payload as OpenerPayload);
    const lines = (values.topics ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (lines.length > MAX_OPENER_TOPICS) return { ok: false, error: "topics" };
    if (lines.some((l) => l.length > OPENER_MAX.leadsAskAbout)) return { ok: false, error: "too_long" };
    if (lines.some((l) => !writtenIn(l, "en"))) return { ok: false, error: "language" };
    const he = String(payload.openingQuestionHe ?? "");
    if (he && !writtenIn(he, "he")) return { ok: false, error: "language" };
    if (String(payload.openingQuestion ?? "") && !writtenIn(String(payload.openingQuestion), "en")) return { ok: false, error: "language" };
    payload.topics = [...new Map(lines.map((en) => [en.toLowerCase(), { en, ...(before.find((b) => b.en === en)?.he ? { he: before.find((b) => b.en === en)!.he } : {}) }])).values()];
    payload.leadsAskAbout = lines[0] ?? "";
    if (!payload.openingQuestionHe || !payload.openingQuestion) delete payload.openingQuestionHe;
    if (!payload.leadsAskAbout && !payload.openingQuestion) return { ok: false, error: "required" };
  }
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

/** Per source fact counts by status, and the total found (one grouped query). */
export type SourceFactCounts = { suggested: number; approved: number; rejected: number; total: number };

/** Per source: how many of its facts are suggested, approved and rejected, and how many were found in all. */
export async function sourceFactCounts(db: Db, accountId: string): Promise<Map<string, SourceFactCounts>> {
  const rows = await db
    .select({ sourceId: knowledgeFacts.sourceId, status: knowledgeFacts.status, n: sql<string>`count(*)` })
    .from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), isNotNull(knowledgeFacts.sourceId)))
    .groupBy(knowledgeFacts.sourceId, knowledgeFacts.status);
  const out = new Map<string, SourceFactCounts>();
  for (const r of rows) {
    const c = out.get(r.sourceId!) ?? { suggested: 0, approved: 0, rejected: 0, total: 0 };
    const n = Number(r.n);
    if (r.status === "suggested") c.suggested += n;
    if (r.status === "approved") c.approved += n;
    if (r.status === "rejected") c.rejected += n;
    c.total += n;
    out.set(r.sourceId!, c);
  }
  return out;
}

/**
 * The status a source shows: "approved" instead of "ready" when its facts are
 * all reviewed and one is approved. A source changed since the last analysis
 * (`changed`: text_hash cleared by an edit or a new read) shows "ready"
 * ("Ready for review") again, even while its earlier facts stay approved.
 * A read source that no analysis has looked at yet (`changed` and no facts of
 * any status) shows "not_analyzed" ("Not analyzed yet"), not "Ready for review".
 */
export function sourceDisplayStatus<S extends string>(
  status: S, counts: { suggested: number; approved: number; total?: number } | undefined, opts: { changed?: boolean } = {},
): S | "approved" | "not_analyzed" {
  if (opts.changed) return status === "ready" && !(counts && (counts.total ?? counts.suggested + counts.approved) > 0) ? "not_analyzed" : status;
  return status === "ready" && counts && counts.suggested === 0 && counts.approved > 0 ? "approved" : status;
}
