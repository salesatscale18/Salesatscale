import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { knowledgeFacts, pipelineRuns, playbookSuggestions, sellerAccounts, sourceSections, sources, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { addFact, ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { aiUsageThisMonth, platformUsageThisMonth } from "@/lib/ai/usage";
import { estimateCostMicros } from "@/lib/ai/models";
import { ScriptedPipelineLlm, type PipelineRequest } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { LARGE_CORPUS_TOKENS, tokensOf, TRIMMED_CORPUS_TOKENS } from "@/lib/pipeline/corpus";
import {
  acceptAllSuggestions, analyzeSources, approveAllSuggestedFacts, customerNotes, decideSuggestion, editSuggestion, executeAnalysis,
  latestSuggestions, listRuns, locateEvidence, openContradictions, PipelineRefused, planAnalysis, resolveContradiction, runData,
  saveSuggestionsToDraft, sourceAboutMap, sourceGaps, startAnalysis, suggestionsForSource, type FactsRunResult,
} from "@/lib/pipeline/service";
import { addCall, addNote, listSections } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

describe("knowledge -> playbook pipeline", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string, other: string, big: string;
  let slug: string;
  let noteId: string, callId: string, heId: string;
  const ev = (sourceId: string, locator: string, quote: string) => ({ source_id: sourceId, locator, quote });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-p", email: "p@p.test", firstName: "Pia", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor, p.value)).account;
    };
    const a = await mk("Polar");
    acc = a.id;
    slug = a.slug;
    other = (await mk("Other")).id;
    big = (await mk("Bigco")).id;
    noteId = (await addNote(db, actor, acc, { title: "Sensor spec", body: "The SNS-200 sensor measures from -40C to +60C. Warranty is 12 months." })).id;
    heId = (await addNote(db, actor, acc, { title: "אחריות", body: "האחריות על החיישן היא 24 חודשים." })).id;
    callId = (await addCall(db, actor, acc, {
      title: "Call with a cafe chain", consent: true,
      text: [
        "[05:31] Rep: How do you check the fridges today?",
        "[06:03] Buyer: We lost about 8000 shekels of fish last month.",
        "[06:12] Buyer: My partner will say we already pay for an alarm company.",
        "[06:20] Rep: The alarm covers doors, not temperature. Let's book 15 minutes with your partner.",
        "[07:11] Rep: For three sites I can waive the installation fee.",
      ].join("\n"),
    })).id;
    // The other account has its own source, never part of this account's corpus.
    await addNote(db, actor, other, { title: "Other note", body: "Other company fact." });
  });
  afterAll(async () => t.close());
  afterEach(() => { delete process.env.AI_PLATFORM_MONTHLY_BUDGET_USD; });

  const locators = async (accountId: string, sourceId: string) => (await listSections(db, accountId, sourceId)).map((s) => s.locator);

  /** A scripted record_facts reply over this account's sources. */
  const factsReply = async () => {
    const [noteLoc] = await locators(acc, noteId);
    const [heLoc] = await locators(acc, heId);
    const callLocs = await locators(acc, callId);
    return {
      facts: [
        { topic: "Product", statement: "The SNS-200 sensor measures from -40C to +60C.", language: "en", customer_specific: false, evidence: [ev(noteId, noteLoc, "The SNS-200 sensor measures from -40C to +60C.")] },
        // Same fact again, other wording of case and punctuation: deduplicated.
        { topic: "Product", statement: "the SNS-200 sensor measures from -40C to +60C", language: "en", customer_specific: false, evidence: [ev(noteId, noteLoc, "measures")] },
        // No evidence: dropped.
        { topic: "Product", statement: "The gateway supports 30 sensors.", language: "en", customer_specific: false, evidence: [] },
        // Unknown locator: its only evidence is invalid, so dropped.
        { topic: "Product", statement: "Alerts go by SMS.", language: "en", customer_specific: false, evidence: [ev(noteId, "p.99", "SMS")] },
        // About one customer: kept back.
        { topic: "Company", statement: "The cafe chain lost 8000 shekels of fish.", language: "en", customer_specific: true, evidence: [ev(callId, callLocs[1], "We lost about 8000 shekels of fish")] },
        // A discount heard only in a call: never a fact.
        { topic: "Pricing terms", statement: "Installation is free of charge from three sites.", language: "en", customer_specific: false, evidence: [ev(callId, callLocs[4], "waive the installation fee")] },
        // Already exists as an approved fact: not added again.
        { topic: "Company", statement: "We install within 5 business days.", language: "en", customer_specific: false, evidence: [ev(noteId, noteLoc, "x".repeat(300))] },
      ],
      contradictions: [{
        topic: "Warranty", summary: "Sensor warranty length",
        options: [
          { statement: "The warranty is 12 months.", language: "en", evidence: [ev(noteId, noteLoc, "Warranty is 12 months.")] },
          { statement: "האחריות על החיישן היא 24 חודשים.", language: "he", evidence: [ev(heId, heLoc, "24 חודשים")] },
        ],
      }],
      gaps: [{ topic: "Pricing terms", question: "Is there a minimum contract?" }, { topic: "Installation", question: "Who installs the sensors?" }],
      source_about: [{ source_id: noteId, about: "Sensor specs" }, { source_id: callId, about: "Discovery call, alarm objection" }, { source_id: "not-a-source", about: "x" }],
      customer_specific: [{ source_id: callId, locator: callLocs[1], note: "Lost about 8000 shekels of fish is about this customer." }],
    };
  };

  const playbookReply = async () => {
    const callLocs = await locators(acc, callId);
    const [noteLoc] = await locators(acc, noteId);
    return {
      goal: { text: "Sell temperature monitoring to food businesses.", text_he: "", evidence: [ev(noteId, noteLoc, "SNS-200")] },
      fields: [
        { key: "sites", label: "Number of locations", label_he: "", stage: "before_quote", example_question: "How many sites?", example_question_he: "", asked_in_calls: 1, evidence: [ev(callId, callLocs[4], "three sites")] },
        { key: "invoice_email", label: "Invoice email", label_he: "", stage: "before_order_form", example_question: "Where should we send invoices?", example_question_he: "", asked_in_calls: 0, evidence: [ev(noteId, noteLoc, "SNS-200")] },
        { key: "Company ID!", label: "Company ID", label_he: "", stage: "before_order_form", example_question: "", example_question_he: "", asked_in_calls: 0, evidence: [ev(noteId, noteLoc, "SNS-200")] },
        { key: "monitoring", label: "Current monitoring", label_he: "", stage: "helpful", example_question: "How do you check the fridges today?", example_question_he: "", asked_in_calls: 1, evidence: [ev(callId, callLocs[0], "How do you check the fridges today?")] },
        { key: "nothing", label: "No evidence", label_he: "", stage: "helpful", example_question: "", example_question_he: "", asked_in_calls: 0, evidence: [] },
      ],
      objections: [{ objection: "We already pay for an alarm company", objection_he: "", answer: "An alarm covers doors, not temperature. Offer 15 minutes with the partner.", answer_he: "", outcome: "meeting booked in 1 of 1 calls", evidence: [ev(callId, callLocs[2], "we already pay for an alarm company")] }],
      limits: [{ rule: "Never waive the installation fee for fewer than 3 sites", rule_he: "", max_discount_percent: 0, evidence: [ev(callId, callLocs[4], "waive the installation fee")] }],
      tone: { text: "Short and practical.", text_he: "", evidence: [ev(callId, callLocs[3], "Let's book 15 minutes")] },
      never: [{ rule: "promise a delivery date", rule_he: "", evidence: [ev(noteId, noteLoc, "SNS-200")] }],
      discovery_questions: [{ label: "Cost of the last failure", question: "What did the last failure cost you?", question_he: "", asked_in_calls: 1, evidence: [ev(callId, callLocs[1], "We lost about")] }],
    };
  };

  const usage = (u: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u });

  let firstRun: ScriptedPipelineLlm;

  it("plans: a deterministic corpus of this account's ready sources, changed count and an estimate before any spend", async () => {
    await addFact(db, actor, acc, { topic: "Company", statement: "We install within 5 business days.", status: "approved" });
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.sources.map((s) => s.id)).toEqual([noteId, heId, callId].sort());
    expect(plan.changed).toBe(3);
    expect(plan.corpus).not.toContain("Other company fact");
    expect(plan.corpus).toContain(`<section source="${callId}" locator="06:12" heading="Buyer">`);
    expect(plan.large).toBe(false);
    expect(plan.facts.reuse).toBe(false);
    expect(plan.estimate.stages.map((s) => [s.stage, s.model])).toEqual([["facts", SONNET], ["playbook", SONNET]]);
    expect(plan.estimate.costMicros).toBeGreaterThan(0);
    // Same sources, same corpus and hash.
    const again = (await planAnalysis(db, acc))!;
    expect(again.corpus).toBe(plan.corpus);
    expect(again.token).toBe(plan.token);
  });

  it("runs stage 1 and stage 2: facts, contradictions, gaps and suggestions stored, cache read in stage 2, prefix byte-identical", async () => {
    const facts = await factsReply();
    const pb = await playbookReply();
    firstRun = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: facts }, model: SONNET, usage: usage({ inputTokens: 400, outputTokens: 3000, cacheWriteTokens: 6000 }) }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: pb }, model: SONNET, usage: usage({ inputTokens: 1200, outputTokens: 4000, cacheReadTokens: 6000 }) }),
    ]);
    const res = await analyzeSources(db, firstRun, acc);
    expect(res.failed).toBeNull();
    expect(res.facts).toMatchObject({ reused: false, added: 1, contradictions: 1, gaps: 2 });
    expect(res.playbook).toMatchObject({ reused: false, suggestions: 10 });

    // Request layout: both stages cache the corpus; stage 2 sends the same bytes up to the breakpoint.
    const [b1, b2] = firstRun.bodies;
    const prefix = (b: typeof b1) => JSON.stringify({ model: b.model, tools: b.tools, system: b.system, first: (b.messages[0].content as unknown[])[0] });
    expect(prefix(b2)).toBe(prefix(b1));
    expect((b1.messages[0].content as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(b1.messages[0].content)).not.toBe(JSON.stringify(b2.messages[0].content));
    expect(firstRun.requests.map((r: PipelineRequest) => r.model)).toEqual([SONNET, SONNET]);

    const runs = await listRuns(db, acc);
    const fr = runs.find((r) => r.kind === "facts")!;
    const pr = runs.find((r) => r.kind === "playbook")!;
    expect(fr).toMatchObject({ status: "done", model: SONNET, usage: expect.objectContaining({ input: 400, output: 3000, cacheRead: 0, cacheWrite: 6000 }) });
    expect(pr).toMatchObject({ status: "done", usage: expect.objectContaining({ input: 1200, output: 4000, cacheRead: 6000, cacheWrite: 0 }) });
    expect(pr.costEstimateMicros).toBe(estimateCostMicros(SONNET, { inputTokens: 1200, outputTokens: 4000, cacheReadTokens: 6000, cacheWriteTokens: 0 }));
    expect(runData(pr)!.cacheRead).toBeGreaterThan(0);

    const stored = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, acc));
    const suggested = stored.filter((f) => f.status === "suggested");
    // 1 new fact + 2 contradiction sides; the duplicate, the evidence-less, the customer one and the price heard in a call are not stored.
    expect(suggested.map((f) => f.statement).sort()).toEqual(["The SNS-200 sensor measures from -40C to +60C.", "The warranty is 12 months.", "האחריות על החיישן היא 24 חודשים."].sort());
    const sns = suggested.find((f) => f.statement.startsWith("The SNS"))!;
    expect(sns).toMatchObject({ sourceId: noteId, language: "en", topic: "Product" });
    expect(sns.sourceLocator).toBeTruthy();
    expect(stored.filter((f) => f.statement === "We install within 5 business days.")).toHaveLength(1);
    expect(stored.some((f) => /8000|free of charge/.test(f.statement))).toBe(false);

    const result = runData(fr)!.result as FactsRunResult;
    expect(result.dropped).toMatchObject({ noEvidence: 2, customerSpecific: 1, pricing: 1 });
    expect(result.dropped.duplicates).toBe(2);
    expect(await sourceGaps(db, acc)).toEqual([{ topic: "Pricing terms", question: "Is there a minimum contract?" }, { topic: "Installation", question: "Who installs the sensors?" }]);
    const about = await sourceAboutMap(db, acc);
    expect(about.get(noteId)).toBe("Sensor specs");
    expect(about.size).toBe(2);
    expect((await customerNotes(db, acc, callId)).map((n) => n.note)).toContain("Lost about 8000 shekels of fish is about this customer.");

    const open = await openContradictions(db, acc);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ topic: "Warranty", summary: "Sensor warranty length" });
    expect(open[0].facts).toHaveLength(2);

    const { items } = await latestSuggestions(db, acc);
    expect(items.map((s) => s.kind).sort()).toEqual(["discovery_question", "field", "field", "field", "field", "goal", "limit", "never", "objection", "tone"]);
    const keys = items.filter((s) => s.kind === "field").map((s) => s.payload.kind === "field" ? s.payload.key : "");
    expect(keys).toEqual(["sites", "invoice_email", "company_id", "monitoring"]);
    expect(items.every((s) => s.evidence.length > 0 && s.evidence.every((e) => e.quote.length <= 200))).toBe(true);
    expect((await suggestionsForSource(db, acc, callId)).map((s) => s.kind).sort()).toEqual(["discovery_question", "field", "field", "limit", "objection", "tone"]);

    // Sources are now analysed.
    const rows = await db.select({ id: sources.id, textHash: sources.textHash }).from(sources).where(eq(sources.accountId, acc));
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.textHash ?? ""))).toBe(true);
  });

  it("reuses a finished run with the same input hash: no model call, estimate $0", async () => {
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.changed).toBe(0);
    expect(plan.facts.reuse).toBe(true);
    expect(plan.playbook.reuse).toBe(true);
    expect(plan.estimate.costMicros).toBe(0);
    const none = new ScriptedPipelineLlm([]);
    const res = await analyzeSources(db, none, acc);
    expect(res.facts?.reused).toBe(true);
    expect(res.playbook?.reused).toBe(true);
    expect(none.requests).toHaveLength(0);
  });

  it("evidence links point at the source page and the section's position", async () => {
    const callLocs = await locators(acc, callId);
    const links = await locateEvidence(db, acc, slug, [{ sourceId: callId, locator: callLocs[2] }, { sourceId: noteId, locator: "nope" }]);
    expect(links.get(`${callId}|${callLocs[2]}`)?.href).toBe(`/app/${slug}/setup/sources/${callId}#l-2`);
    expect(links.get(`${noteId}|nope`)?.href).toBe(`/app/${slug}/setup/sources/${noteId}`);
    // Another account cannot resolve this account's sources.
    expect((await locateEvidence(db, other, "other", [{ sourceId: callId, locator: callLocs[2] }])).size).toBe(0);
  });

  it("approve all leaves facts in an open contradiction; choosing a side approves it and rejects the other", async () => {
    const n = await approveAllSuggestedFacts(db, acc);
    expect(n).toBe(1);
    const open = await openContradictions(db, acc);
    expect(open).toHaveLength(1);
    // Another account cannot resolve it.
    expect(await resolveContradiction(db, actor, other, { runId: open[0].runId, index: 0, choice: open[0].facts[0].id })).toBe(false);
    const he = open[0].facts.find((f) => f.language === "he")!;
    expect(await resolveContradiction(db, actor, acc, { runId: open[0].runId, index: 0, choice: he.id })).toBe(true);
    const after = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, acc), eq(knowledgeFacts.topic, "Warranty")));
    expect(after.find((f) => f.id === he.id)?.status).toBe("approved");
    expect(after.find((f) => f.id !== he.id)?.status).toBe("rejected");
    expect(await openContradictions(db, acc)).toEqual([]);
  });

  it("accept, edit and reject suggestions; save merges accepted ones into the draft and keeps field keys", async () => {
    await ensureDraftVersion(db, acc);
    const { items } = await latestSuggestions(db, acc);
    const by = (kind: string, pred: (p: Record<string, unknown>) => boolean = () => true) => items.find((s) => s.kind === kind && pred(s.payload as unknown as Record<string, unknown>))!;
    // Another account cannot decide this account's suggestion.
    expect(await decideSuggestion(db, actor, other, by("goal").id, "accepted")).toBeNull();
    expect(await decideSuggestion(db, actor, acc, by("goal").id, "accepted")).toMatchObject({ status: "accepted" });
    expect(await decideSuggestion(db, actor, acc, by("never").id, "rejected")).toMatchObject({ status: "rejected" });
    expect(await editSuggestion(db, actor, acc, by("objection").id, { objection: "We have an alarm", answer: "" })).toEqual({ ok: false, error: "required" });
    expect(await editSuggestion(db, actor, acc, by("objection").id, { objection: "We have an alarm company", answer: "Alarms cover doors, not temperature." })).toEqual({ ok: true });
    expect(await editSuggestion(db, actor, acc, by("limit").id, { rule: "waive installation for fewer than 3 sites", maxDiscountPercent: "60" })).toEqual({ ok: false, error: "discount" });
    expect(await editSuggestion(db, actor, acc, by("limit").id, { rule: "waive installation for fewer than 3 sites", maxDiscountPercent: "8" })).toEqual({ ok: true });
    // Accept all fields; limits are never accepted in bulk.
    expect(await acceptAllSuggestions(db, actor, acc, ["field", "discovery_question", "limit"])).toBe(5);
    expect((await db.select().from(playbookSuggestions).where(eq(playbookSuggestions.id, by("limit").id)))[0].status).toBe("edited");

    const { version, merged } = await saveSuggestionsToDraft(db, actor, acc);
    expect(merged).toBe(8);
    const draft = await ensureDraftVersion(db, acc);
    expect(draft.version).toBe(version);
    const p = draft.playbook;
    expect(p.goal).toBe("Sell temperature monitoring to food businesses.");
    // "sites" existed with label "Number of sites": key, label and stage kept.
    expect(p.fields.find((f) => f.key === "sites")).toMatchObject({ label: "Number of sites", stage: "before_quote" });
    expect(p.fields.filter((f) => f.key === "sites")).toHaveLength(1);
    expect(p.fields.find((f) => f.key === "invoice_email")).toMatchObject({ stage: "before_order_form" });
    expect(p.fields.find((f) => f.key === "company_id")).toBeTruthy();
    expect(p.fields.find((f) => f.key === "cost_of_the_last_failure")).toMatchObject({ stage: "optional", example: "What did the last failure cost you?" });
    expect(p.objections).toContainEqual(expect.objectContaining({ objection: "We have an alarm company", answer: "Alarms cover doors, not temperature." }));
    expect(p.neverDo).toEqual(["waive installation for fewer than 3 sites"]);
    expect(p.maxDiscountBp).toBe(800);
    expect(p.tone).not.toBe("Short and practical."); // tone was not accepted

    // Saving again changes nothing.
    await saveSuggestionsToDraft(db, actor, acc);
    expect((await ensureDraftVersion(db, acc)).playbook).toEqual(p);
  });

  it("counts pipeline usage in the account and platform roll-ups", async () => {
    const u = await aiUsageThisMonth(db, acc);
    const sonnet = u.byModel.find((m) => m.model === SONNET)!;
    expect(sonnet).toMatchObject({ inputTokens: 1600, outputTokens: 7000, cacheReadTokens: 6000, cacheWriteTokens: 6000, calls: 2 });
    expect(u.costMicros).toBe(estimateCostMicros(SONNET, { inputTokens: 1600, outputTokens: 7000, cacheReadTokens: 6000, cacheWriteTokens: 6000 }));
    expect((await aiUsageThisMonth(db, other)).costMicros).toBe(0);
    expect((await platformUsageThisMonth(db)).costMicros).toBeGreaterThanOrEqual(u.costMicros);
  });

  it("refuses: changed since the estimate, another run active, spend cap reached", async () => {
    await addNote(db, actor, acc, { title: "New", body: "Delivery takes 3 days." });
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.changed).toBe(1);
    await expect(startAnalysis(db, acc, plan, { token: "stale" })).rejects.toMatchObject({ reason: "changed" });
    const [busy] = await db.insert(pipelineRuns).values({ id: crypto.randomUUID(), accountId: acc, kind: "facts", status: "running" }).returning();
    await expect(startAnalysis(db, acc, plan, { token: plan.token })).rejects.toMatchObject({ reason: "busy" });
    // A run that has been running for over 15 minutes stopped: it no longer blocks.
    await expect(startAnalysis(db, acc, plan, { now: new Date(Date.now() + 16 * 60 * 1000) })).resolves.toBeTruthy();
    expect((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, busy.id)))[0].status).toBe("failed");
    await db.delete(pipelineRuns).where(and(eq(pipelineRuns.accountId, acc), eq(pipelineRuns.status, "queued")));
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
    await expect(startAnalysis(db, acc, plan)).rejects.toBeInstanceOf(PipelineRefused);
    await expect(startAnalysis(db, acc, plan)).rejects.toMatchObject({ reason: "capped" });
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 10_000 }).where(eq(sellerAccounts.id, acc));
  });

  it("the platform budget guard refuses before any model call; the run fails in plain words", async () => {
    process.env.AI_PLATFORM_MONTHLY_BUDGET_USD = "0.000001";
    const llm = new ScriptedPipelineLlm([]);
    const plan = (await planAnalysis(db, acc))!;
    const runs = await startAnalysis(db, acc, plan);
    const res = await executeAnalysis(db, llm, acc, plan, runs);
    expect(res.failed).toBe("The platform's monthly AI budget is used up.");
    expect(llm.requests).toHaveLength(0);
    const [fr] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runs.factsRunId!));
    expect(fr).toMatchObject({ status: "failed", error: "The platform's monthly AI budget is used up." });
    const [pr] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runs.playbookRunId!));
    expect(pr.status).toBe("failed");
  });

  it("a reply without the tool fails the run and keeps the usage spent", async () => {
    const llm = new ScriptedPipelineLlm([() => ({ tool: null, usage: usage({ inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30 }) })]);
    const plan = (await planAnalysis(db, acc))!;
    const runs = await startAnalysis(db, acc, plan);
    const res = await executeAnalysis(db, llm, acc, plan, runs);
    expect(res.failed).toBe("The model did not return results.");
    const [fr] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runs.factsRunId!));
    expect(fr.usage).toMatchObject({ input: 10, output: 20, cacheWrite: 30 });
    expect(fr.costEstimateMicros).toBeGreaterThan(0);
  });

  it("a stage-2 rerun after approving facts reads only the playbook stage; data changes the hash", async () => {
    // Approve the new note's facts state: rerun facts first (stage 1 + 2), then change only approvals.
    const pb = await playbookReply();
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: pb } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();
    await approveAllSuggestedFacts(db, acc);
    await addFact(db, actor, acc, { topic: "Company", statement: "We are open on Sundays.", status: "approved" });
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.facts.reuse).toBe(true);
    expect(plan.playbook.reuse).toBe(false);
    expect(plan.estimate.stages.map((s) => s.stage)).toEqual(["playbook"]);
    const only = new ScriptedPipelineLlm([() => ({ tool: { name: PLAYBOOK_TOOL, input: pb } })]);
    await analyzeSources(db, only, acc);
    expect(only.requests).toHaveLength(1);
    // Alone, stage 2 does not pay to cache the corpus.
    expect((only.bodies[0].messages[0].content as { cache_control?: unknown }[])[0].cache_control).toBeUndefined();
  });

  it("large corpus: stage 1 per source on the light model without a corpus cache, stage 2 on a trimmed corpus", async () => {
    const mkSource = async (kind: "file" | "call", title: string, sections: number, chars: number) => {
      const id = crypto.randomUUID();
      await db.insert(sources).values({ id, accountId: big, kind, title, status: "ready", extractedText: "x" });
      await db.insert(sourceSections).values(Array.from({ length: sections }, (_, i) => ({
        id: crypto.randomUUID(), accountId: big, sourceId: id, position: i, locator: kind === "call" ? `${String(i).padStart(2, "0")}:00` : `p.${i + 1}`,
        heading: null, text: `${title} part ${i} `.padEnd(chars, "lorem ipsum "),
      })));
      return id;
    };
    const doc = await mkSource("file", "Manual", 40, 10_000); // ~114K tokens: two chunks
    const call = await mkSource("call", "Call", 20, 4_000); // ~23K tokens
    const doc2 = await mkSource("file", "Catalog", 30, 10_000); // ~86K tokens
    const plan = (await planAnalysis(db, big))!;
    expect(plan.corpusTokens).toBeGreaterThan(LARGE_CORPUS_TOKENS);
    expect(plan.large).toBe(true);
    expect(plan.estimate.stages[0]).toMatchObject({ stage: "facts", model: HAIKU, calls: 4 });
    expect(plan.estimate.stages[1]).toMatchObject({ stage: "playbook", model: SONNET });
    const empty = { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] };
    const factFor = (id: string, loc: string) => ({ ...empty, facts: [{ topic: "Product", statement: `Fact from ${loc}.`, language: "en", customer_specific: false, evidence: [ev(id, loc, "part")] }] });
    const llm = new ScriptedPipelineLlm([
      (r) => ({ tool: { name: FACTS_TOOL, input: r.corpus.includes(doc) ? factFor(doc, "p.1") : r.corpus.includes(call) ? factFor(call, "00:00") : factFor(doc2, "p.1") }, model: HAIKU }),
      (r) => ({ tool: { name: FACTS_TOOL, input: r.corpus.includes(doc) ? factFor(doc, "p.1") : r.corpus.includes(call) ? factFor(call, "00:00") : factFor(doc2, "p.2") }, model: HAIKU }),
      (r) => ({ tool: { name: FACTS_TOOL, input: r.corpus.includes(doc) ? factFor(doc, "p.3") : r.corpus.includes(call) ? factFor(call, "01:00") : factFor(doc2, "p.3") }, model: HAIKU }),
      (r) => ({ tool: { name: FACTS_TOOL, input: r.corpus.includes(doc) ? factFor(doc, "p.4") : r.corpus.includes(call) ? factFor(call, "02:00") : factFor(doc2, "p.4") }, model: HAIKU }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: { goal: { text: "Sell.", text_he: "", evidence: [ev(call, "00:00", "Call")] }, fields: [], objections: [], limits: [], tone: { text: "", text_he: "", evidence: [] }, never: [], discovery_questions: [] } } }),
    ]);
    const res = await analyzeSources(db, llm, big);
    expect(res.failed).toBeNull();
    const reqs = llm.requests;
    expect(reqs.map((r) => r.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU, SONNET]);
    expect(reqs.slice(0, 4).every((r) => !r.cacheCorpus && r.effort === "low" && !r.fallbacks)).toBe(true);
    expect(reqs.slice(0, 4).every((r) => tokensOf(r.corpus) < 100_000)).toBe(true);
    const stage2 = reqs[4];
    expect(stage2.cacheCorpus).toBe(false);
    expect(tokensOf(stage2.corpus)).toBeLessThanOrEqual(TRIMMED_CORPUS_TOKENS + 1000);
    // Calls come first in the trimmed corpus: all of the call is there.
    expect(stage2.corpus).toContain(`locator="19:00"`);
    expect(stage2.instruction).toMatch(/"Fact from (p\.\d|\d\d:00)\."/);
    const runs = await listRuns(db, big);
    expect(runs.find((r) => r.kind === "facts")).toMatchObject({ model: HAIKU, status: "done", usage: expect.objectContaining({ calls: 4 }) });
    expect((await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, big))).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps accounts apart: runs, facts and suggestions of one account never show in another", async () => {
    expect(await listRuns(db, other)).toEqual([]);
    expect((await latestSuggestions(db, other)).items).toEqual([]);
    expect(await openContradictions(db, other)).toEqual([]);
    expect(await sourceGaps(db, other)).toEqual([]);
    expect((await sourceAboutMap(db, other)).size).toBe(0);
    const { items } = await latestSuggestions(db, acc);
    expect(await editSuggestion(db, actor, other, items[0].id, { text: "x" })).toEqual({ ok: false, error: "missing" });
    expect(await acceptAllSuggestions(db, actor, other, ["goal"])).toBe(0);
    expect(await approveAllSuggestedFacts(db, other)).toBe(0);
    // The other account's plan only has its own note.
    const plan = (await planAnalysis(db, other))!;
    expect(plan.sources).toHaveLength(1);
    expect(plan.corpus).not.toContain(noteId);
    void saveDraftPlaybook;
  });
});
