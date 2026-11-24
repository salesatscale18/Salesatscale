/**
 * The test lab's "Voice engine" selector with its fifth option, the pipeline proof ("Pipeline: listen, think, speak
 * (testing)", lib/voice-pipeline), on PGlite in scripted mode: a platform admin sees it and can start a pipeline call
 * (stored on the session); a seller never sees it and the server ignores the field from one; a saved pipeline call
 * shows its engine (header pill, "This call") with its three models, and Call again keeps it. With VOICE_RENDER_DIR
 * set, the pages are written as HTML for the screenshots (tests/e2e/voice/pipeline-shots.ts).
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
const { ENGINE_ORDER, engineHelpKey, labEngineChoice, sessionEngine } = await import("@/lib/voice-classic/engine-choice");
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
async function runPipeline(sessionId: string) {
  const clock = new ManualClock();
  const engine = new PipelineVoiceEngine({
    db, sessionId, mode: "scripted", send: () => {}, clock, log: { info: () => {}, warn: () => {} },
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

describe("test lab: the voice engine selector, pipeline proof", () => {
  it("a platform admin sees five engines, the pipeline fourth (before the old baseline), with its helper line", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render();
    save("pipeline-page-engine-select", html);
    const select = /<select[^>]*data-voice-engine-select=""[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    const options = [...select.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toHaveLength(5);
    expect(options[3]).toEqual(["pipeline", "Pipeline: listen, think, speak (testing)"]);
    expect(ENGINE_ORDER).toEqual(["current", "guarded", "guarded_silent", "pipeline", "classic"]);
    expect(t(engineHelpKey("pipeline"))).toBe("A transcription model listens, the chat agent decides, a speech model speaks. Test lab only.");
  });

  it("never shows it to a seller, and the server ignores the field from one", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    expect(await render()).not.toContain("Pipeline: listen");
    expect(await startVoiceCallAction({ slug, engine: "pipeline" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(labEngineChoice(seller, "pipeline", { VOICE_REALTIME: "scripted" })).toBe("current");
    expect(labEngineChoice(admin, "pipeline", { VOICE_REALTIME: "scripted" })).toBe("pipeline");
    expect(labEngineChoice(admin, "pipeline", { VOICE_REALTIME: "off" })).toBe("current");
    expect(sessionEngine({ engine: "pipeline" })).toBe("pipeline");
    expect(sessionEngine({ engine: "Pipeline" })).toBe("current");
  });

  it("an admin's pipeline call: stored on the session, its models named; saved: Engine and the three models on This call, Call again keeps it", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", engine: "pipeline" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.engine).toBe("pipeline");
    expect(r.model).toContain(`Listen ${PIPELINE_LISTEN_MODEL}`);
    expect(r.model).toContain(`speak ${PIPELINE_SPEAK_MODEL}`);
    const [s0] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s0.settings).toEqual({ engine: "pipeline" });
    await runPipeline(r.sessionId);
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s.status).toBe("ended");
    expect(s.settings).toMatchObject({ engine: "pipeline" });
    expect(s.recordingState).toBe("off");
    const html = await render({ c: r.conversationId });
    save("pipeline-page-call", html);
    expect(html).toContain('data-voice-engine-pill=""');
    expect(html).toContain("Engine: Pipeline: listen, think, speak (testing)");
    expect(html).toMatch(/<dt>Engine<\/dt><dd data-voice-engine="">Pipeline: listen, think, speak \(testing\)<\/dd>/);
    expect(html).toMatch(/<dt>Listening<\/dt><dd data-voice-pipeline-listen="">scripted<\/dd>/);
    expect(html).toMatch(/<dt>Thinking<\/dt><dd data-voice-pipeline-think="">[^<]+<\/dd>/);
    expect(html).toMatch(/<dt>Speaking<\/dt><dd data-voice-pipeline-speak="">scripted<\/dd>/);
    expect(html).toContain("Median answer time");
    const [again] = findElements(await pageElement({ c: r.conversationId }), VoiceCallAgainBar);
    expect(again.props).toMatchObject({ engine: "pipeline" });
    const props = again.props as { versionId: string | null; scenario: string | null; engine: string | null };
    const next = await startVoiceCallAction({ slug, versionId: props.versionId, scenario: props.scenario, engine: props.engine });
    if (!next.ok) throw new Error(next.reason);
    expect(next.engine).toBe("pipeline");
    await endMyVoiceCallAction({ slug });
    as(seller);
    expect(await render({ c: r.conversationId })).not.toContain("Pipeline: listen");
  });
});
