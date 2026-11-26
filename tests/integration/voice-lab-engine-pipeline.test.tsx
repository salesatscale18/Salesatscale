/**
 * The pipeline engines (lib/voice-pipeline) after their retirement (owner, 24 Nov 2026: replaced in the selector by
 * the realtime + ElevenLabs engines): "Pipeline: Gemini Flash + ElevenLabs (testing)" (id "pipeline"), "Pipeline:
 * Gemini Flash-Lite + ElevenLabs (testing)" (id "pipeline_lite") and "Pipeline: chat model + ElevenLabs (testing)"
 * (id "pipeline_chat"), on PGlite in scripted mode: the select no longer offers them and the server refuses to start a
 * new call on one (also Call again on an old one); a saved pipeline call (made before) still shows its engine (header
 * pill, "This call") with its three models and "Not recorded (pipeline test)". With VOICE_RENDER_DIR set, the pages
 * are written as HTML for the screenshots (tests/e2e/voice/pipeline-shots.ts).
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
const { ENGINE_ORDER, engineHelpKey, engineLabelKey, labEngineChoice, sessionEngine } = await import("@/lib/voice-classic/engine-choice");
const { createVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { t } = await import("@/lib/i18n");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { PipelineVoiceEngine } = await import("@/lib/voice-pipeline/engine");
const { ManualListener } = await import("@/lib/voice-pipeline/listener");
const { ScriptedSpeaker } = await import("@/lib/voice-pipeline/speaker");
const { scriptedPipelineLlm } = await import("@/lib/voice-pipeline");
const { PIPELINE_LISTEN_MODEL, PIPELINE_SPEAK_MODEL } = await import("@/lib/voice-pipeline/models");

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

/** Runs a pipeline call's session to its end (scripted parts, the opener only): the relay's part, in process. */
async function runPipeline(sessionId: string, name: "pipeline" | "pipeline_lite" | "pipeline_chat" = "pipeline", thinkModel = "scripted") {
  const clock = new ManualClock();
  const engine = new PipelineVoiceEngine({
    db, sessionId, mode: "scripted", engine: name, thinkModel, send: () => {}, clock, log: { info: () => {}, warn: () => {} },
    listener: () => new ManualListener(), speaker: new ScriptedSpeaker(), llm: scriptedPipelineLlm(), limits: { env: {} },
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await flushAsync(4);
      await new Promise((r) => setTimeout(r, 3));
    }
  };
  await engine.start();
  await settle();
  await clock.advance(5_000, settle);
  engine.onClientMessage({ t: "end" });
  await settle();
}

const LABELS = {
  pipeline: "Pipeline: Gemini Flash + ElevenLabs (testing)",
  pipeline_lite: "Pipeline: Gemini Flash-Lite + ElevenLabs (testing)",
  pipeline_chat: "Pipeline: chat model + ElevenLabs (testing)",
} as const;

/** An old pipeline call: its session as the start action created it before the retirement (createVoiceSession). */
async function oldPipelineCall(engine: "pipeline" | "pipeline_lite" | "pipeline_chat") {
  const conv = await startVoiceTestConversation(db, account.id, admin.id, { scenario: "ready_buyer", language: "en" });
  if (!conv) throw new Error("no conversation");
  const s = await createVoiceSession(db, { accountId: account.id, conversationId: conv.conversationId, userId: admin.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" }, engine });
  if (!s.ok) throw new Error(s.reason);
  return { conversationId: conv.conversationId, sessionId: s.sessionId };
}

describe("test lab: the retired pipeline engines", () => {
  it("the select no longer offers them; their labels and helper lines stay (old calls' cards)", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render({ mode: "voice" });
    save("pipeline-page-engine-select", html);
    const select = /<select[^>]*data-voice-engine-select=""[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    const options = [...select.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(["guarded", "current", "classic"]);
    expect(html).not.toContain("Pipeline:");
    expect(ENGINE_ORDER).not.toContain("pipeline");
    for (const engine of ["pipeline", "pipeline_lite", "pipeline_chat"] as const) {
      expect(t(engineLabelKey(engine))).toBe(LABELS[engine]);
      expect(sessionEngine({ engine })).toBe(engine);
    }
    expect(t(engineHelpKey("pipeline_lite"))).toBe("A transcription model listens, Gemini 3.5 Flash-Lite decides like the chat agent (faster, lighter), ElevenLabs speaks. Test lab only.");
  });

  it("the server refuses to start a new call on one, for an admin and a seller alike; nothing is created", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    const before = (await db.select().from(voiceSessions)).length;
    for (const user of [admin, seller]) {
      as(user);
      for (const engine of ["pipeline", "pipeline_lite", "pipeline_chat"] as const) {
        expect(await startVoiceCallAction({ slug, scenario: "ready_buyer", engine })).toEqual({ ok: false, reason: "not_allowed" });
      }
    }
    expect((await db.select().from(voiceSessions)).length).toBe(before);
    expect(labEngineChoice(seller, "pipeline", { VOICE_REALTIME: "scripted" })).toBe("guarded");
    expect(sessionEngine({ engine: "Pipeline" })).toBe("current");
    expect(sessionEngine({ engine: "pipeline-chat" })).toBe("current");
  });

  for (const engine of ["pipeline", "pipeline_lite", "pipeline_chat"] as const) {
    it(`an old ${engine} call still shows: Engine, the three models, not recorded (pipeline test); Call again on it is refused`, async () => {
      vi.stubEnv("VOICE_REALTIME", "scripted");
      vi.stubEnv("VOICE_WS_URL", "");
      as(admin);
      const r = await oldPipelineCall(engine);
      await runPipeline(r.sessionId, engine);
      const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
      expect(s.status).toBe("ended");
      expect(s.settings).toMatchObject({ engine });
      const html = await render({ c: r.conversationId });
      if (engine === "pipeline") save("pipeline-page-call", html);
      expect(html).toContain('data-voice-engine-pill=""');
      expect(html).toContain(`Engine: ${LABELS[engine]}`);
      expect(html).toContain(`<dt>Engine</dt><dd data-voice-engine="">${LABELS[engine]}</dd>`);
      expect(html).toMatch(/<dt>Listening<\/dt><dd data-voice-pipeline-listen="">scripted<\/dd>/);
      expect(html).toMatch(/<dt>Speaking<\/dt><dd data-voice-pipeline-speak="">scripted<\/dd>/);
      expect(html).toContain("Median answer time");
      expect(html).toContain("Not recorded (pipeline test)");
      const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
      expect(again.props).toMatchObject({ engine });
      const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
      expect(await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine })).toEqual({ ok: false, reason: "not_allowed" });
      as(seller);
      expect(await render({ c: r.conversationId })).not.toContain("Pipeline:");
    });
  }

  it("an old pipeline_lite call that thought on Gemini 3.5 Flash-Lite: the Thinking row names it (the model id in its title)", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const r = await oldPipelineCall("pipeline_lite");
    await runPipeline(r.sessionId, "pipeline_lite", "google/gemini-3.5-flash-lite");
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.settings).toMatchObject({ engine: "pipeline_lite", pipeline: { thinkModel: "google/gemini-3.5-flash-lite" } });
    const html = await render({ c: r.conversationId });
    expect(html).toContain(`<dt>Engine</dt><dd data-voice-engine="">${LABELS.pipeline_lite}</dd>`);
    expect(html).toMatch(/<dt>Thinking<\/dt><dd data-voice-pipeline-think="" title="google\/gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite<\/dd>/);
  });
});
