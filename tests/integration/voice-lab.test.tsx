/**
 * Live voice in the test lab (release 1), on PGlite: the server actions give
 * nothing to anyone but a platform admin with voice on; the page shows no
 * voice UI otherwise (exactly as before); a saved voice conversation reads
 * back with its call (pills, spoken marks, This call, no composer). Scripted
 * mode only: no paid call.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, conversations, messages, sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
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
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }) }));
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
const { createVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { endMyVoiceCallAction, startVoiceCallAction, saveVoiceSettingsAction } = await import("@/app/app/[account]/setup/test-lab/voice-actions");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (TestLabPage as unknown as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));

/** With VOICE_RENDER_DIR set, the rendered pages are also written there as HTML (screenshots: tests/e2e/voice/harness-run.ts). */
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
let seller: User;
let account: SellerAccount;
let slug: string;

const as = (user: User) => {
  holder.access = { account, user, actingAs: user.role === "super_admin", role: user.role === "super_admin" ? "platform_admin" : "seller_admin" };
};
const convCount = async () => (await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.accountId, account.id))).length;

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

describe("startVoiceCallAction", () => {
  it("gives a seller nothing, even with voice on, and creates nothing", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    const before = await convCount();
    expect(await startVoiceCallAction({ slug, scenario: "ready_buyer" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await convCount()).toBe(before);
  });

  it("gives a platform admin nothing while voice is off", async () => {
    vi.stubEnv("VOICE_REALTIME", "off");
    as(admin);
    const before = await convCount();
    expect(await startVoiceCallAction({ slug })).toEqual({ ok: false, reason: "voice_off" });
    expect(await convCount()).toBe(before);
  });

  it("starts a scripted call for a platform admin: a voice test conversation, a one-time ticket, the socket on this host", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const r = await startVoiceCallAction({ slug, scenario: "ready_buyer", versionId: "not-a-uuid" });
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ mode: "scripted", wsUrl: "wss://app.example.com/api/voice/socket", maxSec: 270, fx: { currency: "ILS" } });
    expect(r.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, r.conversationId));
    expect(conv).toMatchObject({ channel: "voice", isTest: true, scenario: "ready_buyer", language: "en" });
    const [s] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId));
    expect(s).toMatchObject({ status: "pending", mode: "scripted", startedByUserId: admin.id });
    // One test call per account at a time: the same admin is offered to end it; someone else just waits.
    expect(await startVoiceCallAction({ slug })).toEqual({ ok: false, reason: "already_in_call", ownCall: true });
    const [other] = await db.insert(users).values({ clerkId: "c", email: "other@p.test", firstName: "Oz", role: "super_admin" }).returning();
    as(other);
    expect(await startVoiceCallAction({ slug })).toEqual({ ok: false, reason: "already_in_call", ownCall: false });
    expect(await endMyVoiceCallAction({ slug })).toEqual({ ok: true });
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId)))[0].status).toBe("pending"); // not theirs
    as(seller);
    expect(await endMyVoiceCallAction({ slug })).toEqual({ ok: false });
    as(admin);
    expect(await endMyVoiceCallAction({ slug })).toEqual({ ok: true });
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId)))[0]).toMatchObject({ status: "ended", endReason: "user_hangup" });
    // The local dev relay: its URL, and no hosting deadline.
    vi.stubEnv("VOICE_WS_URL", "ws://localhost:8787/api/voice/socket");
    const local = await startVoiceCallAction({ slug });
    expect(local).toMatchObject({ ok: true, wsUrl: "ws://localhost:8787/api/voice/socket", maxSec: 480 });
    await endMyVoiceCallAction({ slug });
  });

  it("over the hourly limit: says when to try again", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(admin);
    const { rateLimits } = await import("@/db/schema");
    const start = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await db.insert(rateLimits).values({ key: `voice:${account.id}`, windowStart: new Date(start), count: 999 })
      .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: 999 } });
    const r = await startVoiceCallAction({ slug });
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
    if (r.ok) throw new Error();
    expect(new Date(r.retryAt!).getTime() - (start + 3_600_000)).toBeGreaterThanOrEqual(0);
    expect(new Date(r.retryAt!).getTime() - (start + 3_600_000)).toBeLessThan(1000);
    await db.delete(rateLimits);
  });
});

describe("saveVoiceSettingsAction", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    f.set("slug", slug);
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  it("refuses a seller and a voice-off deployment", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    expect(await saveVoiceSettingsAction({}, form({ pace: "slower", maxCallSec: "300" }))).toEqual({ failed: true });
    vi.stubEnv("VOICE_REALTIME", "off");
    as(admin);
    expect(await saveVoiceSettingsAction({}, form({ pace: "slower", maxCallSec: "300" }))).toEqual({ failed: true });
    const [draft] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "draft")));
    expect(draft.voiceSettings).toBeNull();
  });

  it("saves the draft's settings for a platform admin (only what the model offers) and closes the panel", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(admin);
    expect(await saveVoiceSettingsAction({}, form({ voice: "Nope", pace: "slower", maxCallSec: "300" }))).toMatchObject({ errors: { voice: expect.any(String) } });
    const err = await saveVoiceSettingsAction({}, form({ voice: "Kore", pace: "slower", fillers: "on", maxCallSec: "300", style: "quick" })).catch((e: { url?: string }) => e);
    expect((err as { url?: string }).url).toMatch(/\/setup\/test-lab\?voice_saved=\d+$/);
    const [draft] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "draft")));
    // Gemini (the default model) has no conversation style: it is not taken from the form.
    expect(draft.voiceSettings).toEqual({ voice: "Kore", pace: "slower", fillers: true, maxCallSec: 300 });
  });
});

describe("the test lab page", () => {
  it("shows no voice UI to a seller, nor to an admin while voice is off", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(seller);
    let html = await render();
    expect(html).not.toContain("data-voice-starter");
    expect(html).not.toContain("Call the agent");
    expect(html).not.toContain("Start call");
    expect(html).toContain("New test chat");
    // The row as it always was: "New test chat" with its Start button.
    expect(html).toMatch(/<\/svg>Start<\/button>/);
    expect(html).not.toContain("Start chat");
    vi.stubEnv("VOICE_REALTIME", "off");
    as(admin);
    html = await render({ panel: "voice" });
    expect(html).not.toContain("data-voice-starter");
    expect(html).not.toContain("Voice settings");
  });

  it("shows Call the agent next to New test chat for an admin with voice on, and the settings panel", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    as(admin);
    const html = await render();
    save("page-test-lab-starter", html);
    // One row of choices with two actions; the limit and the voice line under it.
    expect(html).toContain("New test chat or call");
    expect((html.match(/data-new-chat=""/g) ?? []).length).toBe(1);
    expect(html).toContain("data-voice-starter");
    expect(html).toContain("Start chat");
    expect(html).toContain("Start call");
    expect(html).toContain("Buyer language");
    expect(html).toContain("Calls: up to 4 min 30 s · Voice: Kore · firm, clear · Slower pace");
    const panel = await render({ panel: "voice" });
    save("page-settings-panel", panel);
    expect(panel).toContain("Saved in draft v");
    expect(panel).toContain("Save to draft");
    expect(panel).toContain("Reset to defaults");
    expect(panel).not.toContain("Conversation style");
    // Longest call: only what this deployment allows; the stored 5 min shows as the cap.
    expect(panel).toContain('<option value="270" selected="">4 min 30 s</option>');
    expect(panel).toContain('<option value="240">4 min</option>');
    expect(panel).not.toContain('value="300"');
    expect(panel).toContain("You hear the voice on your next test call.");
  });

  it("reads a saved voice call back: pills, spoken marks, This call, no composer", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    as(admin);
    const c = (await startVoiceTestConversation(db, account.id, admin.id, { scenario: "ready_buyer" }))!;
    const s = await createVoiceSession(db, { accountId: account.id, conversationId: c.conversationId, userId: admin.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const t0 = Date.now();
    await db.insert(messages).values([
      { accountId: account.id, conversationId: c.conversationId, actor: "agent", body: "Hi, this is the assistant.", language: "en", voiceSessionId: s.sessionId, spokenAtMs: 0, createdAt: new Date(t0) },
      { accountId: account.id, conversationId: c.conversationId, actor: "buyer", body: "Hello there.", language: "en", voiceSessionId: s.sessionId, spokenAtMs: 11_000, createdAt: new Date(t0 + 1) },
      { accountId: account.id, conversationId: c.conversationId, actor: "buyer", body: "Typed it.", language: "en", voiceSessionId: s.sessionId, spokenAtMs: 13_000, typedInCall: true, createdAt: new Date(t0 + 2) },
      { accountId: account.id, conversationId: c.conversationId, actor: "agent", body: "Sure.", language: "en", voiceSessionId: s.sessionId, spokenAtMs: 15_000, answerMs: 900, createdAt: new Date(t0 + 3) },
      { accountId: account.id, conversationId: c.conversationId, actor: "system", body: "Voice call ended · 0:38", language: "en", createdAt: new Date(t0 + 4) },
    ]);
    await db.update(voiceSessions).set({
      status: "ended", endReason: "opt_out", durationSec: 38, answerMsAvg: 900, settings: { maxCallSec: 270 },
      connectedAt: new Date(t0 - 1), endedAt: new Date(t0 + 4),
    }).where(eq(voiceSessions.id, s.sessionId));
    const html = await render({ c: c.conversationId });
    save("page-saved-call", html);
    // The call is framed by a start and a summary marker; the stored "Voice call ended" line is not shown again.
    expect(html).toContain('data-thread-marker="voice_started"');
    expect(html).toContain("Voice call started");
    expect(html).toContain("Voice call · 38 s");
    expect(html).not.toContain("Voice call ended · 0:38");
    expect(html.indexOf("Voice call started")).toBeLessThan(html.indexOf("Hi, this is the assistant."));
    expect(html.indexOf("Voice call · 38 s")).toBeGreaterThan(html.indexOf("Sure."));
    expect(html).toContain("data-voice-pill");
    expect(html).toContain("Scripted test");
    expect((html.match(/data-spoken=""/g) ?? []).length).toBe(4);
    expect(html).toContain('aria-label="Typed at 0:13 in the call"');
    expect(html).toContain('aria-label="Spoken at 0:11 in the call"');
    expect(html).toContain("0:11");
    expect(html).toContain("Call ended · 0:38");
    expect(html).toContain("No cost");
    expect(html).toContain("0:38 of 4:30");
    expect(html).toContain("0.9 s on average");
    expect(html).toContain("The buyer asked not to be contacted. The chat is closed.");
    expect(html).toContain("Call again");
    expect(html).not.toContain('id="lab-text"');
    // A finished call: no take-over footer; a scripted call is not counted as a scenario result.
    expect(html).not.toContain("Take over chat");
    expect(html).toContain("Scripted test: not counted");
    expect(html).not.toContain("Keep answering as the buyer");
    expect(html).toContain("Expected: The agent quotes from the catalog");
    // Spoken and typed lines show the time in the call only; the call's markers carry the clock time.
    expect((html.match(/class="sas-msg__time"/g) ?? []).length).toBe(0);
    expect((html.match(/data-thread-marker="voice_(?:started|ended)"/g) ?? []).length).toBe(2);
    // The list marks the voice row.
    expect(html).toMatch(/aria-label="Voice call"/);
    // A seller opening it sees the record, not the call controls.
    as(seller);
    const sellerHtml = await render({ c: c.conversationId });
    expect(sellerHtml).toContain("Call ended · 0:38");
    expect(sellerHtml).not.toContain("Call again");
    expect(sellerHtml).not.toContain('id="lab-text"');
  });
});
