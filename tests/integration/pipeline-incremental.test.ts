/**
 * KQ: stage 1 reads only new or changed sources once an analysis under the
 * same rules finished (approved facts go along as context); the full re-run,
 * the first run and a rules change still read every source; storeFacts skips
 * near-duplicates of a fact from the same source. Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { knowledgeFacts, pipelineRuns, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { addFact } from "@/lib/agent/service";
import { ScriptedPipelineLlm } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { analyzeSources, factsRules, listRuns, planAnalysis, runData, sourceGaps, type FactsRunResult, type RunData } from "@/lib/pipeline/service";
import { addNote, listSections, updateNote } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

const SONNET = "claude-sonnet-5-5";
const EMPTY = { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] };
const PLAYBOOK = { goal: { text: "", text_he: "", evidence: [] }, fields: [], objections: [], limits: [], tone: { text: "", text_he: "", evidence: [] }, never: [], discovery_questions: [] };

describe("stage 1 over new or changed sources only", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;
  let priceId: string, specId: string, newId: string;

  const fact = (sourceId: string, locator: string, statement: string, topic = "Product") =>
    ({ topic, statement, language: "en", customer_specific: false, evidence: [{ source_id: sourceId, locator, quote: statement.slice(0, 40) }] });
  const loc = async (id: string) => (await listSections(db, acc, id))[0].locator;
  const factsRun = async () => (await listRuns(db, acc, 20)).find((r) => r.kind === "facts" && r.status === "done")!;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-kq", email: "kq@p.test", firstName: "K", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const p = parseCreateAccount({ tradeName: "Kq", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "kq@x.test" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    acc = (await createAccount(db, actor, p.value)).account.id;
    priceId = (await addNote(db, actor, acc, { title: "Pricing and policy", body: "Prices are in ILS and do not include VAT (18%). Warranty is 24 months." })).id;
    specId = (await addNote(db, actor, acc, { title: "Product facts", body: "One GW-10 gateway handles up to 30 units within about 50 m indoors." })).id;
  });
  afterAll(async () => t.close());

  it("the first analysis reads every source and records its rules", async () => {
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.factsScope).toBe("all");
    expect(plan.factsSources.map((s) => s.id).sort()).toEqual([priceId, specId].sort());
    expect(plan.factsCorpus).toBe(plan.corpus);
    const [pl, sl] = [await loc(priceId), await loc(specId)];
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [
        fact(priceId, pl, "Prices are in ILS and do not include VAT (18%).", "Pricing terms"),
        fact(specId, sl, "One GW-10 gateway handles up to 30 units within about 50 m indoors."),
      ], gaps: [{ topic: "Delivery", question: "How long is delivery?" }] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();
    // Both stages read the same corpus: stage 1 caches it for stage 2.
    expect(llm.requests.map((r) => [r.model, r.cacheCorpus])).toEqual([[SONNET, true], [SONNET, true]]);
    const run = await factsRun();
    expect(runData(run)!.result).toMatchObject({ scope: "all", rules: factsRules(SONNET), factsAdded: 2 });
    // Approve the first facts: they become context for later runs.
    await db.update(knowledgeFacts).set({ status: "approved" }).where(eq(knowledgeFacts.accountId, acc));
  });

  it("nothing new or changed: stage 1 is reused, no call", async () => {
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.factsScope).toBe("changed");
    expect(plan.factsSources).toEqual([]);
    expect(plan.facts.reuse).toBe(true);
  });

  it("a new source: stage 1 reads only it, with the approved facts as context; stage 2 reads the whole corpus", async () => {
    newId = (await addNote(db, actor, acc, { title: "Case studies", body: "Hotel group: 30% less waste in a year. Works with the existing door system." })).id;
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.factsScope).toBe("changed");
    expect(plan.factsSources.map((s) => s.id)).toEqual([newId]);
    expect(plan.factsCorpus).toContain(newId);
    expect(plan.factsCorpus).not.toContain(priceId);
    expect(plan.corpus).toContain(priceId);
    expect(plan.facts.reuse).toBe(false);
    // Stage 1 costs less than reading everything.
    const full = (await planAnalysis(db, acc, process.env, { full: true }))!;
    expect(plan.estimate.stages[0].usage.inputTokens + plan.estimate.stages[0].usage.cacheWriteTokens)
      .toBeLessThan(full.estimate.stages[0].usage.inputTokens + full.estimate.stages[0].usage.cacheWriteTokens);

    const nl = await loc(newId);
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [fact(newId, nl, "A hotel group cut waste by 30% in a year.", "Proof")], gaps: [{ topic: "Proof", question: "Which hotel group?" }] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();
    const [f, pb] = llm.requests;
    expect(f.corpus).toContain(newId);
    expect(f.corpus).not.toContain(priceId);
    expect(f.corpus).not.toContain(specId);
    expect(f.instruction).toContain("<known_facts>");
    expect(f.instruction).toContain("Prices are in ILS and do not include VAT (18%).");
    expect(pb.corpus).toContain(priceId);
    expect(pb.corpus).toContain(newId);
    // Different corpora: neither stage pays to cache one.
    expect([f.cacheCorpus, pb.cacheCorpus]).toEqual([false, false]);
    expect([f.model, pb.model]).toEqual([SONNET, SONNET]);

    const run = await factsRun();
    expect(run.sourceIds).toEqual([newId]);
    expect(runData(run)!.result).toMatchObject({ scope: "changed", factsAdded: 1 });
    // Gaps of the changed-only run add to those of the run before it.
    expect((await sourceGaps(db, acc)).map((g) => g.question)).toEqual(["Which hotel group?", "How long is delivery?"]);
  });

  it("an edited source is read again, alone; near-duplicates of its own facts are skipped, different facts kept", async () => {
    await updateNote(db, acc, priceId, { title: "Pricing and policy", body: "Prices are in ILS and do not include VAT (18%). Warranty is 24 months. Installation within 5 days." });
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.factsSources.map((s) => s.id)).toEqual([priceId]);
    const pl = await loc(priceId);
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [
        // Reworded: same source, same words in another order.
        fact(priceId, pl, "Prices are in ILS and do not include 18% VAT.", "Pricing terms"),
        // Near-duplicate of the other source's fact, but from this source: kept (same-source rule).
        fact(priceId, pl, "One GW-10 site gateway handles up to 30 units within about 50 m indoors."),
        // Genuinely new.
        fact(priceId, pl, "Installation takes place within 5 days.", "Installation"),
        // Another number: kept.
        fact(priceId, pl, "Prices are in ILS and do not include VAT (17%).", "Pricing terms"),
      ] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();
    const stored = await db.select({ statement: knowledgeFacts.statement }).from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, acc), eq(knowledgeFacts.sourceId, priceId)));
    expect(stored.map((f) => f.statement).sort()).toEqual([
      "Installation takes place within 5 days.",
      "One GW-10 site gateway handles up to 30 units within about 50 m indoors.",
      "Prices are in ILS and do not include VAT (17%).",
      "Prices are in ILS and do not include VAT (18%).",
    ]);
    const result = runData(await factsRun())!.result as FactsRunResult;
    expect(result.factsAdded).toBe(3);
    expect(result.dropped.duplicates).toBe(1);
  });

  it("a near-duplicate from the same source is skipped (the GW-10 rewording)", async () => {
    await updateNote(db, acc, specId, { title: "Product facts", body: "One GW-10 gateway handles up to 30 units within about 50 m indoors. Free setup call." });
    const sl = await loc(specId);
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [fact(specId, sl, "One GW-10 site gateway handles up to 30 units within about 50 m indoors.")] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();
    expect(llm.requests[0].corpus).toContain(specId);
    expect(llm.requests[0].corpus).not.toContain(priceId);
    const result = runData(await factsRun())!.result as FactsRunResult;
    expect(result).toMatchObject({ factsAdded: 0, scope: "changed" });
    expect(result.dropped.duplicates).toBe(1);
  });

  it("the full re-run reads every source again, and caches the shared corpus", async () => {
    const plan = (await planAnalysis(db, acc, process.env, { full: true }))!;
    expect(plan.factsScope).toBe("all");
    expect(plan.factsSources.map((s) => s.id).sort()).toEqual([priceId, specId, newId].sort());
    expect(plan.facts.reuse).toBe(false);
    const pl = await loc(priceId);
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [fact(priceId, pl, "Warranty is 24 months.", "Warranty")] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    const fullRes = await analyzeSources(db, llm, acc, { full: true });
    expect(fullRes.failed).toBeNull();
    for (const id of [priceId, specId, newId]) expect(llm.requests[0].corpus).toContain(id);
    expect(llm.requests[0].corpus).toBe(llm.requests[1].corpus);
    expect(llm.requests.map((r) => r.cacheCorpus)).toEqual([true, true]);
    const run = await factsRun();
    expect(run.sourceIds.sort()).toEqual([priceId, specId, newId].sort());
    expect(runData(run)!.result).toMatchObject({ scope: "all" });
    // The gaps start again from this full run.
    expect(await sourceGaps(db, acc)).toEqual([]);
  });

  it("new analysis rules (another prompt version or model) read every source again", async () => {
    await addNote(db, actor, acc, { title: "More", body: "Support answers within one hour." });
    expect((await planAnalysis(db, acc))!.factsScope).toBe("changed");
    const run = await factsRun();
    const usage = runData(run)!;
    await db.update(pipelineRuns).set({ usage: { ...usage, result: { ...(usage.result as FactsRunResult), rules: "system-v6|facts-v1|claude-sonnet-5-5" } } as RunData as never }).where(eq(pipelineRuns.id, run.id));
    const plan = (await planAnalysis(db, acc))!;
    expect(plan.factsScope).toBe("all");
    expect(plan.factsSources).toHaveLength(4);
    // Another model also counts as new rules.
    await db.update(pipelineRuns).set({ usage: usage as never }).where(eq(pipelineRuns.id, run.id));
    expect((await planAnalysis(db, acc, { PIPELINE_MODEL: "claude-opus-5-5" }))!.factsScope).toBe("all");
  });
});
