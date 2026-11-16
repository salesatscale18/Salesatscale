/**
 * Stage 1 (facts): the instruction sent after the cached corpus. Stable text;
 * bump PROMPT_VERSION on any change (it is part of the run's input hash).
 */
import { FACTS_TOOL } from "./system";

export const PROMPT_VERSION = "facts-v1";

const COMMON = `- facts: every general fact a buyer could ask about: what the products and services are and do (and do not do), specifications, compatibility, installation, delivery and lead times, warranty, support, contract and payment terms, compliance and certifications, and the company itself. One sentence per fact, in the language of its source.
- Leave out catalog prices (the catalog and price lists hold prices) and any price, discount or special term heard in a call.
- Leave out anything about one particular customer; list it under customer_specific instead.
- contradictions: when sources disagree about the same thing (for example a 12-month and a 24-month warranty), list it once with each conflicting statement and its evidence. Do not also put those statements in facts.
- gaps: up to 10 questions buyers are likely to ask, or asked in a call, that the material does not answer.
- source_about: one entry for every source, 3 to 6 English words on what it covers.`;

/** The instruction for the whole corpus (cached path). */
export const FACTS_INSTRUCTION = `Task: extract the knowledge in the corpus above. Call ${FACTS_TOOL} once.
${COMMON}`;

/** The instruction for one source at a time (large-corpus path, light model). */
export const FACTS_ONE_SOURCE_INSTRUCTION = `Task: extract the knowledge in the one source above. Call ${FACTS_TOOL} once.
${COMMON}
- This is one source of several: report contradictions only inside this source.`;
