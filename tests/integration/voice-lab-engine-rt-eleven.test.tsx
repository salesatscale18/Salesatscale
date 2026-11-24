/**
 * The test lab's "Voice engine" selector with the realtime + ElevenLabs options (lib/voice-rt-eleven): "GPT-Realtime 2.1
 * + ElevenLabs (testing)" (id "rt_eleven") and "GPT-Realtime mini + ElevenLabs (testing)" (id "rt_eleven_mini"), on PGlite
 * in scripted mode: a platform admin sees six engines in order and can start a call on either (stored on the session
 * with its realtime model); a seller never sees them and the server ignores the field from one; a saved call shows its
 * engine with the listening-and-thinking model, the speaking model, the median answer time and Voice: Rachel
 * (ElevenLabs); Call again keeps the engine. With VOICE_RENDER_DIR set, the pages are written as HTML for the
 * screenshots (tests/e2e/voice/rt-eleven-shots.ts).
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
const { ENGINE_ORDER, engineHelpKey, labEngineChoice } = await import("@/lib/voice-classic/engine-choice");
const { t } = await import("@/lib/i18n");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");

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

const { VoiceEngine } = await import("@/lib/voice/engine");
const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { rtElevenProfile, rtElevenSpeakerFor } = await import("@/lib/voice-rt-eleven");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");

/** Runs an rt call's session to its end (the scripted model in text mode, the scripted speaker; the opener only). */
async function runRt(sessionId: string, engine: "rt_eleven" | "rt_eleven_mini") {
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock });
  const speaker = await rtElevenSpeakerFor("scripted", {});
  const e = new VoiceEngine({
    db, model, sessionId, clock, send: () => {}, log: { info: () => {}, warn: () => {} }, limits: { env: {}, standbyAfterQuietMs: 600_000 },
    recording: { store: null, reason: "test" }, profile: rtElevenProfile(engine), speaker,
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await flushAsync(4);
      await e.idle();
    }
  };
  await e.start();
  await settle();
  await clock.advance(8_000, settle);
  e.onClientMessage({ t: "end" });
  await settle();
  return speaker as InstanceType<typeof ScriptedSpeaker>;
}

const LABELS = { rt_eleven: "GPT-Realtime 2.1 + ElevenLabs (testing)", rt_eleven_mini: "GPT-Realtime mini + ElevenLabs (testing)" } as const;
const MODEL_LABELS = { rt_eleven: "GPT-Realtime 2.1", rt_eleven_mini: "GPT-Realtime mini" } as const;

describe("test lab: the voice engine selector, realtime + ElevenLabs", () => {
  it("a platform admin sees six engines in the owner's order, each with its helper line", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render();
    save("rt-eleven-page-engine-select", html);
    const select = /<select[^>]*data-voice-engine-select=""[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    const options = [...select.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["current", "Live for buyers (22 Nov)"], ["guarded", "New (23 Nov)"], ["guarded_silent", "New + silent tools (23 Nov, testing)"],
      ["rt_eleven", LABELS.rt_eleven], ["rt_eleven_mini", LABELS.rt_eleven_mini], ["classic", "Old baseline (20 Nov)"],
    ]);
    expect(ENGINE_ORDER).toEqual(["current", "guarded", "guarded_silent", "rt_eleven", "rt_eleven_mini", "classic"]);
    expect(t(engineHelpKey("rt_eleven"))).toBe("GPT-Realtime 2.1 listens and decides and answers in text; ElevenLabs speaks. Test lab only.");
    expect(t(engineHelpKey("rt_eleven_mini"))).toBe("GPT-Realtime mini listens and decides and answers in text; ElevenLabs speaks. Test lab only.");
  });

  it("never shows them to a seller, and the server ignores the field from one", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    const html = await render();
    expect(html).not.toContain("ElevenLabs");
    for (const engine of ["rt_eleven", "rt_eleven_mini"] as const) {
      expect(await startVoiceCallAction({ slug, engine })).toEqual({ ok: false, reason: "not_allowed" });
      expect(labEngineChoice(seller, engine, { VOICE_REALTIME: "scripted" })).toBe("current");
      expect(labEngineChoice(admin, engine, { VOICE_REALTIME: "scripted" })).toBe(engine);
    }
  });

  for (const engine of ["rt_eleven", "rt_eleven_mini"] as const) {
    it(`an admin's ${engine} call: stored with its realtime model; saved: Engine, Listening + thinking, Speaking, Voice: Rachel (ElevenLabs), recorded as usual; Call again keeps it`, async () => {
      vi.stubEnv("VOICE_REALTIME", "scripted");
      vi.stubEnv("VOICE_WS_URL", "");
      as(admin);
      const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine });
      if (!r.ok) throw new Error(r.reason);
      expect(r.engine).toBe(engine);
      expect(r.model).toBe(`${MODEL_LABELS[engine]} · speak elevenlabs/eleven-v4-turbo`);
      expect(r.voiceUsed).toEqual({ voice: "Rachel (ElevenLabs)", fillers: false });
      const [s0] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
      expect(s0.settings).toEqual({ engine });
      expect(s0.model).toBe(engine === "rt_eleven" ? "openai/gpt-realtime-2.1" : "openai/gpt-realtime-mini");
      const speaker = await runRt(r.sessionId, engine);
      expect(speaker.said.length).toBeGreaterThan(0);
      const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
      expect(s.status).toBe("ended");
      expect(s.settings).toMatchObject({ engine, voice: "Rachel (ElevenLabs)", rtEleven: { speakModel: "scripted" } });
      const html = await render({ c: r.conversationId });
      if (engine === "rt_eleven") save("rt-eleven-page-call", html);
      expect(html).toContain(`Engine: ${LABELS[engine]}`);
      expect(html).toContain(`<dt>Engine</dt><dd data-voice-engine="">${LABELS[engine]}</dd>`);
      expect(html).toMatch(new RegExp(`<dt>Listening \\+ thinking</dt><dd data-voice-rt-model="" title="openai/gpt-realtime-[^"]+">${MODEL_LABELS[engine]}<span class="sas-small"> · scripted stand-in</span></dd>`));
      expect(html).toMatch(/<dt>Speaking<\/dt><dd data-voice-rt-speak="">scripted<\/dd>/);
      expect(html).toMatch(/<dt>Median answer time<\/dt><dd class="sas-num" data-voice-rt-median="">/);
      expect(html).toMatch(/<dt>Voice<\/dt><dd data-voice-used="">Rachel \(ElevenLabs\)<\/dd>/);
      // Not the pipeline's card, and the version's model row is replaced by the two model rows.
      expect(html).not.toContain("data-voice-pipeline-listen");
      expect(html).not.toContain('data-voice-model=""');
      expect(html).not.toContain("Not recorded (pipeline test)");
      const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
      expect(again.props).toMatchObject({ engine });
      const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
      const next = await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine });
      if (!next.ok) throw new Error(next.reason);
      expect(next.engine).toBe(engine);
      const [s1] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, next.sessionId));
      expect(s1.settings).toEqual({ engine });
      await endMyVoiceCallAction({ slug });
      as(seller);
      expect(await render({ c: r.conversationId })).not.toContain("ElevenLabs (testing)");
    });
  }
});
