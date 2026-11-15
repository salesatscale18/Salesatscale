/** Knowledge rules (pure; unit-tested). */

export const FACT_STATUSES = ["suggested", "approved", "rejected"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const QUESTION_PREFIX = "Buyer question: ";
const QUESTION_KEY_LEN = 150;

/** Same question, whatever the case, spacing or end punctuation. */
export function normalizeQuestion(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?.!؟]+$/u, "").slice(0, QUESTION_KEY_LEN);
}

/** The source label of a fact written to answer a buyer question; it is how the question counts as answered. */
export function questionSourceLabel(question: string): string {
  return `${QUESTION_PREFIX}${question.replace(/\s+/g, " ").trim()}`.slice(0, 200);
}

/** The normalized question a source label answers, or null when the fact did not come from one. */
export function answeredQuestionKey(sourceLabel: string | null | undefined): string | null {
  if (!sourceLabel?.startsWith(QUESTION_PREFIX)) return null;
  const key = normalizeQuestion(sourceLabel.slice(QUESTION_PREFIX.length));
  return key || null;
}

export type FactInput = { topic: string; statement: string; sourceLabel: string | null };

/** Validates a fact typed by a person. */
export function parseFactInput(raw: { topic?: string; statement?: string; source?: string }): { ok: true; value: FactInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const topic = (raw.topic ?? "").replace(/\s+/g, " ").trim();
  const statement = (raw.statement ?? "").trim();
  const source = (raw.source ?? "").trim();
  if (!topic) errors.topic = "Choose a topic or type a new one.";
  else if (topic.length > 60) errors.topic = "Use 60 characters or fewer.";
  if (!statement) errors.statement = "Write the fact.";
  else if (statement.length > 1000) errors.statement = "Use 1,000 characters or fewer.";
  if (source.length > 200) errors.source = "Use 200 characters or fewer.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { topic, statement, sourceLabel: source || null } };
}

export function isFactStatus(v: unknown): v is FactStatus {
  return typeof v === "string" && (FACT_STATUSES as readonly string[]).includes(v);
}
