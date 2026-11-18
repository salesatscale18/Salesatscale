/**
 * Automatic versions of the agent's name (C2, 18 Nov): the name transliterated
 * (not translated) into each buyer language's script, e.g. a Latin name into
 * Hebrew and Arabic letters. Made once when the agent name or the market
 * languages change (on playbook save, and lazily when the Playbook page sees a
 * stale `source` or a missing language), stored in the draft playbook
 * (`Playbook.agentNameAuto`), and only read afterwards (lib/agent/core/names.ts):
 * never per message.
 *
 * One small call per generation, on the light pipeline model, through the
 * agent's LlmClient wrapped in budgetGuarded, returning JSON for every missing
 * language at once. The output is checked in code (script, length, letters).
 * When the model is unavailable, refuses, is over budget or fails, those
 * languages are marked `asWritten`: buyers see the name as typed and the page
 * says so. Tests use ScriptedLlm only.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, markets, sellerAccounts, type Playbook } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { estimateCostMicros, modelFor } from "@/lib/ai/models";
import { budgetGuarded, spendState } from "@/lib/ai/usage";
import { sanitizeOverrides } from "@/lib/markets/settings";
import { languageName, languageScript, nameLanguages, textScript, typedLanguage, writtenInScript } from "./core/names";
import { AnthropicLlm, llmConfigured, type Block, type LlmClient, type LlmResponse } from "./llm";
import { ensureDraftVersion } from "./service";

export const AUTO_NAME_MAX = 60;
/** Output budget of one generation: a short JSON object. */
export const AUTO_NAME_MAX_TOKENS = 300;

/** The fixed instruction (system block 1). No seller data in it. */
export const AUTO_NAME_INSTRUCTION = `You write a person's name in other writing systems for a sales chat app.
Transliterate, never translate: write how the name sounds, in the script of each language asked for. For example "Daniel" in Hebrew is "דניאל" and in Arabic "دانيال".
Keep every part of the name and nothing else: no titles, no quotes, no notes.
Reply with only a JSON object that maps each language code asked for to the name in that language's script, for example {"he": "דניאל"}.`;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const NAME_CHARS = /^[\p{L}\p{M}' ’.\-]+$/u;

/** The per-call data (system block 2): the name and the languages, each with its script. */
export function autoNameRequestText(name: string, languages: readonly string[]): string {
  return `Name: ${name}\nLanguages: ${languages.map((l) => `${l} (${languageName(l)}, ${languageScript(l)} script)`).join("; ")}`;
}

/** The text blocks of a reply, joined. */
const replyText = (content: Block[]) => content.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string").map((b) => b.text).join("\n");

/**
 * Reads the model's JSON and keeps only valid names: a string for a language
 * asked for, one line, at most AUTO_NAME_MAX characters, only letters (and
 * spaces, hyphens, apostrophes, dots), in that language's script.
 */
export function parseAutoNames(text: string, languages: readonly string[]): Partial<Record<string, string>> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<string, string>> = {};
  for (const lang of languages) {
    const v = clean((parsed as Record<string, unknown>)[lang]);
    if (!v || v.length > AUTO_NAME_MAX || !NAME_CHARS.test(v) || !writtenInScript(v, lang)) continue;
    out[lang] = v;
  }
  return out;
}

export type AutoNamesResult = {
  values: Partial<Record<string, string>>;
  /** Languages with no valid automatic version: buyers see the name as written. */
  asWritten: string[];
  /** Why nothing could be made, when the model was not used or failed. */
  reason: "ok" | "unavailable" | "over_budget" | "failed" | "invalid";
  usage: LlmResponse["usage"] | null;
  model: string | null;
};

/**
 * One generation for `languages` (all need a script other than the name's).
 * Never throws: every failure means "as written" for the languages concerned.
 */
export async function generateAutoNames(db: Db, llm: LlmClient | null, accountId: string, name: string, languages: readonly string[], env: Record<string, string | undefined> = process.env): Promise<AutoNamesResult> {
  const none = (reason: AutoNamesResult["reason"], usage: AutoNamesResult["usage"] = null, model: string | null = null): AutoNamesResult => ({ values: {}, asWritten: [...languages], reason, usage, model });
  if (!languages.length) return { values: {}, asWritten: [], reason: "ok", usage: null, model: null };
  if (!llm) return none("unavailable");
  // The account's own spend cap: at the cap no new model calls.
  if ((await spendState(db, accountId))?.state === "capped") return none("over_budget");
  const model = modelFor("pipeline_light", env);
  let res: LlmResponse;
  try {
    res = await budgetGuarded(db, llm).create({
      model, effort: "low", maxTokens: AUTO_NAME_MAX_TOKENS, fallbacks: false, tools: [],
      system: [AUTO_NAME_INSTRUCTION, autoNameRequestText(name, languages)],
      messages: [{ role: "user", content: "Write the name in each language as JSON." }],
    });
  } catch (e) {
    return none((e as Error)?.name === "AiBudgetError" ? "over_budget" : "failed");
  }
  if (res.stopReason === "refusal") return none("failed", res.usage, res.model);
  const values = parseAutoNames(replyText(res.content), languages);
  const asWritten = languages.filter((l) => !values[l]);
  return { values, asWritten, reason: asWritten.length === languages.length ? "invalid" : "ok", usage: res.usage, model: res.model };
}

/** The model client for automatic names: the real one only when an API key is configured. */
export function autoNameModel(): LlmClient | null {
  return llmConfigured() ? new AnthropicLlm() : null;
}

/** The languages of the account's markets (a market without its own languages follows the account), else the account's. */
export async function marketLanguages(db: Db, accountId: string): Promise<{ markets: string[][]; account: string[] }> {
  const [acc] = await db.select({ languages: sellerAccounts.languages }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const account = acc?.languages ?? [];
  const rows = await db.select({ overrides: markets.overrides }).from(markets).where(eq(markets.accountId, accountId));
  return { markets: rows.map((r) => sanitizeOverrides(r.overrides).languages ?? account), account };
}

/** The languages the agent's name gets a row for: market languages without the one it is typed in. */
export async function agentNameLanguages(db: Db, accountId: string, agentName: string): Promise<string[]> {
  const l = await marketLanguages(db, accountId);
  return nameLanguages(l.markets, l.account, agentName.trim() ? typedLanguage(agentName) : null);
}

/**
 * The languages that still need an automatic version: written in another
 * script than the name, without the seller's own version, and not made yet for
 * this name (or, with `retry`, marked "as written" after a failed try).
 */
export function languagesToGenerate(p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto">, languages: readonly string[], retry = false): string[] {
  const name = clean(p.agentName);
  if (!name) return [];
  const auto = p.agentNameAuto && clean(p.agentNameAuto.source) === name ? p.agentNameAuto : null;
  return languages.filter((l) => {
    if (languageScript(l) === textScript(name)) return false;
    if (clean(p.agentNameLocal?.[l])) return false;
    if (!auto) return true;
    if (clean(auto.values?.[l])) return false;
    return retry || !(auto.asWritten ?? []).includes(l);
  });
}

export type RefreshResult = { playbook: Playbook; generated: string[]; asWritten: string[]; reason: AutoNamesResult["reason"] | "nothing" };

/**
 * Makes the missing automatic versions for the account's draft and stores
 * them (only `agentNameAuto` changes, and only while the draft still has the
 * same agent name). `retry` (playbook save) also retries languages that failed
 * before; a page view does not, so a failing model is not called on every view.
 */
export async function refreshAgentNameAuto(db: Db, accountId: string, llm: LlmClient | null, opts: { actor?: Actor | null; retry?: boolean; env?: Record<string, string | undefined> } = {}): Promise<RefreshResult> {
  const draft = await ensureDraftVersion(db, accountId);
  const p = draft.playbook;
  const name = clean(p.agentName);
  const languages = await agentNameLanguages(db, accountId, name);
  const todo = languagesToGenerate(p, languages, opts.retry);
  if (!todo.length) return { playbook: p, generated: [], asWritten: [], reason: "nothing" };
  const r = await generateAutoNames(db, llm, accountId, name, todo, opts.env);
  const prev = p.agentNameAuto && clean(p.agentNameAuto.source) === name ? p.agentNameAuto : { source: name, values: {} };
  const values = { ...prev.values, ...r.values };
  const asWritten = [...new Set([...(prev.asWritten ?? []).filter((l) => !r.values[l] && !todo.includes(l)), ...r.asWritten])];
  const next: NonNullable<Playbook["agentNameAuto"]> = { source: name, values, ...(asWritten.length ? { asWritten } : {}) };
  // Only this key, and only while the name is unchanged (a save in between wins).
  await db.update(agentVersions)
    .set({ playbook: sql`jsonb_set(${agentVersions.playbook}, '{agentNameAuto}', ${JSON.stringify(next)}::jsonb, true)` })
    .where(and(eq(agentVersions.id, draft.id), eq(agentVersions.accountId, accountId), eq(agentVersions.status, "draft"), sql`${agentVersions.playbook}->>'agentName' = ${p.agentName}`));
  if (r.usage) {
    const model = r.model ?? modelFor("pipeline_light", opts.env);
    const costMicros = estimateCostMicros(model, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens });
    await writeAudit(db, opts.actor ?? null, { accountId, action: "agent.names_generated", targetType: "agent_version", targetId: draft.id, details: { languages: todo, made: Object.keys(r.values), model, usage: r.usage, costMicros } });
  }
  return { playbook: { ...p, agentNameAuto: next }, generated: Object.keys(r.values), asWritten: r.asWritten, reason: r.reason };
}
