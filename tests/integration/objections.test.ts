/**
 * O1, the objection record through the tools (PGlite): update_deal_state
 * writes it (validated, nothing written on a bad input), rows written before
 * O1 are read and rewritten in the new shape, attempts stop at the setting,
 * every read is scoped by account, and the hand-over brief carries the
 * objections. No model calls: the tools run directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { dealStates, leadEvents, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { getDealState, startTestConversation } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { latestHandoff } from "@/lib/conversations/inbox";
import { loadDealPane } from "@/lib/leads/deal-pane";
import { leadStage } from "@/lib/leads/stage";
import { createTestDb, type TestDb } from "../helpers/db";

describe("O1: the objection record", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const actor = () => ({ userId: me.id, actingAs: false });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-o1", email: "o1@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Acme");
    other = await mk("Other");
  });
  afterAll(async () => t.close());

  const start = async (accountId = acc) => {
    const c = (await startTestConversation(db, accountId, me.id, { language: "en" }))!;
    let n = 0;
    const ctx = (): ToolContext => ({ db, accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: c.version.playbook, currency: "ILS", callId: `c${++n}`, agentMessages: 3 });
    return { c, ctx };
  };
  const update = (o: unknown, extra: Record<string, unknown> = {}) => ({ updates: [], next_step: null, objection: o, recommendation_confirmed: null, price_asked: null, asked: null, ...extra });

  it("writes an objection, counts its attempts and returns what is recorded", async () => {
    const { c, ctx } = await start();
    const r1 = await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "That is a lot", step: 1, attempt: false, status: "open" }), ctx());
    expect(r1.outcome).toBe("ok");
    expect(r1.result).toMatchObject({ objection_recorded: { play: "too_expensive", status: "open", steps_used: [1], attempts: 0 } });
    expect(String(r1.result.stage)).toContain(`Paused: the buyer has an open objection ("Too expensive": "That is a lot")`);
    await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "", step: 2, attempt: true, status: "open" }), ctx());
    const r3 = await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "", step: 4, attempt: true, status: "open" }), ctx());
    expect(r3.result).toMatchObject({ objection_recorded: { steps_used: [1, 2, 4], attempts: 2 }, objection_note: expect.stringContaining("last attempt") });
    // A third attempt is not counted: two by default (the seller's setting comes with part 3).
    const r4 = await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "", step: 5, attempt: true, status: "open" }), ctx());
    expect(r4.result).toMatchObject({ objection_recorded: { attempts: 2 }, objection_note: expect.stringContaining("No attempts left") });
    // A step already used is not recorded again.
    const r5 = await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "", step: 2, attempt: true, status: "open" }), ctx());
    expect(r5.result.objection_note).toContain("Step 2 was already used");
    expect((await getDealState(db, acc, c.leadId))?.objections).toEqual([{ play: "too_expensive", words: "That is a lot", steps: [1, 2, 4, 5], status: "open", attempts: 2 }]);
    // A buying signal: settled; the stage is no longer paused.
    const r6 = await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "", step: null, attempt: false, status: "settled" }, { recommendation_confirmed: true }), ctx());
    expect(String(r6.result.stage)).not.toContain("Paused");
    expect((await leadStage(db, acc, c.leadId))?.objection).toBeNull();
  });

  it("refuses a bad objection and writes nothing, not even the fields in the same call", async () => {
    const { c, ctx } = await start();
    const fields = { updates: [{ key: "sites", value: "2", provenance: "buyer" }] };
    for (const bad of [
      { play: "fit", buyer_words: "x", step: null, attempt: false, status: "open" },
      { play: "too_expensive", buyer_words: "x", step: null, attempt: false, status: "handled" },
      { play: "too_expensive", buyer_words: "x", step: 9, attempt: false, status: "open" },
      { text: "Too expensive", handled: false },
    ]) {
      const r = await runTool("update_deal_state", update(bad, fields), ctx());
      expect(r.outcome, JSON.stringify(bad)).toBe("refused");
      expect(r.result).toMatchObject({ rule: "Invalid objection" });
    }
    const d = await getDealState(db, acc, c.leadId);
    expect(d?.objections ?? []).toEqual([]);
    expect(d?.fields.sites).toBeUndefined();
    // null is no objection: the fields are saved.
    expect((await runTool("update_deal_state", update(null, fields), ctx())).outcome).toBe("ok");
    expect((await getDealState(db, acc, c.leadId))?.fields.sites?.value).toBe("2");
  });

  it("reads a row written before O1 and rewrites it in the new shape on the next write", async () => {
    const { c, ctx } = await start();
    await runTool("update_deal_state", update(null), ctx());
    await db.update(dealStates).set({ objections: [{ text: "Too expensive", handled: false }, { text: "Has an alarm", handled: true }] })
      .where(and(eq(dealStates.accountId, acc), eq(dealStates.leadId, c.leadId)));
    const pane = await loadDealPane(db, acc, { id: c.leadId, fullName: "Dana Levi" }, "Acme");
    expect(pane.objections.map((o) => o.line)).toEqual(["Too expensive · open", "Has an alarm · settled"]);
    expect((await leadStage(db, acc, c.leadId))?.objection).toBe("Too expensive");
    await runTool("update_deal_state", update({ play: "someone_else_decides", buyer_words: "My partner decides", step: 1, attempt: false, status: "open" }), ctx());
    expect((await getDealState(db, acc, c.leadId))?.objections).toEqual([
      { play: null, words: "Too expensive", steps: [], status: "dropped", attempts: 0 },
      { play: null, words: "Has an alarm", steps: [], status: "settled", attempts: 0 },
      { play: "someone_else_decides", words: "My partner decides", steps: [1], status: "open", attempts: 0 },
    ]);
    const after = await loadDealPane(db, acc, { id: c.leadId, fullName: "Dana Levi" }, "Acme");
    expect(after.objections.map((o) => o.line)).toEqual(["Too expensive · dropped", "Has an alarm · settled", "Needs someone else's agreement · open"]);
  });

  it("the hand-over brief carries the objections; another account's lead reads nothing", async () => {
    const { c, ctx } = await start();
    await runTool("update_deal_state", update({ play: "too_expensive", buyer_words: "Too much", step: 2, attempt: true, status: "open" }), ctx());
    await runTool("update_deal_state", update({ play: "handoff", buyer_words: "This is ridiculous", step: 1, attempt: false, status: "open" }), ctx());
    const h = await runTool("hand_off_to_human", { reason: "The buyer is upset", summary: "Wants 20% off", suggested_reply: "" }, ctx());
    expect(h.outcome).toBe("ok");
    const brief = await latestHandoff(db, acc, c.leadId);
    expect(brief?.reason).toBe("The buyer is upset");
    expect(brief?.objections).toEqual([
      { play: "too_expensive", words: "Too much", steps: [2], status: "dropped", attempts: 1 },
      { play: "handoff", words: "This is ridiculous", steps: [1], status: "open", attempts: 0 },
    ]);
    expect(await latestHandoff(db, other, c.leadId)).toBeNull();
    // A brief written before O1 has no objections.
    const old = await start();
    await db.insert(leadEvents).values({ id: crypto.randomUUID(), accountId: acc, leadId: old.c.leadId, type: "handoff.requested", actor: "agent", data: { reason: "r", summary: "s" } });
    expect((await latestHandoff(db, acc, old.c.leadId))?.objections).toEqual([]);
  });

  it("no knowledge found: the reply points to the no-answer play and never to a hand-off", async () => {
    const { ctx } = await start();
    const r = await runTool("lookup_knowledge", { query: "on-site training in our city" }, ctx());
    expect(r.result).toMatchObject({ ok: true, facts: [] });
    expect(String(r.result.message)).toContain('"A question with no approved answer"');
    expect(String(r.result.message)).not.toMatch(/offer to check with the team|hand_off/);
  });
});
