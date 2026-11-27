/**
 * One engine for every call (owner decision, 26 Nov 2026): every way a call starts runs the buyers' engine
 * (BUYER_VOICE_ENGINE = "guarded", the New engine), with the same instructions builder (lib/voice-guarded), opener
 * protection on and the quote-quantities guard active. On PGlite with the FREE scripted realtime model, through the
 * real entry points and the real socket relay (lib/voice/socket.ts). No paid call.
 * - the buyer chat page's switch to voice: POST /chat/<token>/voice → socket;
 * - the lead page hand-over's "Talk now": the same POST (the hand-over mounts the chat's ChatClient) and a socket
 *   auth with holdGreeting (the greeting waits for the page's `ready`);
 * - the test lab's Voice call tab: startVoiceCallAction → socket; a posted engine id (an old form, Call again on an
 *   old call) is ignored, and the page shows no engine select and no engine help line;
 * - LAB_ENGINE_SELECTOR flipped back on (simulated through its parameter and the component prop): the select comes
 *   back and Current / Classic run again, unchanged.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { conversations, sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import type { ContactHours } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => { throw new Error("no Clerk API call in tests"); },
}));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { expectBuyer, say, tool, ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { callEngineOf, handleVoiceSocket } = await import("@/lib/voice/socket");
const { createVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { OPENER_PROTECTION_FOR_BUYER_CALLS } = await import("@/lib/voice/settings");
const { QUANTITY_NOT_GIVEN_RULE, QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS } = await import("@/lib/voice/quote-quantities");
const { NO_INTERNALS_LINE, READ_AS_GIVEN_LINE, TOOLS_FIRST_LINE } = await import("@/lib/voice-guarded/instructions");
const { guardedTools } = await import("@/lib/voice-guarded/profile");
const { BUYER_VOICE_ENGINE, LAB_ENGINE_SELECTOR, labEngineChoice, labEngineRefused } = await import("@/lib/voice-classic/engine-choice");
const voiceRoute = await import("@/app/chat/[token]/voice/route");
const { startVoiceCallAction, endMyVoiceCallAction } = await import("@/app/app/[account]/setup/test-lab/voice-actions");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { VoiceLabChoices } = await import("@/app/app/[account]/setup/test-lab/voice-lab");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
/** The model is asked for a quote of 7 user seats the buyer never asked for: the quote-quantities guard refuses it. */
const QUOTE_SCRIPT = [
  expectBuyer("We have two sites."),
  tool("create_quote", { lines: [{ sku: "SEAT-M", qty: 7 }], discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null }),
  say("How many seats do you need?"),
];

/** With VOICE_RENDER_DIR set, the page is written as HTML for a screenshot (the Voice call tab without the select). */
const save = (name: string, html: string) => {
  const dir = process.env.VOICE_RENDER_DIR;
  if (!dir) return;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let admin: User;
let account: SellerAccount;

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [admin] = await db.insert(users).values({ clerkId: "a1", email: "admin@p.test", firstName: "Ada", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, id, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, id, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: admin.id });
  await ensureDraftVersion(db, id);
  await publishDraftVersion(db, { userId: admin.id, actingAs: false }, id);
  await db.update(sellerAccounts).set({ status: "live", voiceBuyerCallsOff: false, allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
  holder.access = { account, user: admin, actingAs: true, role: "platform_admin" };
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

async function newBuyerToken(name: string): Promise<string> {
  const made = await createSimulatedBuyer(db, { userId: admin.id, actingAs: false }, account, { fullName: name, company: "Shop", language: "en", country: "IL" });
  if (!made.ok) throw new Error("buyer");
  const started = await startSimulatorConversation(db, { userId: admin.id, actingAs: false }, account.id, made.lead.id);
  if (!started.ok) throw new Error(`start ${started.reason}`);
  return made.token;
}

/** The chat page's "Talk to us" / switch to voice (and the hand-over's "Talk now"): the route the ChatClient posts to. */
async function postVoice(token: string): Promise<{ sessionId: string; ticket: string }> {
  const res = await voiceRoute.POST(
    new Request(`https://app.example.com/chat/${token}/voice`, { method: "POST", headers: { "content-type": "application/json", host: "app.example.com" }, body: "{}" }),
    { params: Promise.resolve({ token }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; ticket: string };
}

class FakeSocket extends EventEmitter {
  out: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  send(d: string | Uint8Array) { this.out.push(d); }
  close() { setImmediate(() => this.emit("close")); }
}

/** One call through the socket relay: auth (with holdGreeting when asked), the buyer's typed line, end. */
async function runCall(s: { sessionId: string; ticket: string }, o: { holdGreeting?: boolean } = {}) {
  const ws = new FakeSocket();
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock, defaultScript: QUOTE_SCRIPT });
  const lines: string[] = [];
  const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) };
  const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model, log, limits: { standbyAfterQuietMs: 600_000 } });
  const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
  const send = (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  send({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, ...(o.holdGreeting ? { holdGreeting: true } : {}) });
  await settle();
  if (o.holdGreeting) {
    await clock.advance(2_000, settle);
    // Held: no opening line asked of the model before the page's `ready`.
    expect(model.connections[0]?.sent.responses ?? []).toEqual([]);
    send({ t: "ready" });
  }
  await clock.advance(15_000, settle);
  send({ t: "text", text: "We have two sites." });
  await clock.advance(20_000, settle);
  send({ t: "end" });
  await clock.advance(2_000, settle);
  ws.emit("close");
  await settle();
  await done;
  const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
  return { row, lines, conn: model.connections[0] };
}

/** What every path must show: the New engine, its instructions builder and tools, opener protection, the quote guard. */
function expectBuyersEngine(r: Awaited<ReturnType<typeof runCall>>) {
  expect(r.row.settings).toMatchObject({ engine: BUYER_VOICE_ENGINE });
  expect(callEngineOf(r.row)).toBe("guarded");
  expect(r.lines.some((l) => l.endsWith("engine=guarded"))).toBe(true);
  // The guarded instructions builder (lib/voice-guarded/instructions.ts): its own lines, in every call's instructions.
  for (const line of [READ_AS_GIVEN_LINE, NO_INTERNALS_LINE, TOOLS_FIRST_LINE]) expect(r.conn.cfg.instructions).toContain(line);
  expect(r.conn.cfg.tools.map((t) => t.name)).toEqual(guardedTools("gemini").map((t) => t.name));
  // Opener protection on.
  expect(r.lines.some((l) => l.endsWith("opener protected: on"))).toBe(true);
  // The quote-quantities guard: 7 seats the buyer never gave is refused before the tool runs.
  expect(r.lines.some((l) => l.endsWith("quote quantities: refused item=SEAT-M qty=7"))).toBe(true);
  const result = r.conn.sent.toolResults.find((x) => x.name === "create_quote")?.result as { ok?: boolean; rule?: string };
  expect(result).toMatchObject({ ok: false, rule: QUANTITY_NOT_GIVEN_RULE });
}

describe("one engine for every call (26 Nov 2026)", () => {
  it("the constants", () => {
    expect(BUYER_VOICE_ENGINE).toBe("guarded");
    expect(LAB_ENGINE_SELECTOR).toBe(false);
    expect(OPENER_PROTECTION_FOR_BUYER_CALLS).toBe(true);
    expect(QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS).toBe(true);
  });

  it("the buyer chat page's switch to voice: the New engine, its instructions, opener protection, the quote guard", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const s = await postVoice(await newBuyerToken("Chat Buyer"));
    const r = await runCall(s);
    expect(r.row.isTest).toBe(false);
    expectBuyersEngine(r);
  });

  it("the lead page hand-over's Talk now (holdGreeting): the same, the greeting held until the page is ready", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const s = await postVoice(await newBuyerToken("Handover Buyer"));
    const r = await runCall(s, { holdGreeting: true });
    expect(r.row.isTest).toBe(false);
    expectBuyersEngine(r);
  });

  it("a buyer call ignores any engine stored or asked for: always the buyers' engine", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const [conv] = await db.select().from(conversations).where(eq(conversations.accountId, account.id)).limit(1);
    // createVoiceSession given another engine for a buyer call: still the buyers'.
    const s = await createVoiceSession(db, { accountId: account.id, conversationId: conv.id, userId: null, isTest: false }, { env: SCRIPTED, engine: "classic" });
    if (!s.ok) throw new Error(s.reason);
    const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(row.settings).toMatchObject({ engine: "guarded" });
    // A row that says otherwise is never read for a buyer call.
    expect(callEngineOf({ isTest: false, settings: { engine: "classic" } as never })).toBe("guarded");
    await db.update(voiceSessions).set({ status: "ended" }).where(eq(voiceSessions.id, s.sessionId));
  });

  it("the test lab's Voice call tab: the same engine as buyers; a posted engine id is ignored; no select, no help line", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    for (const posted of [null, "classic", "current", "guarded_silent", "pipeline"]) {
      const r = await startVoiceCallAction({ slug: account.slug, engine: posted });
      if (!r.ok) throw new Error(`${posted}: ${r.reason}`);
      expect(r.engine, String(posted)).toBe("guarded");
      const [row] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
      expect(row.settings, String(posted)).toMatchObject({ engine: "guarded" });
      if (posted === null) expectBuyersEngine(await runCall(r));
      await endMyVoiceCallAction({ slug: account.slug });
    }
    const html = renderToStaticMarkup(await (TestLabPage as unknown as (p: unknown) => Promise<React.ReactElement>)({
      params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ mode: "voice" }),
    }));
    save("one-engine-voice-tab", html);
    expect(html).toContain("Start call");
    expect(html).not.toContain("data-voice-engine-select");
    expect(html).not.toContain("data-voice-engine-help");
    expect(html).not.toContain("Voice engine");
  });

  it("LAB_ENGINE_SELECTOR flipped back on: the select returns and Current / Classic run again", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const props = {
      slug: account.slug, lab: "x", scenarios: [], languages: [{ value: "en", label: "English" }], defaultLanguage: "en",
      versions: [{ value: "v", label: "v1" }], defaultVersionId: "v", callMax: { v: 270 }, limitLines: {}, usageHref: "#", settingsLine: null, settingsHref: null, callOnly: true,
    };
    const off = renderToStaticMarkup(<VoiceLabChoices {...props} engines={LAB_ENGINE_SELECTOR} />);
    expect(off).not.toContain("data-voice-engine-select");
    const on = renderToStaticMarkup(<VoiceLabChoices {...props} engines />);
    const options = [...on.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]).filter((v) => ["guarded", "current", "classic"].includes(v));
    expect(options).toEqual(["guarded", "current", "classic"]);
    expect(on).toContain('<option value="guarded" selected="">Live for buyers (23 Nov)</option>');
    expect(on).toContain("data-voice-engine-help");
    // The server side, with the select on: an admin's pick is honoured (and retired ids refused); off: ignored.
    expect(labEngineChoice(admin, "classic", SCRIPTED, true)).toBe("classic");
    expect(labEngineChoice(admin, "current", SCRIPTED, true)).toBe("current");
    expect(labEngineChoice(admin, "classic", SCRIPTED, false)).toBe("guarded");
    expect(labEngineRefused("pipeline", true)).toBe(true);
    expect(labEngineRefused("pipeline", false)).toBe(false);
    // Current and Classic still run through the same relay, unchanged.
    for (const engine of ["current", "classic"] as const) {
      const c = (await startVoiceTestConversation(db, account.id, admin.id, { scenario: null }))!;
      const s = await createVoiceSession(db, { accountId: account.id, conversationId: c.conversationId, userId: admin.id, isTest: true }, { env: SCRIPTED, engine: labEngineChoice(admin, engine, SCRIPTED, true) });
      if (!s.ok) throw new Error(s.reason);
      const r = await runCall(s);
      expect(callEngineOf(r.row), engine).toBe(engine);
      if (engine === "classic") expect(r.lines.some((l) => l.endsWith("engine=classic"))).toBe(true);
      else expect(r.lines.some((l) => / engine=/.test(l) && !/ended reason/.test(l))).toBe(false);
      // Not the New engine's instructions.
      expect(r.conn.cfg.instructions, engine).not.toContain(TOOLS_FIRST_LINE);
    }
  });
});
