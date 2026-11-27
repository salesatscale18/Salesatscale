/**
 * The test lab's "Voice engine" selector with its third option, "Classic + guards" (lib/voice-guarded), on PGlite with
 * the scripted model: a platform admin sees three options and can start a guarded call (stored on the session, on the
 * version's own model); a seller never sees it and the server ignores the field from one; a saved guarded call shows
 * its engine (header pill and "This call") and Call again keeps it. With VOICE_RENDER_DIR set, the pages are written
 * as HTML for the screenshots (tests/e2e/voice/guarded-shots.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { eq } from "drizzle-orm";
import { sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
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
const { labEngineChoice, sessionEngine } = await import("@/lib/voice-classic/engine-choice");
const { VoiceEngine } = await import("@/lib/voice/engine");
const { GUARDED_PROFILE, GUARDED_SILENT_PROFILE } = await import("@/lib/voice-guarded/profile");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { micPcm, ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { createVoiceSession, saveDraftVoiceSettings, startVoiceTestConversation } = await import("@/lib/voice/service");

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

/** Runs a test-lab call's session to its end on the guarded engine (scripted model): the relay's part, in process. */
async function runGuarded(sessionId: string, profile = GUARDED_PROFILE) {
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock });
  const engine = new VoiceEngine({ db, model, sessionId, send: () => {}, clock, limits: { standbyAfterQuietMs: 600_000, env: {} }, log: { info: () => {}, warn: () => {} }, profile });
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

describe("test lab: the voice engine selector, Classic + guards", () => {
  it("shows the engines to a platform admin in the owner's order and names (live for buyers first, by default)", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render({ mode: "voice" });
    save("guarded-page-engine-select", html);
    const select = /<select[^>]*data-voice-engine-select=""[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    expect([...select.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["guarded", "Live for buyers (23 Nov)"], ["current", "Previous (22 Nov)"], ["classic", "Old baseline (20 Nov)"],
    ]);
    expect(select).toContain('<option value="guarded" selected="">Live for buyers (23 Nov)</option>');
    // One helper line under the row for the selected engine (what it is based on, whether buyers get it).
    expect(html).toMatch(/<p class="sas-small lab-choices__why lab-choices__help" id="lab-engine-help" data-voice-engine-help="">The engine every buyer call runs on \(since 26 Nov\): [^<]*Buyers get it\. The model and voice come from the version&#x27;s Voice settings\.<\/p>/);
    expect(html).toMatch(/<select[^>]*aria-describedby="lab-engine-help"/);
    // The Version select names each version's date: "v1 · Draft · 23 Nov".
    const ver = /<select[^>]*id="lab-ver"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    expect(ver).toMatch(/<option value="[0-9a-f-]+"[^>]*>v1 · Draft · \d{1,2} [A-Z][a-z]{2}<\/option>/);
  });

  it("the helper line of each engine", async () => {
    const { t } = await import("@/lib/i18n");
    const { ENGINE_ORDER, engineHelpKey } = await import("@/lib/voice-classic/engine-choice");
    const help = Object.fromEntries(ENGINE_ORDER.map((e) => [e, t(engineHelpKey(e))]));
    expect(help.guarded).toBe("The engine every buyer call runs on (since 26 Nov): the simpler speaking instructions, a server-written price sentence and plain objection notes. Buyers get it. The model and voice come from the version's Voice settings.");
    expect(help.current).toMatch(/Switched off: buyers no longer get it\. The model and voice come from the version's Voice settings\.$/);
    expect(help.classic).toMatch(/with the model's own voice\. Test lab only\.$/);
    expect(Object.keys(help)).toEqual(["guarded", "current", "classic"]);
  });

  it("never shows it to a seller, and the server ignores the field from one", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    const html = await render({ mode: "voice" });
    expect(html).not.toContain("Live for buyers (23 Nov)");
    expect(await startVoiceCallAction({ slug, engine: "guarded" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(labEngineChoice(seller, "guarded", { VOICE_REALTIME: "scripted" })).toBe("guarded");
    expect(labEngineChoice(admin, "guarded", { VOICE_REALTIME: "scripted" })).toBe("guarded");
    expect(labEngineChoice(admin, "guarded", { VOICE_REALTIME: "off" })).toBe("guarded");
    expect(sessionEngine({ engine: "guarded" })).toBe("guarded");
    expect(sessionEngine({ engine: "GUARDED" })).toBe("current");
    expect(sessionEngine(null)).toBe("current");
  });

  it("starts a guarded call for an admin: stored on the session, on the version's own model (any family)", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    expect((await saveDraftVoiceSettings(db, account.id, { model: "openai/gpt-realtime-mini" })).ok).toBe(true);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "guarded" });
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ engine: "guarded", model: "GPT-Realtime mini" });
    expect(r.classicOnGemini).toBeUndefined();
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.settings).toEqual({ engine: "guarded" });
    expect(s.model).toBe("openai/gpt-realtime-mini");
    await endMyVoiceCallAction({ slug });
    expect((await saveDraftVoiceSettings(db, account.id, { model: "google/gemini-3.8-live" })).ok).toBe(true);
  });

  it("a saved guarded call: Engine in the header and on This call, recorded as the account says, Call again keeps it", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "guarded" });
    if (!r.ok) throw new Error(r.reason);
    await runGuarded(r.sessionId);
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.status).toBe("ended");
    expect(s.settings).toMatchObject({ engine: "guarded" });
    // Recorded (scripted: the in-memory store), as Current: not "Not recorded".
    expect(s.recordingState).toBe("saved");
    const html = await render({ c: r.conversationId });
    save("guarded-page-call", html);
    // The buyers' engine (26 Nov 2026): no engine pill in the header (it marks a call on another engine); This call names it.
    expect(html).not.toContain('data-voice-engine-pill=""');
    expect(html).toMatch(/<dt>Engine<\/dt><dd data-voice-engine="">Live for buyers \(23 Nov\)<\/dd>/);
    expect(html).toContain("Call again");
    const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
    expect(again.props).toMatchObject({ engine: "guarded" });
    const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
    const next = await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine });
    if (!next.ok) throw new Error(next.reason);
    expect(next.engine).toBe("guarded");
    await endMyVoiceCallAction({ slug });
    as(seller);
    const sellerHtml = await render({ c: r.conversationId });
    expect(sellerHtml).not.toContain("Live for buyers (23 Nov)");
  });
});

describe("test lab: the voice engine selector, Classic + guards (silent probe)", () => {
  it("retired (24 Nov rewiring): not offered, and no new call starts on it, for a seller or an admin", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(seller);
    expect(await render({ mode: "voice" })).not.toContain("silent probe");
    expect(await startVoiceCallAction({ slug, engine: "guarded_silent" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(labEngineChoice(seller, "guarded_silent", { VOICE_REALTIME: "scripted" })).toBe("guarded");
    expect(sessionEngine({ engine: "guarded_silent" })).toBe("guarded_silent");
    expect(sessionEngine({ engine: "guarded-silent" })).toBe("current");
    as(admin);
    expect(await render({ mode: "voice" })).not.toContain("New + silent tools");
    expect(await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "guarded_silent" })).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("an old saved silent-probe call still renders: Engine in the header and on This call; Call again on it is refused", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    // An old call: its session as the start action stored it before the rewiring.
    const c = (await startVoiceTestConversation(db, account.id, admin.id, { scenario: "ready_buyer" }))!;
    const r0 = await createVoiceSession(db, { accountId: account.id, conversationId: c.conversationId, userId: admin.id, isTest: true }, { engine: "guarded_silent", env: { VOICE_REALTIME: "scripted" } });
    if (!r0.ok) throw new Error(r0.reason);
    const r = { ...r0, conversationId: c.conversationId };
    await runGuarded(r.sessionId, GUARDED_SILENT_PROFILE);
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.status).toBe("ended");
    expect(s.settings).toMatchObject({ engine: "guarded_silent" });
    const html = await render({ c: r.conversationId });
    save("guarded-silent-page-call", html);
    expect(html).toContain("Engine: New + silent tools (23 Nov, testing)");
    expect(html).toMatch(/<dt>Engine<\/dt><dd data-voice-engine="">New \+ silent tools \(23 Nov, testing\)<\/dd>/);
    const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
    expect(again.props).toMatchObject({ engine: "guarded_silent" });
    const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
    expect(await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine })).toEqual({ ok: false, reason: "not_allowed" });
    await endMyVoiceCallAction({ slug });
  });
});
