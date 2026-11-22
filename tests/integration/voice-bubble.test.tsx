/**
 * The voice bubble (live voice, step 2) on PGlite with the free scripted model: the order form's step reaches
 * the model as a quiet, throttled note; the server makes the tab link's key only for the chat and for an order
 * form of the same conversation; the form page carries the link only then; the bubble renders state words only.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import type { ContactHours } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer, startSimulatorConversation, resolveChatLink } = await import("@/lib/simulator/service");
const { buyerConversation, startBuyerVoiceCall } = await import("@/lib/voice/buyer");
const { voiceTabKey, voiceTabKeyForForm } = await import("@/lib/voice/tab-key");
const { ManualClock, flushAsync } = await import("@/lib/voice/realtime");
const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const { createQuote } = await import("@/lib/quotes/service");
const { createOrderForm, loadForm } = await import("@/lib/orders/service");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");
const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { VoiceBubble } = await import("@/components/sas/voice/voice-bubble");
const { translator } = await import("@/lib/i18n");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let account: SellerAccount;

async function newBuyer(name: string) {
  const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, { ...account, allowSimulatedBuyers: true }, { fullName: name, company: "Shop", language: "en", country: "IL" });
  if (!made.ok) throw new Error("buyer");
  const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, account.id, made.lead.id);
  if (!started.ok) throw new Error(`start ${started.reason}`);
  return { token: made.token, leadId: made.lead.id, conversationId: started.conversationId };
}
async function formFor(leadId: string) {
  const q = await createQuote(db, account.id, { kind: "human", userId: me.id, actingAs: false }, leadId, { lines: [{ sku: "SEAT-M", qty: 1 }], discountBp: 0 });
  if (!q.ok) throw new Error(q.reason);
  const f = await createOrderForm(db, account.id, { kind: "human", userId: me.id, actingAs: false }, q.quote.id);
  if (!f.ok) throw new Error(f.reason);
  return f.token;
}
const page = async (token: string) => renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [me] = await db.insert(users).values({ clerkId: "o", email: "owner@p.test", firstName: "Owen", role: "user" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, id, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, id, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, id);
  await publishDraftVersion(db, { userId: me.id, actingAs: false }, id);
  await db.update(sellerAccounts).set({ status: "live", allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

describe("the order form's step reaches the call", () => {
  it("as a note the model reads but does not answer, at most one per 5 s, step names only", async () => {
    const b = await newBuyer("Note Buyer");
    const link = await resolveChatLink(db, b.token);
    if (!link) throw new Error("link");
    const r = await startBuyerVoiceCall(db, link.ctx, b.token, { deadlineSec: 270, env: SCRIPTED });
    if (!r.ok) throw new Error(r.reason);
    class Fake extends EventEmitter {
      out: (string | Uint8Array)[] = [];
      bufferedAmount = 0;
      send(d: string | Uint8Array) { this.out.push(d); }
      close() { setImmediate(() => this.emit("close")); }
    }
    const ws = new Fake();
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model, limits: { standbyAfterQuietMs: 600_000 } });
    const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
    const send = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
    send({ t: "auth", sessionId: r.sessionId, ticket: r.ticket });
    await settle();
    await clock.advance(15_000, settle);
    const conn = model.connections[0];
    const responsesBefore = conn.sent.responses.length;
    const textsBefore = conn.sent.texts.length;
    send({ t: "context", kind: "order_form", step: "order", label: "Your order", event: "opened" });
    send({ t: "context", kind: "order_form", step: "company", label: "Your company", event: "step" });
    // Junk is dropped by the parser: never a note.
    send({ t: "context", kind: "order_form", step: "company", label: "Rina's Kitchen Ltd 512345678", event: "typed" });
    await settle();
    expect(conn.notes).toHaveLength(1);
    expect(conn.notes[0]).toContain("The buyer opened the order form, on step: Your order");
    await clock.advance(5_000, settle);
    expect(conn.notes).toHaveLength(2);
    expect(conn.notes[1]).toContain("on step: Company details");
    expect(conn.notes.join(" ")).not.toContain("Rina");
    // A note asks for no answer and is not a buyer turn.
    expect(conn.sent.responses.length).toBe(responsesBefore);
    expect(conn.sent.texts.length).toBe(textsBefore);
    // The browser hears nothing about it (no transcript line, no tool chip).
    const json = ws.out.filter((x): x is string => typeof x === "string").join("\n");
    expect(json).not.toContain("order form open");
    send({ t: "end" });
    await clock.advance(5_000, settle);
    ws.emit("close");
    await settle();
    await done;
  });
});

describe("the order form and standby (step 3)", () => {
  it("the form being open lifts the idle end; a form note on standby never wakes the model and goes in with the next wake", async () => {
    const b = await newBuyer("Standby Buyer");
    const link = await resolveChatLink(db, b.token);
    if (!link) throw new Error("link");
    const r = await startBuyerVoiceCall(db, link.ctx, b.token, { deadlineSec: 270, env: SCRIPTED });
    if (!r.ok) throw new Error(r.reason);
    class Fake extends EventEmitter {
      out: (string | Uint8Array)[] = [];
      bufferedAmount = 0;
      send(d: string | Uint8Array) { this.out.push(d); }
      close() { setImmediate(() => this.emit("close")); }
    }
    const ws = new Fake();
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model, limits: { standbyAfterQuietMs: 2_000, standbyIdleEndMs: 5_000 } });
    const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
    const send = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
    const json = () => ws.out.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as { t: string; state?: string; reason?: string });
    send({ t: "auth", sessionId: r.sessionId, ticket: r.ticket });
    await settle();
    for (let i = 0; i < 60 && !json().some((m) => m.t === "state" && m.state === "standby"); i++) await clock.advance(500, settle);
    expect(json().some((m) => m.t === "state" && m.state === "standby")).toBe(true);
    expect(model.connections).toHaveLength(1);
    expect(model.connections[0].closed).toBe(true);
    // The buyer opens the form on standby: no wake (no new model connection), the note waits.
    send({ t: "context", kind: "order_form", step: "company", label: "Your company", event: "opened" });
    await clock.advance(1_000, settle);
    expect(model.connections).toHaveLength(1);
    expect(model.connections[0].notes.some((n) => n.includes("Company details"))).toBe(false);
    // Well past the idle end: the call stays on while the form is open.
    await clock.advance(30_000, settle);
    expect(json().some((m) => m.t === "ended")).toBe(false);
    // A tap wakes it: the new connection reads the held note (with its fresh instructions and recap).
    send({ t: "wake" });
    await clock.advance(1_000, settle);
    expect(model.connections).toHaveLength(2);
    // The woken model reads it in its instructions; no note item that could prompt an answer.
    expect(model.connections[1].notes).toHaveLength(0);
    expect(model.connections[1].cfg.instructions).toContain("The buyer opened the order form, on step: Company details");
    send({ t: "end" });
    await clock.advance(5_000, settle);
    ws.emit("close");
    await settle();
    await done;
  });

  it("without the form, standby ends a quiet call (idle), as step 3 does", async () => {
    const b = await newBuyer("Idle Buyer");
    const link = await resolveChatLink(db, b.token);
    if (!link) throw new Error("link");
    const r = await startBuyerVoiceCall(db, link.ctx, b.token, { deadlineSec: 270, env: SCRIPTED });
    if (!r.ok) throw new Error(r.reason);
    class Fake extends EventEmitter {
      out: (string | Uint8Array)[] = [];
      bufferedAmount = 0;
      send(d: string | Uint8Array) { this.out.push(d); }
      close() { setImmediate(() => this.emit("close")); }
    }
    const ws = new Fake();
    const clock = new ManualClock();
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model: new ScriptedRealtime({ clock }), limits: { standbyAfterQuietMs: 2_000, standbyIdleEndMs: 5_000 } });
    const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: r.sessionId, ticket: r.ticket })), false);
    await settle();
    await clock.advance(40_000, settle);
    const ended = ws.out.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as { t: string; reason?: string }).find((m) => m.t === "ended");
    expect(ended?.reason).toBe("idle");
    ws.emit("close");
    await settle();
    await done;
  });
});

describe("the tab link's key (server-made, never a raw token)", () => {
  it("the chat and an order form of the same conversation get the same key; another lead's form never does", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const a = await newBuyer("Key Buyer A");
    const b = await newBuyer("Key Buyer B");
    const convA = await buyerConversation(db, { account, lead: { id: a.leadId } } as Parameters<typeof buyerConversation>[1]);
    const chatKey = voiceTabKey(convA!.id);
    expect(chatKey).toMatch(/^sas-voice-[A-Za-z0-9_-]{22}$/);
    expect(chatKey).not.toContain(convA!.id);
    expect(chatKey).not.toContain(a.token);
    const formA = await formFor(a.leadId);
    const formB = await formFor(b.leadId);
    const keyOf = async (token: string) => {
      const v = await loadForm(db, token);
      if (!v) throw new Error("form");
      return voiceTabKeyForForm(db, v.form, SCRIPTED);
    };
    expect(await keyOf(formA)).toBe(chatKey);
    const keyB = await keyOf(formB);
    expect(keyB).not.toBe(chatKey);
    expect(keyB).toBe(voiceTabKey(b.conversationId));
    // A lead with no buyer chat (a real WhatsApp lead): no key.
    const pr = parseLead({ fullName: "Real Lead", company: "Co", email: "r@x.test", phone: "0525550901", language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!pr.ok) throw new Error("lead");
    const l = await upsertLead(db, account.id, { userId: me.id, actingAs: false }, pr.value, "webhook");
    if (!l.ok) throw new Error("lead");
    expect(await keyOf(await formFor(l.lead.id))).toBeNull();
    // Voice off for the platform: no key.
    const v = await loadForm(db, formA);
    expect(await voiceTabKeyForForm(db, v!.form, {})).toBeNull();
  });

  it("the form page carries the link only when it has a key", async () => {
    const a = await newBuyer("Page Buyer");
    const token = await formFor(a.leadId);
    vi.stubEnv("VOICE_REALTIME", "scripted");
    expect(await page(token)).toContain("data-voice-form-link");
    vi.stubEnv("VOICE_REALTIME", "");
    expect(await page(token)).not.toContain("data-voice-form-link");
  });
});

describe("the bubble", () => {
  const live = { phase: "live" as const, live: "listening" as const, muted: false, endReason: null, mic: 0.3, out: 0, caption: { id: "a", text: "Hi" }, secondsLeft: 120, outputs: [], output: null };
  it("a round button named by the state word, bottom-end in the page's direction; no tool names", () => {
    const html = renderToStaticMarkup(<VoiceBubble state={live} agentName="Maya" tr={translator("en")} dir="ltr" onCommand={() => {}} placement="dock" />);
    expect(html).toContain('aria-label="Voice call, listening, 2:00 left"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-bubble-live="listening"');
    expect(html).not.toContain("data-bubble-menu");
    const he = renderToStaticMarkup(<VoiceBubble state={{ ...live, muted: true }} agentName="Maya" tr={translator("he")} dir="rtl" onCommand={() => {}} placement="fixed" caption />);
    expect(he).toContain('dir="rtl"');
    expect(he).toContain("vb--fixed");
    expect(he).toContain("המיקרופון מושתק");
    expect(he).toContain("data-bubble-muted");
  });

  it("accessible name: the state and the time left (en, he); the live region changes with the state only", () => {
    const render = (st: import("@/lib/voice/client/tab-link").MirrorState, lang: "en" | "he" = "en", placement: "dock" | "fixed" = "fixed") =>
      renderToStaticMarkup(<VoiceBubble state={st} agentName="Maya" tr={translator(lang)} dir={lang === "he" ? "rtl" : "ltr"} onCommand={() => {}} placement={placement} caption />);
    const region = (html: string) => /data-bubble-live-region="">([^<]*)</.exec(html)?.[1];
    const label = (html: string) => /<button[^>]*aria-label="([^"]*)"[^>]*aria-haspopup/.exec(html)?.[1];
    expect(label(render({ ...live, secondsLeft: 268 }))).toBe("Voice call, listening, 4:28 left");
    expect(label(render({ ...live, live: "speaking", secondsLeft: 61 }))).toBe("Voice call, agent speaking, 1:01 left");
    expect(label(render({ ...live, live: "standby" }))).toBe("Voice call, standing by, 2:00 left");
    expect(label(render({ ...live, muted: true }))).toBe("Voice call, muted, 2:00 left");
    expect(label(render({ ...live, phase: "ended", live: null, endReason: "idle", secondsLeft: null }))).toBe("Voice call, call ended");
    expect(label(render({ ...live, secondsLeft: 268 }, "he"))).toBe("שיחה קולית, מקשיבים, נותרו 4:28");
    expect(label(render({ ...live, live: "standby" }, "he"))).toBe("שיחה קולית, בהמתנה, נותרו 2:00");
    // Levels, time and caption change: the live region does not.
    const base = region(render(live));
    expect(base).toBe("Listening");
    expect(region(render({ ...live, mic: 0.9, out: 0.4, secondsLeft: 12, caption: { id: "z", text: "Another line" } }))).toBe(base);
    // A state change does.
    expect(region(render({ ...live, live: "standby" }))).toBe("Standing by · Just speak");
    expect(region(render({ ...live, muted: true }))).toBe("You are muted");
    expect(region(render({ ...live, live: "speaking" }))).toBe("Maya is speaking");
    expect(region(render({ ...live, phase: "ended", live: null, endReason: "idle" }))).toBe("Call ended · it was quiet");
    // In the chat, while the bar above says it (connecting), the bubble's region stays quiet: one announcement.
    expect(region(render({ ...live, phase: "connecting", live: null }, "en", "dock"))).toBe("");
  });

  it("a note next to the bubble (the first switch), in the page's language; markers never as a caption", () => {
    const html = renderToStaticMarkup(<VoiceBubble state={live} agentName="Maya" tr={translator("he")} dir="rtl" onCommand={() => {}} placement="dock" note={translator("he")("buyer.voice.first_note")} />);
    expect(html).toContain('data-bubble-note="first"');
    expect(html).toContain("מה שנאמר מופיע כטקסט בצ&#x27;אט הזה");
    const marker = renderToStaticMarkup(<VoiceBubble state={{ ...live, caption: { id: "a", text: "<no speech detected>" } }} agentName="Maya" tr={translator("en")} dir="ltr" onCommand={() => {}} placement="fixed" caption />);
    expect(marker).not.toContain("no speech");
  });
});
