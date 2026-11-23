/**
 * Stage 0 of the knowledge pipeline (no AI): one deterministic corpus
 * document from the ready sources, the run's input hash, and the token and
 * cost estimate shown before any spend. Pure; unit-tested.
 */
import { createHash } from "node:crypto";
import { estimateCostMicros, type ModelPrice, type TokenUsage } from "@/lib/ai/models";
import { PIPELINE_TOOLS, SYSTEM_PROMPT } from "./prompts/system";

export type CorpusSection = { position: number; locator: string; heading: string | null; text: string };
export type CorpusSource = {
  id: string;
  kind: string;
  title: string;
  language: string | null;
  sections: CorpusSection[];
};

/** Characters per token for estimates (a little pessimistic for English; Hebrew runs denser). */
export const CHARS_PER_TOKEN = 3.5;
export const tokensOf = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Above this, stage 1 runs per source (same model) and stage 2 gets a trimmed corpus. */
export const LARGE_CORPUS_TOKENS = 150_000;
/** One stage-1 request reads at most this much of a source on the large path (keeps each reply within the output limit). */
export const CHUNK_TOKENS = 90_000;
/** The trimmed corpus stage 2 reads on the large path. */
export const TRIMMED_CORPUS_TOKENS = 100_000;

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\s+/g, " ").trim();
/** Text keeps its characters (quotes are copied from it); only tag-like closers are broken up. */
const body = (s: string) => s.replace(/<(\/?)(section|source|corpus)\b/gi, "< $1$2");

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function sourceXml(s: CorpusSource, sections: CorpusSection[]): string {
  const parts = [...sections].sort((a, b) => a.position - b.position).map((x) =>
    `<section source="${s.id}" locator="${attr(x.locator)}"${x.heading ? ` heading="${attr(x.heading)}"` : ""}>\n${body(x.text)}\n</section>`);
  return `<source id="${s.id}" kind="${s.kind}" title="${attr(s.title)}" language="${attr(s.language ?? "")}">\n${parts.join("\n")}\n</source>`;
}

/** The corpus: sources by id, sections by position, every section tagged with its source and locator. */
export function assembleCorpus(sources: CorpusSource[]): string {
  return `<corpus>\n${[...sources].sort(byId).map((s) => sourceXml(s, s.sections)).join("\n")}\n</corpus>`;
}

/**
 * One source as its own corpus, cut into pieces of at most `maxTokens` (by
 * whole sections) for the large path of stage 1.
 */
export function sourceChunks(s: CorpusSource, maxTokens = CHUNK_TOKENS): string[] {
  const sorted = [...s.sections].sort((a, b) => a.position - b.position);
  const chunks: CorpusSection[][] = [];
  let cur: CorpusSection[] = [];
  let used = 0;
  for (const x of sorted) {
    const n = tokensOf(x.text) + 20;
    if (cur.length && used + n > maxTokens) { chunks.push(cur); cur = []; used = 0; }
    cur.push(x);
    used += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => `<corpus>\n${sourceXml(s, c)}\n</corpus>`);
}

/**
 * A smaller corpus for stage 2 on the large path: call transcripts first (how
 * the seller actually sells), then the other sources, section by section in
 * order, until the budget is used. Same order and tags as assembleCorpus.
 */
export function trimCorpus(sources: CorpusSource[], maxTokens = TRIMMED_CORPUS_TOKENS): CorpusSource[] {
  const sorted = [...sources].sort(byId);
  const order = [...sorted.filter((s) => s.kind === "call"), ...sorted.filter((s) => s.kind !== "call")];
  const keep = new Map<string, CorpusSection[]>();
  let used = 0;
  outer: for (const s of order) {
    for (const x of [...s.sections].sort((a, b) => a.position - b.position)) {
      const n = tokensOf(x.text) + 20;
      if (used + n > maxTokens) break outer;
      used += n;
      keep.set(s.id, [...(keep.get(s.id) ?? []), x]);
    }
  }
  return sorted.filter((s) => keep.has(s.id)).map((s) => ({ ...s, sections: keep.get(s.id)! }));
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** JSON with object keys sorted, so equal data always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The hash a run is reused by: prompt versions, model, corpus and the stage's data. */
export function inputHash(parts: { versions: string[]; model: string; corpus: string; data?: unknown }): string {
  return sha256(stable({ versions: parts.versions, model: parts.model, corpus: sha256(parts.corpus), data: parts.data ?? null }));
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

/** System text and tool schemas: the fixed prefix in front of every corpus. */
export const PREFIX_TOKENS = tokensOf(SYSTEM_PROMPT) + tokensOf(JSON.stringify(PIPELINE_TOOLS));
/** Thinking at medium effort, billed as output. */
export const THINKING_TOKENS = 2_000;
/** The stage 1 instruction after the breakpoint (KQ3 facts-v4: about 1,140 tokens; known facts are counted apart). */
export const INSTRUCTION_TOKENS = 1_150;
/** Facts written per corpus token, plus a fixed part (contradictions, gaps, about lines). */
export const factsOutputTokens = (corpusTokens: number, max = 32_000) => Math.min(max, THINKING_TOKENS + 1_000 + Math.ceil(corpusTokens * 0.08));
/** P11 added the opener, play facts and own cards, and catalog item texts to stage 2 (about 2,500 more output tokens). */
export const PLAYBOOK_OUTPUT_TOKENS = THINKING_TOKENS + 6_500;
/** Stage 2's instruction with the play list (P11; 19 plays since O1; KQ3 playbook-v7 about 2,320): larger than the facts instruction. */
export const PLAYBOOK_INSTRUCTION_TOKENS = 2_350;

export type StageEstimate = { stage: "facts" | "playbook"; model: string; calls: number; usage: Required<TokenUsage>; costMicros: number };
export type AnalysisEstimate = { stages: StageEstimate[]; tokens: number; costMicros: number };

const zero = (): Required<TokenUsage> => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 });
const total = (u: Required<TokenUsage>) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.cacheWrite1hTokens;

/**
 * What a run will cost, before any call. Stage 1 reads the facts corpus (only
 * the new or changed sources after a first analysis; see planAnalysis), stage 2
 * the whole corpus. When both read the same corpus and both run, stage 1
 * writes the cache (system, tools and corpus) and stage 2 reads it; otherwise
 * the corpus is not cached (nothing would read it) and only the small system
 * prefix is written, then read by the next call. Large facts corpus: stage 1
 * per source chunk on the same model. Large whole corpus: stage 2 on the
 * trimmed corpus.
 */
export function estimateAnalysis(p: {
  /** The whole corpus (stage 2). */
  corpusTokens: number;
  /** The corpus stage 1 reads; the whole corpus when left out. */
  factsCorpusTokens?: number;
  /** Stage 1 and stage 2 read the same corpus (true when factsCorpusTokens is left out). */
  sharedCorpus?: boolean;
  /** Large facts corpus only: tokens of each chunk. */
  chunkTokens?: number[];
  /** Large whole corpus only: tokens of the trimmed corpus. */
  trimmedTokens?: number;
  runFacts: boolean;
  runPlaybook: boolean;
  /** Facts, catalog and playbook JSON already known for stage 2. */
  dataTokens: number;
  /** The approved facts sent with the stage 1 instruction. */
  knownFactsTokens?: number;
  /** PDFs stage 1 also reads as pages (uncached input, sent once). */
  documentTokens?: number;
  model: string;
  prices?: Record<string, ModelPrice>;
}): AnalysisEstimate {
  const factsTokens = p.factsCorpusTokens ?? p.corpusTokens;
  const shared = p.factsCorpusTokens === undefined ? true : (p.sharedCorpus ?? false);
  const factsLarge = factsTokens > LARGE_CORPUS_TOKENS;
  const large = p.corpusTokens > LARGE_CORPUS_TOKENS;
  const known = p.knownFactsTokens ?? 0;
  const cacheCorpus = shared && p.runFacts && p.runPlaybook && !large && !factsLarge;
  const stages: StageEstimate[] = [];
  let newFactTokens = 0;
  if (p.runFacts) {
    const u = zero();
    if (factsLarge) {
      const chunks = p.chunkTokens?.length ? p.chunkTokens : [factsTokens];
      chunks.forEach((c, i) => {
        if (i === 0) u.cacheWriteTokens += PREFIX_TOKENS; else u.cacheReadTokens += PREFIX_TOKENS;
        u.inputTokens += c + INSTRUCTION_TOKENS + known;
        u.outputTokens += factsOutputTokens(c);
      });
      u.inputTokens += p.documentTokens ?? 0;
      newFactTokens = chunks.reduce((s, c) => s + factsOutputTokens(c) - THINKING_TOKENS, 0);
      stages.push({ stage: "facts", model: p.model, calls: chunks.length, usage: u, costMicros: estimateCostMicros(p.model, u, p.prices) ?? 0 });
    } else {
      u.cacheWriteTokens = PREFIX_TOKENS + (cacheCorpus ? factsTokens : 0);
      u.inputTokens = INSTRUCTION_TOKENS + known + (p.documentTokens ?? 0) + (cacheCorpus ? 0 : factsTokens);
      u.outputTokens = factsOutputTokens(factsTokens);
      newFactTokens = u.outputTokens - THINKING_TOKENS;
      stages.push({ stage: "facts", model: p.model, calls: 1, usage: u, costMicros: estimateCostMicros(p.model, u, p.prices) ?? 0 });
    }
  }
  if (p.runPlaybook) {
    const u = zero();
    const data = PLAYBOOK_INSTRUCTION_TOKENS + p.dataTokens + Math.ceil(newFactTokens * 0.6);
    const corpus = large ? (p.trimmedTokens ?? Math.min(p.corpusTokens, TRIMMED_CORPUS_TOKENS)) : p.corpusTokens;
    if (cacheCorpus) { u.cacheReadTokens = PREFIX_TOKENS + p.corpusTokens; u.inputTokens = data; }
    else {
      // Stage 1 just wrote the system prefix: stage 2 reads it.
      if (p.runFacts) u.cacheReadTokens = PREFIX_TOKENS; else u.cacheWriteTokens = PREFIX_TOKENS;
      u.inputTokens = corpus + data;
    }
    u.outputTokens = PLAYBOOK_OUTPUT_TOKENS;
    stages.push({ stage: "playbook", model: p.model, calls: 1, usage: u, costMicros: estimateCostMicros(p.model, u, p.prices) ?? 0 });
  }
  return { stages, tokens: stages.reduce((s, x) => s + total(x.usage), 0), costMicros: stages.reduce((s, x) => s + x.costMicros, 0) };
}
