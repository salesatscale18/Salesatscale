import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { knowledgeFacts, pipelineRuns, playbookSuggestions, sellerAccounts, users, type User } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { ScriptedPipelineLlm } from "@/lib/pipeline/llm";
import { FACTS_TOOL, PLAYBOOK_TOOL } from "@/lib/pipeline/prompts/system";
import { analyzeSources, latestSuggestions, openContradictions } from "@/lib/pipeline/service";
import { addCall, addNote, listSections } from "@/lib/sources/service";
import { createTestDb, type TestDb } from "../helpers/db";

// Server actions read the app database and the caller's access from lib/auth/account.
const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, after: [] as (() => unknown)[] }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { holder.after.push(fn); } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ refresh: () => {} }),
}));

const pipeline = await import("@/app/app/[account]/setup/sources/pipeline-actions");
const draft = await import("@/app/app/[account]/setup/playbook/draft/actions");
const knowledge = await import("@/app/app/[account]/setup/knowledge/actions");
const playbookActions = await import("@/app/app/[account]/setup/playbook/actions");
const PlaybookPage = (await import("@/app/app/[account]/setup/playbook/page")).default;
const SourcesPage = (await import("@/app/app/[account]/setup/sources/page")).default;
const DraftPage = (await import("@/app/app/[account]/setup/playbook/draft/page")).default;
const KnowledgePage = (await import("@/app/app/[account]/setup/knowledge/page")).default;
const SourcePage = (await import("@/app/app/[account]/setup/sources/[sourceId]/page")).default;

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
/** Runs a server action and returns the URL it redirected to. */
const go = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  throw new Error("no redirect");
};
const ev = (source_id: string, locator: string, quote: string) => ({ source_id, locator, quote });

describe("pipeline screens and actions", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let actor: Actor;
  let acc: string;
  let slug: string;
  let noteId: string, callId: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-pa", email: "pa@p.test", firstName: "Pia", role: "super_admin" }).returning();
    actor = { userId: me.id, actingAs: false };
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "polar@x.test" });
    if (!p.ok) throw new Error();
    const a = (await createAccount(db, actor, p.value)).account;
    acc = a.id;
    slug = a.slug;
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    noteId = (await addNote(db, actor, acc, { title: "Spec", body: "Warranty is 12 months. Range is 50 m." })).id;
    callId = (await addCall(db, actor, acc, { title: "Cafe call", consent: true, text: "[05:31] Rep: How do you check the fridges today?\n[06:12] Buyer: We already pay for an alarm company.\n[07:11] Rep: For three sites I can waive the installation fee." })).id;
  });
  afterAll(async () => t.close());
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    holder.after = [];
  });

  const params = { params: Promise.resolve({ account: "polar" }), searchParams: Promise.resolve({}) };
  const html = async (el: Promise<unknown>) => renderToStaticMarkup((await el) as React.ReactElement);

  it("Analyze sources: shows the estimate, is disabled without an API key, and refuses in the action", async () => {
    const page = await html(SourcesPage({ ...params, searchParams: Promise.resolve({ analyze: "confirm" }) }));
    // The analysis strip: what changed, then the estimated cost (redesign R3-3). No run has
    // finished yet, so it says so instead of comparing with a last analysis (R4 F3).
    expect(page).toContain("Your sources have not been analyzed yet");
    expect(page).toMatch(/Estimated cost \$0\.\d+/);
    expect(page).toContain("AI is not set up for this workspace yet");
    expect(page).not.toContain("Start analysis");
    expect(await go(pipeline.analyzeAction(form({ slug, token: "x", back: "sources" })))).toBe(`/app/${slug}/setup/sources?analyze_error=no_key#an-h`);
    expect(await db.select().from(pipelineRuns).where(eq(pipelineRuns.accountId, acc))).toEqual([]);
  });

  it("with a key: confirm step, a stale estimate is refused, a confirmed one queues the runs and defers the calls", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    const page = await html(SourcesPage({ ...params, searchParams: Promise.resolve({ analyze: "confirm" }) }));
    expect(page).toContain("Start analysis");
    expect(page).toMatch(/It makes 2 AI requests and costs about \$0\.\d+/);
    const token = page.match(/name="token" value="([0-9a-f]+)"/)![1];
    expect(await go(pipeline.analyzeAction(form({ slug, token: "stale", back: "sources" })))).toContain("analyze_error=changed");
    expect(await go(pipeline.analyzeAction(form({ slug, token, back: "draft" })))).toBe(`/app/${slug}/setup/playbook/draft?analyzing=1#an-h`);
    // The model calls run after the response; this test never runs them (no real API calls).
    expect(holder.after).toHaveLength(1);
    const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.accountId, acc));
    expect(runs.map((r) => [r.kind, r.status]).sort()).toEqual([["facts", "queued"], ["playbook", "queued"]]);
    expect(await go(pipeline.analyzeAction(form({ slug, token, back: "sources" })))).toContain("analyze_error=busy");
    const running = await html(SourcesPage(params));
    expect(running).toContain("Analyzing your sources");
    await db.delete(pipelineRuns).where(eq(pipelineRuns.accountId, acc));
    // Capped.
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
    expect(await go(pipeline.analyzeAction(form({ slug, token, back: "sources" })))).toContain("analyze_error=capped");
    expect(await html(SourcesPage(params))).toContain("spend cap is reached");
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 10_000 }).where(eq(sellerAccounts.id, acc));
  });

  it("after a run: About column, knowledge contradictions and gaps, draft page and call suggestions; actions work", async () => {
    const [note] = await listSections(db, acc, noteId);
    const call = await listSections(db, acc, callId);
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: {
        facts: [{ topic: "Product", statement: "Range is 50 m.", language: "en", customer_specific: false, evidence: [ev(noteId, note.locator, "Range is 50 m.")] }],
        contradictions: [{ topic: "Warranty", summary: "Warranty length", options: [
          { statement: "Warranty is 12 months.", language: "en", evidence: [ev(noteId, note.locator, "Warranty is 12 months.")] },
          { statement: "Warranty is 24 months.", language: "en", evidence: [ev(callId, call[1].locator, "alarm")] },
        ] }],
        gaps: [{ topic: "Contract", question: "Is there a minimum contract?" }],
        source_about: [{ source_id: noteId, about: "Sensor spec" }, { source_id: callId, about: "Discovery call" }],
        customer_specific: [{ source_id: callId, locator: call[1].locator, note: "Their alarm contract is about this customer." }],
      } }, usage: { inputTokens: 300, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 5000 } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: {
        goal: { text: "Sell monitoring to food businesses.", text_he: "", evidence: [ev(noteId, note.locator, "Warranty")] },
        fields: [{ key: "signatory_role", label: "Signatory role", label_he: "", stage: "before_order_form", example_question: "Who signs?", example_question_he: "", asked_in_calls: 1, evidence: [ev(callId, call[0].locator, "How do you check")] }],
        objections: [{ objection: "We already pay for an alarm company", objection_he: "יש לנו כבר חברת אזעקה", answer: "An alarm covers doors, not temperature.", answer_he: "", outcome: "meeting booked in 1 of 1 calls", evidence: [ev(callId, call[1].locator, "We already pay for an alarm company.")] }],
        limits: [{ rule: "Installation is free from 3 sites", rule_he: "", setting: "other", max_discount_percent: 0, sku: "", quantity: 0, condition: "", evidence: [ev(callId, call[2].locator, "waive the installation fee")] }],
        tone: { text: "Short and practical.", text_he: "", evidence: [ev(callId, call[0].locator, "How do you")] },
        never: [], discovery_questions: [],
      } }, usage: { inputTokens: 900, outputTokens: 3000, cacheReadTokens: 5000, cacheWriteTokens: 0 } }),
    ]);
    expect((await analyzeSources(db, llm, acc)).failed).toBeNull();

    const sourcesPage = await html(SourcesPage(params));
    expect(sourcesPage).toContain("Sensor spec");
    expect(sourcesPage).toContain("Discovery call");
    expect(sourcesPage).toContain("Nothing changed since the last analysis");
    // The runs moved behind "Run history" (?panel=runs); a platform admin still sees the tokens there.
    expect(sourcesPage).toContain("Run history");
    const history = await html(SourcesPage({ ...params, searchParams: Promise.resolve({ panel: "runs" }) }));
    expect(history).toMatch(/300 in · 2,000 out · 0 from cache · 5,000 to cache/);

    const kPage = await html(KnowledgePage(params));
    expect(kPage).toContain("Contradiction: Warranty length");
    expect(kPage).toContain("Is there a minimum contract?");
    expect(kPage).toContain("Not answered in your sources");
    expect(kPage).toContain(`href="/app/${slug}/setup/sources/${noteId}#s-0"`);
    expect(kPage).toContain("Approve all suggested (1)");

    // Approve all (every topic) leaves the contradiction; then choose a side.
    expect(await go(knowledge.approveAllAction(form({ slug, filter: "", scope: "all" })))).toContain("done=approved_all&n=1");
    const [c] = await openContradictions(db, acc);
    expect(await go(knowledge.resolveContradictionAction(form({ slug, filter: "", runId: c.runId, index: "0", choice: "" })))).toContain("error=choice");
    expect(await go(knowledge.resolveContradictionAction(form({ slug, filter: "", runId: c.runId, index: "0", choice: "other", other: "" })))).toContain("error=other");
    expect(await go(knowledge.resolveContradictionAction(form({ slug, filter: "", runId: c.runId, index: "0", choice: "other", other: "Warranty is 18 months." })))).toContain("done=resolved");
    const warranty = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, acc), eq(knowledgeFacts.topic, "Warranty")));
    expect(warranty.map((f) => [f.statement, f.status]).sort()).toEqual([["Warranty is 12 months.", "rejected"], ["Warranty is 18 months.", "approved"], ["Warranty is 24 months.", "rejected"]]);

    const callPage = await html(SourcePage({ params: Promise.resolve({ account: "polar", sourceId: callId }), searchParams: Promise.resolve({}) }));
    expect(callPage).toContain("Objection and answer that worked");
    expect(callPage).toContain("Pricing heard on the call");
    expect(callPage).toContain("Kept with this customer only");
    expect(callPage).toContain("Their alarm contract is about this customer.");
    expect(callPage).toContain("Approve rule");

    const dPage = await html(DraftPage(params));
    expect(dPage).toContain("Generated draft.");
    expect(dPage).toContain("0 of 5 suggestions reviewed");
    expect(dPage).toContain("Installation is free from 3 sites");
    expect(dPage).toContain("Approved exception, needs approval per quote");
    expect(dPage).toContain("Asked in 1 of 1 calls");
    expect(dPage).toContain("יש לנו כבר חברת אזעקה");
    const draftVersion = (await ensureDraftVersion(db, acc)).version;
    expect(dPage).toContain(`Save as agent draft v${draftVersion}`);

    const { items } = await latestSuggestions(db, acc);
    const id = (k: string) => items.find((s) => s.kind === k)!.id;
    expect(await go(draft.saveSuggestionsAction(form({ slug })))).toContain("error=none_accepted");
    expect(await go(draft.decideSuggestionAction(form({ slug, back: "draft", id: id("goal"), status: "accepted" })))).toBe(`/app/${slug}/setup/playbook/draft?done=accepted#sg-goal`);
    expect(await go(draft.decideSuggestionAction(form({ slug, back: `source:${callId}`, id: id("limit"), status: "accepted" })))).toBe(`/app/${slug}/setup/sources/${callId}?done=accepted#sg-limit`);
    expect(await go(draft.decideSuggestionAction(form({ slug, back: "draft", id: id("tone"), status: "rejected" })))).toContain("done=rejected");
    expect(await go(draft.editSuggestionAction(form({ slug, back: "draft", id: id("objection"), kind: "objection", objection: "", answer: "x" })))).toContain(`edit=${id("objection")}&error=required`);
    expect(await go(draft.editSuggestionAction(form({ slug, back: "draft", id: id("objection"), kind: "objection", objection: "We have an alarm", answer: "Doors, not temperature." })))).toContain("done=edited");
    expect(await go(draft.acceptAllSuggestionsAction(form({ slug, kinds: "field,discovery_question" })))).toContain("done=accepted_all&n=1");
    expect(await go(draft.saveSuggestionsAction(form({ slug })))).toBe(`/app/${slug}/setup/playbook/draft?done=saved&n=3&v=${draftVersion}`);
    const p = (await ensureDraftVersion(db, acc)).playbook;
    expect(p.fields.find((f) => f.key === "signatory_role")).toMatchObject({ stage: "before_order_form" });
    expect(p.neverDo).toEqual([]);
    expect(p.exceptions?.map((x) => x.text)).toEqual(["Installation is free from 3 sites"]);
    expect(p.objections).toContainEqual(expect.objectContaining({ objection: "We have an alarm" }));
    const statuses = await db.select({ s: playbookSuggestions.status }).from(playbookSuggestions).where(eq(playbookSuggestions.accountId, acc));
    expect(statuses.map((x) => x.s).sort()).toEqual(["accepted", "accepted", "accepted", "edited", "rejected"]);

    // The Playbook editor shows the exception in Limits; saving keeps it, removing it there deletes it.
    const pbPage = await html(PlaybookPage(params));
    expect(pbPage).toContain("Approved exceptions");
    expect(pbPage).toContain("Installation is free from 3 sites");
    const exId = p.exceptions![0].id;
    const editorForm = (keep: boolean) => form({
      slug, agentName: p.agentName, goal: p.goal, tone: p.tone, orderForm: "on", meeting: "on", maxDiscount: "5", offerMeetingWhen: "x", handOffWhen: "y",
      exceptionsShown: "1", ...(keep ? { exceptionId: exId } : {}),
    });
    expect(await go(playbookActions.savePlaybookAction({ status: "idle" }, editorForm(true)))).toContain("saved=1");
    expect((await ensureDraftVersion(db, acc)).playbook.exceptions?.map((x) => x.id)).toEqual([exId]);
    expect(await go(playbookActions.savePlaybookAction({ status: "idle" }, editorForm(false)))).toContain("saved=1");
    expect((await ensureDraftVersion(db, acc)).playbook.exceptions ?? []).toEqual([]);
  });

  it("run status pills and the Approved source status on the Sources page", async () => {
    const page = await html(SourcesPage(params));
    const history = await html(SourcesPage({ ...params, searchParams: Promise.resolve({ panel: "runs" }) }));
    expect(history).toContain('data-status="analysis_run.completed"');
    expect(history).toContain(">Completed<");
    // Every fact of the note is reviewed and one approved: Approved; the call has none approved: Ready for review.
    expect(page).toContain('data-status="source.approved"');
    expect(page).toContain('data-status="source.ready"');
  });

  it("draft Sales plays (UX sign-off H1): 'Accept all facts (n)', Opening keeps its Suggested tag, a card with no call says where it came from", async () => {
    const [note] = await listSections(db, acc, noteId);
    const call = await listSections(db, acc, callId);
    const run = crypto.randomUUID();
    await db.insert(pipelineRuns).values({ id: run, accountId: acc, kind: "playbook", status: "done", createdAt: new Date(Date.now() + 60_000) });
    const fromNote = [{ sourceId: noteId, locator: note.locator, quote: "Warranty" }];
    const fromCall = [{ sourceId: callId, locator: call[1].locator, quote: "alarm" }];
    const ins = (payload: Record<string, unknown>, evidence: { sourceId: string; locator: string; quote: string }[]) =>
      db.insert(playbookSuggestions).values({ id: crypto.randomUUID(), accountId: acc, runId: run, kind: "discovery_question", payload, evidence });
    await ins({ kind: "opener", topics: [{ en: "fridge alerts" }], openingQuestion: "How do you check them today?" }, fromNote);
    await ins({ kind: "play_content", play: "existing_solution", content: "An alarm covers doors, not temperature." }, fromCall);
    await ins({ kind: "play_content", play: "too_expensive", content: "A spoiled fridge costs more." }, fromNote);
    await ins({ kind: "play_card", play: "too_expensive", when: "They say it is too much.", do: ["Agree.", "Compare."], example: "True.", notThis: "No." }, fromNote);
    await ins({ kind: "play_card", play: "existing_solution", when: "They name an alarm.", do: ["Credit it.", "Name the gap."], example: "Doors, not temperature.", notThis: "Alarms are useless." }, fromCall);

    const page = await html(DraftPage(params));
    const plays = page.slice(page.indexOf('id="sg-play"'), page.indexOf("</section>", page.indexOf('id="sg-play"')));
    // Facts only in the bulk action; the count stays readable after the words.
    expect(plays).toContain(">Accept all facts (2)</button>");
    // The card from the note says so; the card from a call shows the call instead.
    expect(plays.match(/data-card-origin=""/g)).toHaveLength(1);
    expect(plays).toMatch(/data-card-origin="">From your documents<\/span>/);
    // Opening: the dashed Suggested tag stays until decided.
    const opener = page.slice(page.indexOf('data-suggestion="opener"'));
    expect(opener.slice(0, opener.indexOf("</li>"))).toContain(">Suggested<");
  });
});
