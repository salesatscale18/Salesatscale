/**
 * P11 follow-up, decisions 1 and 2, against the database: how often a question
 * was asked (update_deal_state `asked`), create_quote on a stated assumption
 * after two asks, and the local names (agent name per language, gender, local
 * trade name) in the opener, the chat header, the quote card and the order
 * form. Company settings: validation, merge, audit and account isolation.
 * Scripted model only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, messages, quotes, sellerAccounts, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCompany, saveCompany } from "@/lib/accounts/company";
import { askedCount, askedKey } from "@/lib/agent/core/facts";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { ensureDraftVersion, publishDraftVersion, readDealState, saveDraftPlaybook, startTestConversation } from "@/lib/agent/service";
import { runTool, type ToolContext, type TurnMemo } from "@/lib/agent/tools";
import { loadQuoteCards } from "@/lib/agent/quote-card-data";
import { replyToBuyer } from "@/lib/channels/whatsapp";
import { createOrderForm, displaySeller, loadForm } from "@/lib/orders/service";
import { savePlaybookForm } from "@/lib/agent/playbook-save";
import { saveLegalSection } from "@/lib/orders/settings";
import { chatNames, createSimulatedBuyer, receiveSimulatorInbound, resolveChatToken, startSimulatorConversation } from "@/lib/simulator/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const say = (text: string): Block => ({ type: "text", text });

describe("question roles and local names", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let other: string;
  const actor = () => ({ userId: me.id, actingAs: false });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "k@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const mk = async (tradeName: string) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o@${tradeName.toLowerCase()}.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000 }], { userId: me.id });
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "תנאי מכר", language: "he", body: "תנאים" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      agentName: "Maya",
      agentNameLocal: { he: "מאיה" },
      agentGender: "female",
      fields: [
        { key: "sites", label: "Number of sites", stage: "before_quote" },
        { key: "current_monitoring", label: "How they check today", stage: "optional" },
        { key: "company_name", label: "Company name", stage: "before_order_form" },
      ],
      opener: { topics: [{ en: "monitoring your fridges", he: "ניטור המקררים שלך" }], defaultTopic: 0, question: { en: "How do you check them today?", he: "איך אתם בודקים אותם היום?" } },
    });
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", tradeNameLocal: { he: "פולאר" } }).where(eq(sellerAccounts.id, acc));
  });
  afterAll(async () => t.close());

  const toolCtx = async (language = "en") => {
    const c = (await startTestConversation(db, acc, me.id, { language }))!;
    const ctx = (callId: string, memo?: TurnMemo): ToolContext => ({
      db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: c.version.playbook, currency: "ILS", callId, language, memo, agentMessages: 2,
    });
    return { c, ctx };
  };
  const ask = (keys: string[]) => ({ updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: keys });
  const quoteInput = (assumed: { key: string; value: string }[] | null = null) => ({
    lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null, headline: null, assumed,
  });

  describe("decision 1: question roles", () => {
    it("counts each asked field once per turn, under a reserved key that never shows as a field", async () => {
      const { c, ctx } = await toolCtx();
      const memo: TurnMemo = {};
      const r = await runTool("update_deal_state", ask(["sites", "current_monitoring", "nope", "_asked_sites"]), ctx("a1", memo));
      expect(r).toMatchObject({ outcome: "ok", result: { recorded_as_asked: ["sites", "current_monitoring"] } });
      // A second call in the same turn does not count again.
      const again = await runTool("update_deal_state", ask(["sites"]), ctx("a2", memo));
      expect(again.result).not.toHaveProperty("recorded_as_asked");
      let deal = (await readDealState(db, acc, c.leadId))!;
      expect(askedCount(deal.fields, "sites")).toBe(1);
      expect(askedCount(deal.fields, "current_monitoring")).toBe(1);
      expect(deal.fields[askedKey("nope")]).toBeUndefined();
      // The stage block lists both as asked and not answered, each with what its role allows next.
      expect(again.result.stage).toContain("Asked and not answered: Number of sites (asked once; needed for the quote: ask once more, in different words, just before the quote); How they check today (asked once; helps the pitch: do not ask it in the next messages; you may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply).");
      // Next turn: counted again.
      await runTool("update_deal_state", ask(["sites"]), ctx("a3", {}));
      deal = (await readDealState(db, acc, c.leadId))!;
      expect(askedCount(deal.fields, "sites")).toBe(2);
      // Reserved keys cannot be written as fields.
      const bad = await runTool("update_deal_state", { ...ask([]), updates: [{ key: askedKey("sites"), value: "0", provenance: "buyer" }] }, ctx("a4"));
      expect(bad).toMatchObject({ outcome: "refused", rule: "Unknown deal-state fields" });
      expect(askedCount((await readDealState(db, acc, c.leadId))!.fields, "sites")).toBe(2);
    });

    it("create_quote: never asked is refused (ask first), asked once is refused (ask again), asked twice quotes on a stated assumption", async () => {
      const { c, ctx } = await toolCtx();
      const never = await runTool("create_quote", quoteInput([{ key: "sites", value: "1" }]), ctx("q1"));
      expect(never).toMatchObject({ outcome: "refused", rule: "Before-quote fields missing", result: { missing: ["Number of sites"], not_asked_yet: ["Number of sites"] } });

      await runTool("update_deal_state", ask(["sites"]), ctx("q2", {}));
      const once = await runTool("create_quote", quoteInput([{ key: "sites", value: "1" }]), ctx("q3"));
      expect(once).toMatchObject({ outcome: "refused", rule: "Before-quote fields missing", result: { asked_once: ["Number of sites"] } });
      expect(String(once.result.message)).toContain("Ask once more, in different words");

      await runTool("update_deal_state", ask(["sites"]), ctx("q4", {}));
      // Asked twice, but no assumed value: the result says how to go on.
      const noValue = await runTool("create_quote", quoteInput(null), ctx("q5"));
      expect(noValue).toMatchObject({ outcome: "refused", rule: "Assumption needed", result: { missing: ["Number of sites"], keys: ["sites"] } });
      // A placeholder is not an assumption.
      const placeholder = await runTool("create_quote", quoteInput([{ key: "sites", value: "unknown" }]), ctx("q6"));
      expect(placeholder).toMatchObject({ outcome: "refused", rule: "Assumption needed" });
      expect((await db.select().from(quotes).where(eq(quotes.leadId, c.leadId)))).toHaveLength(0);

      const ok = await runTool("create_quote", quoteInput([{ key: "sites", value: "1" }]), ctx("q7"));
      expect(ok).toMatchObject({ outcome: "ok", result: { ok: true, status: "ready", quoted_on_assumption: [{ field: "Number of sites", value: "1" }] } });
      expect(String(ok.result.message)).toContain("Say in one short clause what you assumed");
      // The assumption is recorded as inferred, so the order form is not held back by it.
      const deal = (await readDealState(db, acc, c.leadId))!;
      expect(deal.fields.sites).toMatchObject({ value: "1", provenance: "inferred" });
      expect(await db.select().from(quotes).where(eq(quotes.leadId, c.leadId))).toHaveLength(1);
    });

    it("a pitch question never blocks the quote, and a known field needs no ask", async () => {
      const { ctx } = await toolCtx();
      await runTool("update_deal_state", { ...ask([]), updates: [{ key: "sites", value: "1", provenance: "buyer" }] }, ctx("p1"));
      const r = await runTool("create_quote", quoteInput(null), ctx("p2"));
      expect(r).toMatchObject({ outcome: "ok", result: { ok: true } });
      expect(r.result).not.toHaveProperty("quoted_on_assumption");
    });

    it("the opt-out refusal still applies", async () => {
      const { c, ctx } = await toolCtx();
      await runTool("update_deal_state", { ...ask([]), updates: [{ key: "sites", value: "1", provenance: "buyer" }] }, ctx("o1"));
      await runTool("record_opt_out", { reason: "stop" }, ctx("o2"));
      const r = await runTool("create_quote", quoteInput(null), ctx("o3"));
      expect(r).toMatchObject({ outcome: "refused", rule: "Lead opted out" });
      expect(await db.select().from(quotes).where(eq(quotes.leadId, c.leadId))).toHaveLength(0);
    });
  });

  describe("decision 2: names in the buyer's language", () => {
    it("opener: Hebrew name, Hebrew trade name and feminine grammar for a Hebrew lead; English names for an English lead", async () => {
      const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
      const start = async (fullName: string, language: string) => {
        const b = await createSimulatedBuyer(db, actor(), account, { fullName, company: "Lab", language, country: "IL" });
        if (!b.ok) throw new Error(JSON.stringify(b.errors));
        const s = await startSimulatorConversation(db, actor(), acc, b.lead.id);
        if (!s.ok) throw new Error(s.reason);
        const [m] = await db.select().from(messages).where(eq(messages.id, s.messageId));
        return { body: m.body, token: b.token };
      };
      const he = await start("רינה כהן", "he");
      expect(he.body).toBe("היי רינה, כאן מאיה, העוזרת האוטומטית של פולאר. פנית אלינו בנושא ניטור המקררים שלך. איך אתם בודקים אותם היום?");
      const en = await start("Rina Cohen", "en");
      expect(en.body).toBe("Hi Rina, this is Maya, the automated assistant of Polar. You asked about monitoring your fridges. How do you check them today?");

      // The agent is told, per turn and in the conversation's language, its names and its grammatical gender.
      const chat = (await resolveChatToken(db, he.token))!;
      const inbound = await receiveSimulatorInbound(db, chat, "שני מקררים", crypto.randomUUID());
      if (inbound.kind !== "stored") throw new Error(inbound.kind);
      const llm = new ScriptedLlm([() => ({ content: [say("מעולה. כמה אתרים?")] })]);
      await replyToBuyer(db, llm, null, inbound);
      const [stable, context] = llm.requests[0].system;
      expect(context).toContain("## Names in this conversation (Hebrew)\nYour name: מאיה. The seller's name: פולאר.");
      expect(context).toContain("Speak of yourself in the feminine");
      // The stable prompt keeps the English names only: per-language names live in the turn context.
      expect(stable).not.toContain("מאיה");
      expect(stable).not.toContain("פולאר");
    });

    it("chat header: names and grammar follow the language and the gender", async () => {
      const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
      expect(await chatNames(db, account, "he")).toEqual({ agent: "מאיה", seller: "פולאר", gender: "female", language: "he" });
      expect(await chatNames(db, account, "en")).toEqual({ agent: "Maya", seller: "Polar", gender: "female", language: "en" });
      // Another account's live agent is never read.
      const [o] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, other));
      expect(await chatNames(db, o, "he")).toMatchObject({ agent: "Other assistant", seller: "Other", gender: "neutral" });
    });

    it("quote card and order form show the seller's name in the buyer's language", async () => {
      for (const [language, seller] of [["he", "פולאר"], ["en", "Polar"]] as const) {
        const { c, ctx } = await toolCtx(language);
        await runTool("update_deal_state", { ...ask([]), updates: [{ key: "sites", value: "1", provenance: "buyer" }] }, ctx(`n1-${language}`));
        const q = await runTool("create_quote", quoteInput(null), ctx(`n2-${language}`));
        expect(q.outcome).toBe("ok");
        // As a turn stores it: the card is read from the create_quote call.
        await db.insert(toolCalls).values({ accountId: acc, conversationId: c.conversationId, sequence: 1, name: "create_quote", input: {}, result: q.result, outcome: "ok" });
        const cards = await loadQuoteCards(db, acc, [c.conversationId], { audience: "buyer" });
        const card = cards[String(q.result.quote_message_id)];
        expect(card).toMatchObject({ seller, lang: language });

        const form = await createOrderForm(db, acc, { kind: "agent" }, String(q.result.quote_id), { language });
        if (!form.ok) throw new Error(form.reason);
        const view = (await loadForm(db, form.token))!;
        // The form keeps the names as they were when it was made, and the buyer can switch language.
        expect(displaySeller(view.form, language)).toBe(seller);
        expect(displaySeller(view.form, "en")).toBe("Polar");
        expect(displaySeller(view.form, "he")).toBe("פולאר");
      }
    });
  });

  describe("playbook editor: agent name per language and gender", () => {
    it("saves them into the draft, keeps them when a form does not send them, and refuses bad input", async () => {
      const base: [string, string][] = [["agentName", "Maya"], ["goal", "Sell."], ["maxDiscount", "5"]];
      expect(await savePlaybookForm(db, acc, [...base, ["agentNameLocal.he", "מאיה"], ["agentGender", "female"]])).toEqual({ ok: true });
      let draft = await ensureDraftVersion(db, acc);
      expect(draft.playbook).toMatchObject({ agentNameLocal: { he: "מאיה" }, agentGender: "female" });
      expect(await savePlaybookForm(db, acc, base)).toEqual({ ok: true });
      draft = await ensureDraftVersion(db, acc);
      expect(draft.playbook).toMatchObject({ agentNameLocal: { he: "מאיה" }, agentGender: "female" });
      const bad = await savePlaybookForm(db, acc, [...base, ["agentNameLocal.he", "Maya"], ["agentGender", "robot"]]);
      expect(bad).toMatchObject({ ok: false, errors: { "agentNameLocal.he": expect.any(String), agentGender: expect.any(String) } });
      // Cleared on purpose: the Hebrew buyers see the English name again.
      expect(await savePlaybookForm(db, acc, [...base, ["agentNameLocal.he", ""], ["agentGender", "neutral"]])).toEqual({ ok: true });
      draft = await ensureDraftVersion(db, acc);
      expect(draft.playbook.agentNameLocal).toBeUndefined();
      expect(draft.playbook.agentGender).toBe("neutral");
      // The other account's draft is untouched.
      expect((await ensureDraftVersion(db, other)).playbook.agentNameLocal).toBeUndefined();
    });
  });

  describe("company settings: trade name per buyer language", () => {
    it("validates on the server: Hebrew letters and a length limit", () => {
      const base = { tradeName: "Polar", brandColor: "#0e6fb8" };
      expect(parseCompany({ ...base, "tradeNameLocal.he": "Polar" })).toMatchObject({ ok: false, errors: { "tradeNameLocal.he": expect.stringContaining("Hebrew letters") } });
      expect(parseCompany({ ...base, "tradeNameLocal.he": "פ".repeat(121) })).toMatchObject({ ok: false, errors: { "tradeNameLocal.he": "Use 120 characters or fewer." } });
      expect(parseCompany({ ...base, "tradeNameLocal.he": "  פולאר   ניטור " })).toMatchObject({ ok: true, value: { tradeNameLocal: { he: "פולאר ניטור" } } });
      // A form without the input keeps what is stored.
      const r = parseCompany(base);
      expect(r.ok && r.value.tradeNameLocal).toBeUndefined();
      // C2: any language of the account's markets can have its own version, in that language's script.
      const en = parseCompany({ ...base, "tradeNameLocal.en": "Polar EN" });
      expect(en.ok && en.value.tradeNameLocal).toEqual({ en: "Polar EN" });
      expect(parseCompany({ ...base, "tradeNameLocal.en": "פולאר" })).toMatchObject({ ok: false, errors: { "tradeNameLocal.en": expect.stringContaining("English letters") } });
    });

    it("saves, clears and audits in this account only", async () => {
      const save = async (raw: Record<string, string>, acting = true) => {
        const p = parseCompany({ tradeName: "Other", brandColor: "#0e6fb8", ...raw });
        if (!p.ok) throw new Error(JSON.stringify(p.errors));
        return saveCompany(db, { userId: me.id, actingAs: acting }, other, p.value);
      };
      const read = async (id: string) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0].tradeNameLocal;
      expect(await save({ "tradeNameLocal.he": "אחר" })).toEqual({ ok: true });
      expect(await read(other)).toEqual({ he: "אחר" });
      // The other account is untouched.
      expect(await read(acc)).toEqual({ he: "פולאר" });
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, other), eq(auditLog.action, "company.saved")));
      expect(audits.at(-1)?.details).toMatchObject({ tradeNameLocal: { he: "אחר" } });
      // Without the input the name is kept; an empty input clears it.
      await save({});
      expect(await read(other)).toEqual({ he: "אחר" });
      await save({ "tradeNameLocal.he": "" });
      expect(await read(other)).toBeNull();
      expect(await read(acc)).toEqual({ he: "פולאר" });
    });
  });
});
