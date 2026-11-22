/**
 * Stage 1 (facts): the instruction sent after the cached corpus. Stable text;
 * bump PROMPT_VERSION on any change (it is part of the run's input hash).
 */
import { FACTS_TOOL } from "./system";

export const PROMPT_VERSION = "facts-v3";

const COMMON = `- facts: every general fact a buyer could ask about: what the products and services are and do (and do not do), specifications, compatibility, installation, delivery and lead times, warranty, support, contract and payment terms, compliance and certifications, and the company itself. One sentence per fact, in the language of its source.
- Also return these as facts, each with its own evidence:
  - Proof points: customers the seller names (by name or by type of business), numbers and results, testimonials, certifications, awards and guarantees. Keep the claim's own wording and figures; do not round, add to or soften them. Topic "Proof", or "Customers" for the customers the seller names. A list of customers the seller publishes as references in its own documents or website is a proof point, not a statement about one customer.
  - Value: the buyer problems the material names, and what each feature brings the buyer (what they get, save or avoid). Topic "Value".
  - Who the product suits: types and sizes of business, and the situations it is made for. Topic "Ideal customer".
  - What sets the seller apart, and every mention of competitors or alternatives (including the old way of working the material compares itself with). Topic "Differentiators".
  - Integrations and connections to systems or equipment the buyer already has. Topic "Integrations".
  - The seller's own published contact details (company phone number, website, company email address). Topic "Contact".
- A source that names a different company or brand from the rest of the corpus: do not merge its claims into the seller's facts as if they were the seller's. Name that company or brand in each fact you take from it, and add a gap asking how it relates to the seller (or a contradiction, when it conflicts with the seller's own sources).
- A number whose meaning the text does not make clear (for example a percentage with no label, or a figure without what it measures): never guess what it refers to and leave it out of facts. Add a gap asking what it means.
- Leave out catalog prices (the catalog and price lists hold prices) and any price, discount or special term heard in a call.
- Leave out anything about one particular customer; list it under customer_specific instead.
- contradictions: when sources disagree about the same thing (for example a 12-month and a 24-month warranty), list it once with each conflicting statement and its evidence. Do not also put those statements in facts.
- gaps: up to 10 questions buyers are likely to ask, or asked in a call, that the material does not answer.
- source_about: one entry for every source, 3 to 6 English words on what it covers.`;

/** The instruction for the whole corpus (cached path). */
export const FACTS_INSTRUCTION = `Task: extract the knowledge in the corpus above. Call ${FACTS_TOOL} once.
${COMMON}`;

/** The instruction for one source at a time (large-corpus path). */
export const FACTS_ONE_SOURCE_INSTRUCTION = `Task: extract the knowledge in the one source above. Call ${FACTS_TOOL} once.
${COMMON}
- This is one source of several: report contradictions only inside this source.`;

/** Most known facts sent with the instruction (the newest approved facts are kept). */
export const KNOWN_FACTS_MAX = 400;

/** The id a known fact has in the instruction ("K1" is the first known fact sent). */
export const knownFactRef = (index: number) => `K${index + 1}`;

/** The index of a known fact from its id ("K1" -> 0), or null. */
export function knownFactIndex(ref: string | undefined): number | null {
  const m = /^K(\d{1,4})$/i.exec((ref ?? "").trim());
  return m && Number(m[1]) >= 1 ? Number(m[1]) - 1 : null;
}

/** Added to the instruction when the original PDF of a source is sent after the corpus. */
export const DOCUMENTS_NOTE = `- After the corpus come the original PDF files of some sources, each naming its source id. Read them for what the text alone misses, such as slides, tables, charts and words inside pictures. Give evidence from a PDF with that source id, the page's locator ("p.N") and words from that page.`;

/**
 * The facts instruction with the seller's approved facts after it, so the
 * model does not restate them and names the one a new fact differs from (by
 * its id: K1, K2, ...). Sent after the cache breakpoint, so the corpus cache
 * is unaffected. Keys in a fixed order: the same facts give the same bytes.
 */
export function factsInstruction(base: string, known: { topic: string; statement: string }[], opts: { documents?: boolean } = {}): string {
  const head = opts.documents ? `${base}\n${DOCUMENTS_NOTE}` : base;
  if (known.length === 0) return head;
  const json = JSON.stringify(known.slice(0, KNOWN_FACTS_MAX).map((f, i) => ({ id: knownFactRef(i), topic: f.topic, statement: f.statement })));
  return `${head}
- known_facts below are facts the seller already approved, from these or other sources, each with an id. Do not return a fact that says the same thing as a known fact, in any wording or language. Do return what adds to a known fact.
- When the corpus says something different from a known fact about the same thing (another number, the opposite, or another answer to the same question), return it as a fact and set its known_fact_id to that known fact's id, so the seller can choose which one is right. Leave known_fact_id empty for every other fact.

<known_facts>
${json}
</known_facts>`;
}
