/**
 * The test lab's "Voice engine" selector (Current / Classic (20 Nov)), on PGlite with the scripted model: platform
 * admins see it and can start a Classic call; a seller never sees it and the server ignores the field from them;
 * a saved Classic call shows its engine (header pill and "This call"), reads "Not recorded", and Call again keeps
 * the engine. With VOICE_RENDER_DIR set, the pages are written as HTML for the screenshots
 * (tests/e2e/voice/engine-shots.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { eq } from "drizzle-orm";
import { conversations, sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
// The lab's engine select switched back on (LAB_ENGINE_SELECTOR, off since 26 Nov 2026): the comparison stays covered.
vi.mock("@/lib/voice-classic/engine-choice", async (orig) => (await import("../helpers/lab-selector")).selectorOn(await orig()));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
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
const { ensureDraftVersion } = await import("@/lib/agent/service");
const { endMyVoiceCallAction, startVoiceCallAction } = await import("@/app/app/[account]/setup/test-lab/voice-actions");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { VoiceCallAgainBar } = await import("@/app/app/[account]/setup/test-lab/voice-lab");
const { labEngineChoice } = await import("@/lib/voice-classic/engine-choice");
const { ClassicVoiceEngine } = await import("@/lib/voice-classic/engine");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { micPcm, ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { saveDraftVoiceSettings } = await import("@/lib/voice/service");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const pageElement = (sp: Record<string, string> = {}) => (TestLabPage as unknown as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) });
const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await pageElement(sp));

const save = (name: string, html: string) => {
  const dir = process.env.VOICE_RENDER_DIR;
  if (!dir) return;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};

/** The elements of a given component in a page's element tree (client components are not rendered on the server). */
function findElements(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => findElements(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    findElements((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let admin: User;
let seller: User;
let account: SellerAccount;
let slug: string;
const as = (user: User) => {
  holder.access = { account, user, actingAs: user.role === "super_admin", role: user.role === "super_admin" ? "platform_admin" : "seller_admin" };
};

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [admin] = await db.insert(users).values({ clerkId: "a", email: "admin@p.test", firstName: "Ada", role: "super_admin" }).returning();
  [seller] = await db.insert(users).values({ clerkId: "b", email: "seller@p.test", firstName: "Sol", role: "user" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, id);
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
  slug = account.slug;
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

/** Runs a test-lab call's session to its end on the Classic engine (scripted model): the relay's part, in process. */
async function runClassic(sessionId: string) {
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock });
  const engine = new ClassicVoiceEngine({ db, model, sessionId, send: () => {}, clock, limits: { standbyAfterQuietMs: 600_000, env: {} }, log: { info: () => {}, warn: () => {} } });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  await engine.start();
  await settle();
  await clock.advance(12_000, settle);
  for (let x = 0; x < 1000; x += 100) {
    engine.onClientAudio(micPcm(100, true));
    await clock.advance(100, settle);
  }
  for (let x = 0; x < 800; x += 100) {
    engine.onClientAudio(micPcm(100, false));
    await clock.advance(100, settle);
  }
  await clock.advance(10_000, settle);
  engine.onClientMessage({ t: "end" });
  await settle();
}

describe("test lab: the voice engine selector", () => {
  it("shows the Voice engine select to a platform admin, next to the version, Current by default", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render({ mode: "voice" });
    save("page-engine-select", html);
    expect(html).toContain('data-voice-engine-select=""');
    expect(html).toContain("Voice engine");
    expect(html).toContain('<option value="guarded" selected="">Live for buyers (23 Nov)</option>');
    expect(html).toContain('<option value="classic">Old baseline (20 Nov)</option>');
    expect(html.indexOf('id="lab-ver"')).toBeLessThan(html.indexOf('id="lab-engine"'));
  });

  it("never shows it to a seller, and the server ignores the field from one", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    const html = await render({ mode: "voice" });
    expect(html).not.toContain("data-voice-engine-select");
    expect(html).not.toContain("Old baseline (20 Nov)");
    const before = (await db.select({ id: voiceSessions.id }).from(voiceSessions)).length;
    expect(await startVoiceCallAction({ slug, engine: "classic" })).toEqual({ ok: false, reason: "not_allowed" });
    expect((await db.select({ id: voiceSessions.id }).from(voiceSessions)).length).toBe(before);
    // The rule itself: the field counts from a platform admin only.
    expect(labEngineChoice(seller, "classic", { VOICE_REALTIME: "scripted" })).toBe("guarded");
    expect(labEngineChoice(admin, "classic", { VOICE_REALTIME: "scripted" })).toBe("classic");
    expect(labEngineChoice(admin, "classic", { VOICE_REALTIME: "off" })).toBe("guarded");
    expect(labEngineChoice(admin, "something", { VOICE_REALTIME: "scripted" })).toBe("guarded");
  });

  it("starts a Classic call for an admin (stored on the session, Gemini), a Current one when picked, the buyers' engine by default", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    // The draft is set to an OpenAI model: Classic runs on Gemini and says so.
    expect((await saveDraftVoiceSettings(db, account.id, { model: "openai/gpt-realtime-mini" })).ok).toBe(true);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "classic" });
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ engine: "classic", model: "Gemini 3.8 Live", classicOnGemini: true });
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.settings).toEqual({ engine: "classic" });
    expect(s.model).toBe("google/gemini-3.8-live");
    await endMyVoiceCallAction({ slug });
    // Nothing picked: the buyers' engine (BUYER_VOICE_ENGINE, the New one), stored on the session.
    const dflt = await startVoiceCallAction({ slug });
    if (!dflt.ok) throw new Error(dflt.reason);
    expect(dflt).toMatchObject({ engine: "guarded", model: "GPT-Realtime mini" });
    const [d2] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, dflt.sessionId));
    expect(d2.settings).toEqual({ engine: "guarded" });
    await endMyVoiceCallAction({ slug });
    const cur = await startVoiceCallAction({ slug, engine: "current" });
    if (!cur.ok) throw new Error(cur.reason);
    expect(cur).toMatchObject({ engine: "current", model: "GPT-Realtime mini" });
    expect(cur.classicOnGemini).toBeUndefined();
    const [c2] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, cur.sessionId));
    expect(c2.settings).toBeNull();
    expect(c2.model).toBe("openai/gpt-realtime-mini");
    await endMyVoiceCallAction({ slug });
    expect((await saveDraftVoiceSettings(db, account.id, { model: "google/gemini-3.8-live" })).ok).toBe(true);
    // The selector's Gemini note: per version whose model Classic does not use.
    const tree = await pageElement({ mode: "voice" });
    const { VoiceLabChoices } = await import("@/app/app/[account]/setup/test-lab/voice-lab");
    const [choices] = findElements(tree, VoiceLabChoices);
    expect(choices.props).toMatchObject({ engines: true, classicModelNotes: {} });
  });

  it("a saved Classic call: Engine in the header and on This call, Not recorded, and Call again keeps the engine", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "classic" });
    if (!r.ok) throw new Error(r.reason);
    await runClassic(r.sessionId);
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s).toMatchObject({ status: "ended", recordingState: "off" });
    const html = await render({ c: r.conversationId });
    save("page-classic-call", html);
    expect(html).toContain('data-voice-engine-pill=""');
    expect(html).toContain("Engine: Old baseline (20 Nov)");
    expect(html).toMatch(/<dt>Engine<\/dt><dd data-voice-engine="">Old baseline \(20 Nov\)<\/dd>/);
    expect(html).toContain("Not recorded");
    expect(html).toContain("Call again");
    // Call again starts the next call on the same engine (the action checks the caller again).
    const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
    expect(again.props).toMatchObject({ engine: "classic", versionId: expect.any(String) });
    const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
    const next = await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine });
    if (!next.ok) throw new Error(next.reason);
    expect(next.engine).toBe("classic");
    await endMyVoiceCallAction({ slug });
    // A seller opening the saved call sees no engine.
    as(seller);
    const sellerHtml = await render({ c: r.conversationId });
    expect(sellerHtml).not.toContain("Old baseline (20 Nov)");
    expect(sellerHtml).not.toContain("data-voice-engine");
    // The conversation is still the test lab's voice conversation.
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    expect(conv.channel).toBe("voice");
  });
});
