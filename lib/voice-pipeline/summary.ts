/**
 * What the test lab shows about a pipeline call ("This call": Engine, the three models, the median answer time),
 * read from the session's settings and usage JSON (voice_sessions.settings.pipeline, usage.pipeline). Pure and
 * import-safe from client code.
 */
export type PipelineCallInfo = {
  listenModel: string;
  thinkModel: string;
  speakModel: string;
  /** null while the call runs (or before any answer). */
  medianAnswerMs: number | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The pipeline info of a session (its settings and usage JSON), or null when the call was not a pipeline call. */
export function pipelineCallInfo(settings: unknown, usage: unknown): PipelineCallInfo | null {
  const s = settings && typeof settings === "object" ? (settings as { engine?: unknown; pipeline?: Record<string, unknown> }) : null;
  if (s?.engine !== "pipeline") return null;
  const p = s.pipeline ?? {};
  const u = usage && typeof usage === "object" ? ((usage as { pipeline?: Record<string, unknown> }).pipeline ?? {}) : {};
  return {
    listenModel: str(p.listenModel) || str(u.listenModel), thinkModel: str(p.thinkModel) || str(u.thinkModel), speakModel: str(p.speakModel) || str(u.speakModel),
    medianAnswerMs: num(u.medianAnswerMs),
  };
}

/** "Listen <model> · think <model> · speak <model>" (the call card's model line while the call starts). */
export function pipelineModelsLabel(p: Pick<PipelineCallInfo, "listenModel" | "thinkModel" | "speakModel">): string {
  return `Listen ${p.listenModel || "?"} · think ${p.thinkModel || "?"} · speak ${p.speakModel || "?"}`;
}
