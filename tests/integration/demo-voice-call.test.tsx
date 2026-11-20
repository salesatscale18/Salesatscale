/**
 * The demo account's finished buyer voice call (lib/demo/voice-call-seed.ts):
 * the voice session row, the spoken lines linked to it, the engine's closing
 * note, and the lead page and Conversations render with the call's marks.
 * No model call: every row is stored.
 *
 * With VOICE_DEMO_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { consentRecords, conversations, leads, messages, sellerAccounts, toolCalls, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
// No real model client may be built: the seed spends nothing.
const h = vi.hoisted(() => ({ anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example.com" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { VOICE_CALL, VOICE_CALL_CHAT, VOICE_CALL_LEAD, VOICE_CALL_LINES, callEndedText } = await import("@/lib/demo/voice-call-seed");
const VOICE_CALL_CHAT_AGENT = VOICE_CALL_CHAT.agent;
const { needsYou } = await import("@/lib/overview/service");
const { buyerCallRows, buyerConversation, hasVoiceConsent } = await import("@/lib/voice/buyer");
const { voiceSessionSummary } = await import("@/lib/voice/service");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const OUT = process.env.VOICE_DEMO_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
}

const NOW = new Date("2026-11-19T09:00:00Z");

describe("demo account: a finished buyer voice call", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let acc: SellerAccount;
  let leadId = "";
  let convId = "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    if (!a.ok) throw new Error("refused");
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, a.summary.accountId));
    const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, acc.id), eq(leads.fullName, VOICE_CALL_LEAD.fullName)));
    leadId = lead.id;
    const conv = await buyerConversation(db, { account: acc, lead });
    convId = conv!.id;
    holder.access = { account: acc, user: admin, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("is an agent-handled English lead in the Israel market, whose web chat the call joined", async () => {
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ company: VOICE_CALL_LEAD.company, language: "en", status: "agent_handling" });
    expect(lead.marketId).not.toBeNull();
    const convs = await db.select().from(conversations).where(eq(conversations.leadId, leadId));
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: "simulator", status: "open", isTest: false });
    // The buyer agreed to the voice call; the lead still has one consent record.
    expect(await hasVoiceConsent(db, acc.id, leadId)).toBe(true);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, leadId))).toHaveLength(1);
  });

  it("has one ended voice session: scripted, cost 0, ended by the buyer", async () => {
    const rows = await db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, convId));
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s).toMatchObject({
      accountId: acc.id, status: "ended", mode: "scripted", model: "google/gemini-3.8-live", isTest: false, startedByUserId: null,
      costMicros: 0, durationSec: VOICE_CALL.durationSec, endReason: "user_hangup", answerMsAvg: 817,
    });
    expect(s.connectedAt).not.toBeNull();
    expect(s.endedAt!.getTime() - s.connectedAt!.getTime()).toBe(VOICE_CALL.durationSec * 1000);
    expect(s.ticketHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.ticketUsedAt).not.toBeNull();
    // The services that read calls back see it.
    const summary = await voiceSessionSummary(db, acc.id, convId);
    expect(summary).toMatchObject({ mode: "scripted", costMicros: 0, durationSec: VOICE_CALL.durationSec, endReason: "user_hangup" });
    expect(summary!.turns.map((x) => x.answerMs)).toEqual([null, 850, 700, 900]);
    expect(await buyerCallRows(db, acc.id, [convId])).toEqual([{ id: s.id, startedAt: s.connectedAt!.toISOString(), at: s.endedAt!.toISOString(), durationSec: VOICE_CALL.durationSec, empty: false }]);
  });

  it("stores the spoken lines in the conversation, linked to the call, after the chat and before the closing note", async () => {
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, convId));
    const thread = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt));
    const spoken = thread.filter((m) => m.voiceSessionId);
    expect(spoken).toHaveLength(7);
    for (const m of spoken) {
      expect(m.voiceSessionId).toBe(s.id);
      expect(m.spokenAtMs).not.toBeNull();
      expect(m.createdAt.getTime()).toBeGreaterThan(s.connectedAt!.getTime());
      expect(m.createdAt.getTime()).toBeLessThanOrEqual(s.endedAt!.getTime());
      if (m.actor === "buyer") expect(m.answerMs).toBeNull();
    }
    // The call opens with a short line picking up from the chat: no greeting, no introduction, no bot notice.
    expect(spoken[0]).toMatchObject({ actor: "agent", answerMs: null, body: VOICE_CALL_LINES.pickUp });
    expect(spoken[0].body).not.toMatch(/automated assistant|^Hi /);
    expect(spoken.filter((m) => m.typedInCall).map((m) => m.body)).toEqual([VOICE_CALL_LINES.typed]);
    // Three chat messages first; the engine's note last.
    expect(thread.slice(0, 3).every((m) => !m.voiceSessionId)).toBe(true);
    expect(thread.at(-1)).toMatchObject({ actor: "system", body: callEndedText(VOICE_CALL.durationSec), voiceSessionId: null });
    expect(callEndedText(VOICE_CALL.durationSec)).toBe("Voice call ended · 1:04");
    expect(thread.at(-1)!.createdAt.getTime()).toBe(s.endedAt!.getTime());
    // The agent turn's tool call is linked to its message.
    const calls = await db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, convId), isNotNull(toolCalls.messageId)));
    expect(calls.map((c) => c.name)).toEqual(["update_deal_state"]);
    expect(spoken.find((m) => m.id === calls[0].messageId)?.body).toBe(VOICE_CALL_LINES.plan);
  });

  it("leaves Needs you as it was: the lead waits for nobody", async () => {
    expect((await needsYou(db, acc.id, NOW)).some((i) => i.leadId === leadId)).toBe(false);
  });

  // The call's start and summary markers come from the session row; the stored "Voice call ended" line is not shown twice.

  it("the lead page shows the call: start and summary markers, spoken and typed marks", async () => {
    const html = await page(LeadCardPage, { account: acc.slug, leadId });
    save("lead-voice-call", html);
    expect(html).toContain(VOICE_CALL_LINES.fridges);
    expect((html.match(/data-spoken=""/g) ?? []).length).toBe(7);
    expect(html).toContain('aria-label="Spoken at 0:01 in the call"');
    expect(html).toContain('aria-label="Typed at 0:31 in the call"');
    expect(html).toContain(VOICE_CALL_LINES.typed);
    expect(html).toContain('data-thread-marker="voice_started"');
    expect(html).toContain('data-thread-marker="voice_ended"');
    expect(html).toMatch(/Voice call · 1 min 4 s/);
    expect(html).not.toContain(callEndedText(VOICE_CALL.durationSec));
    // Order: start marker, the call's lines, then the summary marker.
    const start = html.indexOf('data-thread-marker="voice_started"');
    expect(start).toBeLessThan(html.indexOf(VOICE_CALL_LINES.fridges));
    expect(html.indexOf(VOICE_CALL_LINES.bye)).toBeLessThan(html.indexOf('data-thread-marker="voice_ended"'));
    expect(html.indexOf(VOICE_CALL_CHAT_AGENT)).toBeLessThan(start);
  });

  it("Conversations shows the same call", async () => {
    const html = await page(ConversationsPage, { account: acc.slug }, { c: convId });
    save("conversations-voice-call", html);
    expect(html).toContain('data-thread-marker="voice_ended"');
    expect(html).toContain('aria-label="Typed at 0:31 in the call"');
  });
});
