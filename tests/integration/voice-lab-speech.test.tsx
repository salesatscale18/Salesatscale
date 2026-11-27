/**
 * "Voice from" in the Voice settings and the one rule (owner, 24 Nov 2026): the version decides MODEL and VOICE, the
 * test lab's engine select only the WIRING. On PGlite in scripted mode (no paid call): the engine row offers three
 * wirings and refuses the retired ids; an admin saves "Voice from: ElevenLabs" (a seller cannot; Gemini + ElevenLabs is
 * refused); a test call on Current or New with GPT + ElevenLabs runs with text output and the speaker through the real
 * relay; Classic, a Gemini version and a buyer call keep the model's own voice (logged); the "This call" card shows
 * Model, Voice, Engine as they ran; an old rt_eleven call still renders. With VOICE_RENDER_DIR set, pages are written
 * as HTML for the screenshots (tests/e2e/voice/settings-shots.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { agentVersions, sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
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
const { endMyVoiceCallAction, saveVoiceSettingsAction, startVoiceCallAction } = await import("@/app/app/[account]/setup/test-lab/voice-actions");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { createVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");
const { VoiceLabChoices } = await import("@/app/app/[account]/setup/test-lab/voice-lab");

function findElements(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => findElements(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    findElements((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await (TestLabPage as unknown as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));

const save = (name: string, html: string) => {
  const dir = process.env.VOICE_RENDER_DIR;
  if (!dir) return;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const MINI = "openai/gpt-realtime-mini";
const GPT = "openai/gpt-realtime-2.1";
const GEMINI = "google/gemini-3.8-live";

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

const draftRow = async () => (await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "draft"))))[0];
const setDraft = async (voiceSettings: Record<string, unknown> | null) => db.update(agentVersions).set({ voiceSettings: voiceSettings as never }).where(eq(agentVersions.id, (await draftRow()).id));
const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
const form = (o: Record<string, string>) => {
  const f = new FormData();
  f.set("slug", slug);
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

class FakeWs extends EventEmitter {
  bufferedAmount = 0;
  out: (string | Uint8Array)[] = [];
  closed = false;
  send(d: string | Uint8Array) { this.out.push(d); }
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit("close", code, ""));
  }
}

/** A session through the REAL relay (lib/voice/socket.ts) with the scripted model and the scripted speaker: opener, then end. */
async function relay(s: { sessionId: string; ticket: string }) {
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock });
  const speaker = new ScriptedSpeaker();
  const lines: string[] = [];
  const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) };
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await flushAsync(4);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const ws = new FakeWs();
  const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, model, rtSpeaker: speaker, log, limits: { standbyAfterQuietMs: 600_000 } });
  ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true })), false);
  await settle();
  ws.emit("message", Buffer.from(JSON.stringify({ t: "ready" })), false);
  await clock.advance(6_000, settle);
  ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
  await clock.advance(100, settle);
  await done;
  return { model, speaker, lines, ws, cfg: model.connections[0]?.cfg };
}

/** The "This call" card's rows, in order (dt → dd text). */
const cardRows = (html: string) => {
  const dl = /data-voice-stats=""[\s\S]*?<dl class="sas-vstats__kv">([\s\S]*?)<\/dl>/.exec(html)?.[1] ?? "";
  return [...dl.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "")]);
};

describe("the engine select: wiring only", () => {
  it("three options for a platform admin (Live for buyers, New, Old baseline); the retired ids are refused server-side", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render({ mode: "voice" });
    save("settings-page-engine-row", html);
    const select = /<select[^>]*data-voice-engine-select=""[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    expect([...select.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["guarded", "Live for buyers (23 Nov)"], ["current", "Previous (22 Nov)"], ["classic", "Old baseline (20 Nov)"],
    ]);
    for (const engine of ["rt_eleven", "rt_eleven_mini", "guarded_silent", "pipeline", "pipeline_lite", "pipeline_chat"]) {
      expect(await startVoiceCallAction({ slug, engine })).toEqual({ ok: false, reason: "not_allowed" });
    }
  });
});

describe("Voice from: saving", () => {
  it("an admin saves GPT-Realtime mini + ElevenLabs; Gemini + ElevenLabs is refused; a seller gets nothing", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    expect(await saveVoiceSettingsAction({}, form({ model: MINI, speech: "elevenlabs", maxCallSec: "300" }))).toEqual({ failed: true });
    expect((await draftRow()).voiceSettings).toBeNull();
    as(admin);
    expect(await saveVoiceSettingsAction({}, form({ model: GEMINI, speech: "elevenlabs", maxCallSec: "300" })))
      .toEqual({ errors: { speech: "ElevenLabs works with the GPT-Realtime models only. Pick GPT-Realtime 2.1 or mini, or the model's own voice." } });
    const ok = await saveVoiceSettingsAction({}, form({ model: MINI, speech: "elevenlabs", voice: "coral", fillers: "on", maxCallSec: "300" })).catch((e: { url?: string }) => e);
    expect((ok as { url?: string }).url).toMatch(/voice_saved=/);
    expect((await draftRow()).voiceSettings).toMatchObject({ model: MINI, speech: "elevenlabs", voice: "coral" });
    // The panel shows the choice: "Voice from: ElevenLabs", the test calls' voice, the buyers' voice still editable.
    const panel = await render({ panel: "voice" });
    save("settings-page-panel-eleven", panel);
    expect(panel).toMatch(/<option value="elevenlabs" selected="">ElevenLabs \(testing\)<\/option>/);
    expect(panel).toContain("Rachel · v4 Turbo");
    expect(panel).toContain("Buyers hear");
    // Back to Gemini (the form posts the model's own voice there): ElevenLabs is gone.
    const back = await saveVoiceSettingsAction({}, form({ model: GEMINI, speech: "model", maxCallSec: "300" })).catch((e: { url?: string }) => e);
    expect((back as { url?: string }).url).toMatch(/voice_saved=/);
    expect((await draftRow()).voiceSettings).not.toHaveProperty("speech");
  });
});

describe("the one rule through the start action and the relay", () => {
  it("Current wiring + GPT mini + ElevenLabs, test call: text output and the speaker; This call: Model, Voice (Rachel), Engine", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft({ model: MINI, speech: "elevenlabs", voice: "coral", maxCallSec: 300 });
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "current" });
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ engine: "current", model: "GPT-Realtime mini", voiceUsed: { voice: "Rachel (ElevenLabs)", fillers: false } });
    const s0 = await sessionRow(r.sessionId);
    expect(s0.settings).toEqual({ speech: "elevenlabs" });
    expect(s0.model).toBe(MINI);
    const run = await relay(r);
    expect(run.cfg?.outputModality).toBe("text");
    expect(run.cfg?.voice).toBeUndefined();
    expect(run.speaker.said.length).toBeGreaterThan(0);
    expect(run.ws.out.some((d) => d instanceof Uint8Array)).toBe(true);
    expect(run.lines.some((l) => / socket accepted mode=scripted .* test speech=elevenlabs$/.test(l))).toBe(true);
    expect(run.lines.filter((l) => l.endsWith(" rt speech one stream per reply stability=1 (dialogue mode only)"))).toHaveLength(1);
    // Current's own model side (no profile): no engine= line.
    expect(run.lines.some((l) => / engine=/.test(l))).toBe(false);
    const s = await sessionRow(r.sessionId);
    expect(s.settings).toMatchObject({ speech: "elevenlabs", voice: "Rachel (ElevenLabs)", model: MINI, rtEleven: { realtimeModel: MINI, speakModel: "scripted" } });
    expect(s.settings).not.toHaveProperty("engine");
    const html = await render({ c: r.conversationId });
    save("settings-page-call-card", html);
    const rows = cardRows(html);
    const keys = rows.map((x) => x[0]);
    expect(keys.indexOf("Model")).toBeLessThan(keys.indexOf("Voice"));
    expect(keys.indexOf("Voice")).toBeLessThan(keys.indexOf("Engine"));
    expect(Object.fromEntries(rows)).toMatchObject({ Model: "GPT-Realtime mini · scripted stand-in", Voice: "Rachel (ElevenLabs)", Speaking: "scripted", Engine: "Previous (22 Nov)" });
    await endMyVoiceCallAction({ slug });
  });

  it("a chosen ElevenLabs model and voice (Sarah · Flash v2.5): the start's voice, what applied stored after the call, the card", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft({ model: MINI, speech: "elevenlabs", elevenModel: "elevenlabs/eleven-flash-v2.5", elevenVoice: "EXAVITQu4vr4xnSDxMaL", maxCallSec: 300 });
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "current" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.voiceUsed).toEqual({ voice: "Sarah (ElevenLabs)", fillers: false });
    await relay(r);
    const s = await sessionRow(r.sessionId);
    // Stored by the socket once the engine stored the call (a scripted call: nothing sent to ElevenLabs).
    expect((s.settings as Record<string, unknown>).elevenApplied).toEqual({
      chosen: { model: "elevenlabs/eleven-flash-v2.5", voice: "EXAVITQu4vr4xnSDxMaL", stability: 1 },
      model: null, voice: "EXAVITQu4vr4xnSDxMaL", stability: null, fallback: null, substituted: [], scripted: true,
    });
    const html = await render({ c: r.conversationId });
    save("panel-call-card", html);
    expect(Object.fromEntries(cardRows(html))).toMatchObject({ Voice: "Sarah (ElevenLabs)", Speaking: "scripted" });
    await endMyVoiceCallAction({ slug });
  });

  it("New wiring + GPT 2.1 + ElevenLabs: the guarded profile with text output and the speaker", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft({ model: GPT, speech: "elevenlabs", maxCallSec: 300 });
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "guarded" });
    if (!r.ok) throw new Error(r.reason);
    expect((await sessionRow(r.sessionId)).settings).toEqual({ engine: "guarded", speech: "elevenlabs" });
    const run = await relay(r);
    expect(run.cfg?.outputModality).toBe("text");
    expect(run.speaker.said.length).toBeGreaterThan(0);
    expect(run.lines.some((l) => l.endsWith(" engine=guarded"))).toBe(true);
    const s = await sessionRow(r.sessionId);
    expect(s.settings).toMatchObject({ engine: "guarded", speech: "elevenlabs", voice: "Rachel (ElevenLabs)", model: GPT });
    const rows = Object.fromEntries(cardRows(await render({ c: r.conversationId })));
    expect(rows).toMatchObject({ Model: "GPT-Realtime 2.1 · scripted stand-in", Voice: "Rachel (ElevenLabs)", Engine: "Live for buyers (23 Nov)" });
    await endMyVoiceCallAction({ slug });
  });

  it("Old baseline (Classic): ElevenLabs is ignored (Gemini only, the model's own voice), logged once", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft({ model: MINI, speech: "elevenlabs", maxCallSec: 300 });
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "classic" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.voiceUsed.voice).not.toBe("Rachel (ElevenLabs)");
    const s0 = await sessionRow(r.sessionId);
    expect(s0.settings).toEqual({ engine: "classic" });
    expect(s0.model).toBe(GEMINI);
    // The starter says Classic uses neither the version's model nor its ElevenLabs voice.
    const page = await (TestLabPage as unknown as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve({ mode: "voice" }) });
    const [choices] = findElements(page, VoiceLabChoices);
    expect(Object.values((choices.props as { classicModelNotes: Record<string, string> }).classicModelNotes))
      .toContain("Old baseline (20 Nov) runs on Gemini 3.8 Live only: this version's model (GPT-Realtime mini) and its ElevenLabs voice are not used.");
    const run = await relay(r);
    expect(run.cfg?.outputModality).toBeUndefined();
    expect(run.speaker.said).toHaveLength(0);
    expect(run.lines.filter((l) => l.includes("speech=elevenlabs ignored on the Old baseline"))).toHaveLength(1);
    await endMyVoiceCallAction({ slug });
  });

  it("a Gemini version (ElevenLabs stored anyway): the model's own voice", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft({ model: GEMINI, speech: "elevenlabs", maxCallSec: 300 });
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "current" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.voiceUsed.voice).toBe("default");
    expect((await sessionRow(r.sessionId)).settings).toBeNull();
    const run = await relay(r);
    expect(run.cfg?.outputModality).toBeUndefined();
    expect(run.speaker.said).toHaveLength(0);
    expect((await sessionRow(r.sessionId)).settings).toMatchObject({ speech: "model" });
    await endMyVoiceCallAction({ slug });
  });

  it("a buyer call on a GPT + ElevenLabs version: ignored (ELEVEN_FOR_BUYER_CALLS is off), the model's own voice, logged once", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    await setDraft({ model: MINI, speech: "elevenlabs", voice: "coral", maxCallSec: 300 });
    const c = (await startVoiceTestConversation(db, account.id, admin.id, { scenario: "ready_buyer" }))!;
    const s = await createVoiceSession(db, { accountId: account.id, conversationId: c.conversationId, userId: admin.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    // A buyer's session as createVoiceSession stores it for a buyer (no speech: the rule never applies ElevenLabs there).
    await db.update(voiceSessions).set({ isTest: false, settings: null }).where(eq(voiceSessions.id, s.sessionId));
    const run = await relay(s);
    expect(run.cfg?.outputModality).toBeUndefined();
    expect(run.cfg?.voice).toBe("coral");
    expect(run.speaker.said).toHaveLength(0);
    expect(run.lines.filter((l) => / speech=elevenlabs ignored on a buyer call/.test(l))).toHaveLength(1);
    expect((await sessionRow(s.sessionId)).settings).toMatchObject({ speech: "model", voice: "coral" });
    // A buyer session even with speech stored (it cannot be: checked again by the relay) keeps the model's voice.
    const s2 = await createVoiceSession(db, { accountId: account.id, conversationId: (await startVoiceTestConversation(db, account.id, admin.id, {}))!.conversationId, userId: admin.id, isTest: true }, { env: SCRIPTED });
    if (!s2.ok) throw new Error(s2.reason);
    await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s2.sessionId));
    const run2 = await relay(s2);
    expect(run2.cfg?.outputModality).toBeUndefined();
    expect(run2.speaker.said).toHaveLength(0);
  });

  it("an old call on the retired rt_eleven engine still runs and renders: Model, Voice (Rachel), its engine label", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    await setDraft(null);
    const c = (await startVoiceTestConversation(db, account.id, admin.id, { scenario: "ready_buyer" }))!;
    const s = await createVoiceSession(db, { accountId: account.id, conversationId: c.conversationId, userId: admin.id, isTest: true }, { env: SCRIPTED, engine: "rt_eleven" });
    if (!s.ok) throw new Error(s.reason);
    const run = await relay(s);
    expect(run.cfg?.outputModality).toBe("text");
    const rows = Object.fromEntries(cardRows(await render({ c: c.conversationId })));
    expect(rows).toMatchObject({ Model: "GPT-Realtime 2.1 · scripted stand-in", Voice: "Rachel (ElevenLabs)", Engine: "GPT-Realtime 2.1 + ElevenLabs (testing)" });
  });
});
