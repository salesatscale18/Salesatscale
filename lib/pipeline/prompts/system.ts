/**
 * The knowledge pipeline's shared, stable prompt (a versioned "skill"): the
 * system text and the two output tools. Both stages send these byte-identical,
 * followed by the same corpus block, so the second stage reads the first
 * stage's cache. Nothing here may contain a timestamp, an id or anything else
 * that varies per account or run. Bump PROMPT_VERSION on any change: it is part
 * of every run's input hash, so a new version re-runs instead of reusing.
 *
 * Why tools and not `output_config.format`: setting or changing a structured
 * output format between requests breaks the prompt cache (claude-api skill,
 * cost-optimization: "setting or changing a structured-output format"). The two
 * stages need different schemas, so both schemas live in one fixed tool list
 * (strict tools), and each stage's instruction, after the cache breakpoint,
 * names the tool to call. tool_choice stays "auto": forced tool choice is a 400
 * on Sonnet 5.5.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { PLAY_KEYS } from "@/db/schema";

export const PROMPT_VERSION = "system-v5";

export const FACTS_TOOL = "record_facts";
export const PLAYBOOK_TOOL = "record_playbook";

/** Most characters of an evidence quote. */
export const QUOTE_MAX = 200;

export const SYSTEM_PROMPT = `You turn a seller's own material into knowledge and a sales playbook for an AI sales agent. The agent chats with business buyers on WhatsApp, answers only from knowledge the seller approved, and leads the buyer to a signed order form and payment, or to a meeting with the seller's team.

The material is in the first user message, inside <corpus>. It holds the seller's website pages, documents, notes and transcripts of recorded sales calls. Each source is a <source id="..." kind="..." title="..." language="..."> element, and each part of a source is a <section source="SOURCE_ID" locator="LOCATOR" heading="..."> element. The source id is a UUID. The locator says where in the source the text is: a page ("p.5"), a web path ("/faq"), a sheet row, a heading, or a timestamp in a call ("06:12"). Call transcripts name the speaker at the start of a section heading (for example "Rep" or "Buyer"); personal details in transcripts are masked.

After the corpus comes a task. It tells you which tool to call. These rules apply to every task:

1. Evidence. Every item you return must be supported by the corpus. Give evidence as {source_id, locator, quote}: the source id and locator exactly as written on the <section> tag, and a quote of at most ${QUOTE_MAX} characters copied word for word from that section's text. Never invent a source, a locator or a quote. If you cannot point to evidence for an item, leave the item out.
2. General knowledge only. The agent talks to many buyers. Facts about one particular customer (their figures, losses, sites, staff, names, or the deal they were offered) are not general knowledge. Do not return them as facts; list them under customer_specific so the seller sees what was kept back.
3. Prices and discounts. Prices, discounts, free extras and special terms heard in calls are never facts, and you never change a price list. Report them only as playbook limits, which the seller must approve explicitly.
4. Personal data. Never restore masked details. Never output phone numbers, email addresses or the names of buyers.
5. Language. Write each fact in the language of the source it came from, and give that language as an ISO 639-1 code ("en", "he"). Write playbook text in English. When the evidence for a playbook item is in Hebrew, also give a natural Hebrew version in the matching *_he field; otherwise leave the *_he field as an empty string.
6. Style. One idea per fact or item. Short, concrete, plain words; no marketing tone. Do not repeat the same item in different words.
7. Output. Return the result only by calling the tool the task names, exactly once, with every required field. Do not answer in text.`;

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const obj = (properties: Record<string, unknown>, description?: string) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown, description: string) => ({ type: "array", description, items });

const EVIDENCE = arr(
  obj({
    source_id: str("The source attribute of the <section> tag, exactly."),
    locator: str("The locator attribute of the <section> tag, exactly."),
    quote: str(`Words copied from that section, at most ${QUOTE_MAX} characters.`),
  }),
  "Where this comes from. At least one entry.",
);

/** Stage 1 output: facts, contradictions, gaps and what each source is about. */
const FACTS_SCHEMA = obj({
  facts: arr(obj({
    topic: str("Short English topic, 1 to 3 words, e.g. Product, Warranty, Installation, Pricing terms, Company. Reuse the same topic words across facts."),
    statement: str("One self-contained sentence a buyer could be told, in the language of the source."),
    language: str("ISO 639-1 code of the statement, e.g. en or he."),
    customer_specific: { type: "boolean", description: "True only if the statement is about one particular customer. Prefer leaving such statements out." },
    evidence: EVIDENCE,
  }), "General facts a buyer could ask about."),
  contradictions: arr(obj({
    topic: str("Short English topic."),
    summary: str("What the sources disagree about, in English, e.g. Sensor warranty length."),
    options: arr(obj({
      statement: str("One of the conflicting statements, in the language of its source."),
      language: str("ISO 639-1 code of the statement."),
      evidence: EVIDENCE,
    }), "Two or more conflicting statements, each with its evidence."),
  }), "Places where sources disagree. Conflicting statements go here, not in facts."),
  gaps: arr(obj({
    topic: str("Short English topic."),
    question: str("A question buyers will likely ask (or asked in a call) that the corpus does not answer, in English."),
  }), "Up to 10 unanswered buyer questions."),
  source_about: arr(obj({
    source_id: str("A source id from the corpus."),
    about: str("3 to 6 English words on what the source covers, e.g. Company, all products."),
  }), "One entry for every source in the corpus."),
  customer_specific: arr(obj({
    source_id: str("The source id."),
    locator: str("The section locator."),
    note: str("What was kept back and why, in English, one sentence."),
  }), "Statements about one customer that were kept out of the facts."),
});

const PLAY = { type: "string", enum: [...PLAY_KEYS], description: "The play key, one of the keys listed under plays in the task." };

const STAGE = { type: "string", enum: ["before_quote", "before_order_form", "helpful"], description: "The question's role. before_quote: needed for the quote (the quote cannot be made without it, e.g. number of sites or items); helpful: helps the pitch (e.g. how they handle it today, current supplier); before_order_form: filled in the order form (company and signer details)." };
const ROLE = { type: "string", enum: ["before_quote", "helpful"], description: "The question's role. before_quote: needed for the quote (the quote cannot be made without the answer); helpful: helps the pitch." };

/** Stage 2 output: the playbook draft, item by item. */
const PLAYBOOK_SCHEMA = obj({
  goal: obj({ text: str("1 to 3 sentences: who the agent sells to and what a win is."), text_he: str("Hebrew version or empty."), evidence: EVIDENCE }),
  fields: arr(obj({
    key: str("snake_case key. Use the order-form keys given in the task for order-form details; reuse keys of the current playbook for the same field."),
    label: str("Short English label, e.g. Number of sites."),
    label_he: str("Hebrew label or empty."),
    stage: STAGE,
    example_question: str("How a rep asks for it, in English."),
    example_question_he: str("Hebrew question or empty."),
    asked_in_calls: int("In how many call transcripts this was asked; 0 if not from calls."),
    evidence: EVIDENCE,
  }), "What the agent must learn from the buyer."),
  objections: arr(obj({
    objection: str("The objection in the buyer's words, in English."),
    objection_he: str("Hebrew or empty."),
    answer: str("The answer that worked, in English, 1 or 2 sentences."),
    answer_he: str("Hebrew or empty."),
    outcome: str("What followed the answer across calls, e.g. meeting booked in 4 of 5 calls; empty if unknown."),
    evidence: EVIDENCE,
  }), "Objections with the answers that worked."),
  limits: arr(obj({
    rule: str("The rule in plain words, e.g. Installation is free from 3 sites."),
    rule_he: str("Hebrew or empty."),
    setting: {
      type: "string",
      enum: ["discount_cap", "custom_pricing_quantity", "offer_meeting", "hand_off", "other"],
      description: "discount_cap: the largest discount reps give without asking; custom_pricing_quantity: from what quantity of one item the price is set by hand; offer_meeting: when reps offer a meeting; hand_off: when a person must take over; other: any other special term.",
    },
    max_discount_percent: { type: "number", description: "discount_cap only: the percentage; otherwise 0." },
    sku: str("custom_pricing_quantity only: the item's SKU from the catalog; otherwise empty."),
    quantity: int("custom_pricing_quantity only: the quantity from which the price is set by hand; otherwise 0."),
    condition: str("offer_meeting and hand_off only: when it applies, in English, one short sentence; otherwise empty."),
    evidence: EVIDENCE,
  }), "Pricing, discounts, free extras, special terms and meeting or hand-over rules heard or written. They need the seller's explicit approval."),
  tone: obj({ text: str("One sentence on how the seller's reps talk."), text_he: str("Hebrew or empty."), evidence: EVIDENCE }),
  never: arr(obj({
    rule: str("Something the agent must never say or do, worded to follow the word Never."),
    rule_he: str("Hebrew or empty."),
    evidence: EVIDENCE,
  }), "Things the agent must never say or do."),
  discovery_questions: arr(obj({
    label: str("Short English label of what the question learns, e.g. Cost of the last failure."),
    question: str("The open question, in English."),
    question_he: str("Hebrew or empty."),
    role: ROLE,
    asked_in_calls: int("In how many call transcripts this was asked; 0 if not from calls."),
    evidence: EVIDENCE,
  }), "Good open questions reps ask that are not already a field, each with its role."),
  opener: obj({
    leads_ask_about: str("The most common thing leads ask about when they contact the seller, a few English words that fit \"You asked about ...\", at most 120 characters, e.g. monitoring your fridge temperatures. Empty if unclear."),
    topics: arr(obj({
      text: str("A topic leads ask about, a few English words that fit \"You asked about ...\", at most 120 characters."),
      text_he: str("The same topic in Hebrew, or empty."),
    }), "Up to 6 topics leads ask about, the most common first (it repeats leads_ask_about)."),
    opening_question: str("One easy English question about the buyer's situation today, at most 200 characters, e.g. How do you check your fridge temperatures today? Empty if unclear."),
    opening_question_he: str("The opening question in Hebrew, or empty."),
    evidence: EVIDENCE,
  }, "The agent's first message: what leads ask about and the opening question."),
  play_content: arr(obj({
    play: PLAY,
    content: str("The seller's facts for this situation, in English, at most 600 characters. Only what the evidence supports."),
    evidence: EVIDENCE,
  }), "Per selling situation (play), the seller's facts the agent may use. Only plays the corpus supports."),
  play_cards: arr(obj({
    play: PLAY,
    when: str("When the seller's way applies, one English sentence, at most 200 characters."),
    moves: arr({ type: "string", description: "One move, a short English sentence, at most 200 characters." }, "2 to 5 moves, in the order the reps make them."),
    example: str("A good reply in the reps' style, in English, at most 300 characters."),
    not_this: str("A reply to avoid, in English, at most 300 characters."),
    evidence: EVIDENCE,
  }), "The seller's own way of handling a situation, only when call transcripts clearly show it. Usually empty."),
  catalog_items: arr(obj({
    sku: str("The item's SKU from the catalog, exactly."),
    plain_name: str("What a buyer would call the item in chat, plain English words, at most 60 characters, e.g. wireless fridge sensor. Empty to keep the current one."),
    value_line: str("What the buyer gets from the item, one English sentence, at most 140 characters; an outcome, not features. Empty to keep the current one."),
    evidence: EVIDENCE,
  }), "Plain names and one-sentence value lines for catalog items."),
});

/**
 * The fixed tool list both stages send (same order, same bytes). Not `strict`:
 * the two result schemas together compile to a grammar larger than the API
 * accepts (400 "The compiled grammar is too large"). lib/pipeline/validate.ts
 * checks every result in code instead (evidence, shapes, lengths).
 */
export const PIPELINE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: FACTS_TOOL,
    description: "Records the knowledge found in the corpus: facts, contradictions, unanswered buyer questions, what each source is about, and statements kept back because they are about one customer.",
    input_schema: FACTS_SCHEMA as Anthropic.Beta.BetaTool["input_schema"],
  },
  {
    name: PLAYBOOK_TOOL,
    description: "Records the suggested playbook draft: goal, fields to learn, objections and answers, limits, tone, things never to do, discovery questions, the opener, sales play facts and own cards, and plain names and value lines for catalog items.",
    input_schema: PLAYBOOK_SCHEMA as Anthropic.Beta.BetaTool["input_schema"],
  },
];
