/**
 * What the test lab shows about a pipeline call ("This call": Engine, the three models, the median answer and thinking times),
 * read from the session's settings and usage JSON (voice_sessions.settings.pipeline, usage.pipeline). Pure and
 * import-safe from client code.
 */
export type PipelineCallInfo = {
  listenModel: string;
  thinkModel: string;
  speakModel: string;
  /** null while the call runs (or before any answer heard). */
  medianAnswerMs: number | null;
  /** Median thinking time of the answered turns, spoken or not (null while the call runs, or before any answer). */
  medianThinkMs: number | null;
  /** Median model rounds per answered turn, and median time per round (null: not reported, e.g. an older call). */
  medianRounds: number | null;
  medianRoundMs: number | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The pipeline info of a session (its settings and usage JSON), or null when the call was not a pipeline call. */
export function pipelineCallInfo(settings: unknown, usage: unknown): PipelineCallInfo | null {
  const s = settings && typeof settings === "object" ? (settings as { engine?: unknown; pipeline?: Record<string, unknown> }) : null;
  if (s?.engine !== "pipeline" && s?.engine !== "pipeline_chat") return null;
  const p = s.pipeline ?? {};
  const u = usage && typeof usage === "object" ? ((usage as { pipeline?: Record<string, unknown> }).pipeline ?? {}) : {};
  return {
    // Speaking: the model the call kept (usage, written at the end), else the first one tried (settings, at the start).
    listenModel: str(p.listenModel) || str(u.listenModel), thinkModel: str(p.thinkModel) || str(u.thinkModel), speakModel: str(u.speakModel) || str(p.speakModel),
    medianAnswerMs: num(u.medianAnswerMs), medianThinkMs: num(u.medianThinkMs),
    medianRounds: num(u.medianRounds), medianRoundMs: num(u.medianRoundMs),
  };
}

/** "Listen <model> · think <model> · speak <model>" (the call card's model line while the call starts). */
export function pipelineModelsLabel(p: Pick<PipelineCallInfo, "listenModel" | "thinkModel" | "speakModel">): string {
  return `Listen ${p.listenModel || "?"} · think ${p.thinkModel || "?"} · speak ${p.speakModel || "?"}`;
}

/**
 * A thinking model id as people read it: "google/gemini-3.8-flash" → "Gemini 3.8 Flash", "claude-sonnet-5-5" →
 * "Claude Sonnet 5.5". The creator prefix is dropped, words are capitalized and consecutive numbers joined by dots.
 * Empty stays empty.
 */
export function thinkModelLabel(id: string): string {
  const name = id.trim().replace(/^[^/]+\//, "");
  if (!name) return "";
  const out: string[] = [];
  for (const part of name.split(/[-_]+/).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (/^\d+(\.\d+)*$/.test(part) && prev && /^\d+(\.\d+)*$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
    else out.push(/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1));
  }
  return out.join(" ");
}
