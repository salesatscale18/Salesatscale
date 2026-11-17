import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { providerEvents, rateLimits, users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { startTestConversation } from "@/lib/agent/service";
import { createIntakeKey, listDeliveries } from "@/lib/leads/service";
import { handleProviderEvent, signFake } from "@/lib/payments/events";
import { rateLimit } from "@/lib/security/rate-limit";
import { createTestDb, type TestDb } from "../helpers/db";

// Routes and actions read the app database from lib/auth/account; point it at PGlite.
const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: () => ({ userId: null, actingAs: false }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "198.51.100.9" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/agent/llm", () => ({
  llmConfigured: () => true,
  AnthropicLlm: class { constructor() { throw new Error("model must not be called"); } },
}));

const intake = await import("@/app/api/leads/[account]/route");
const fakePay = await import("@/app/api/payments/fake/route");
const buyer = await import("@/app/f/[token]/actions");
const lab = await import("@/app/app/[account]/setup/test-lab/actions");

/** Runs a server action and returns the URL it redirected to. */
async function redirectOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  return null;
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("hardening: rate limits, body size, rejected provider events", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let key = "", accountId = "", userId = "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    const [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    userId = admin.id;
    const actor = { userId: admin.id, actingAs: false };
    const p = parseCreateAccount({ tradeName: "Alpha", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "alpha@x.test" });
    if (!p.ok) throw new Error("bad");
    const { account } = await createAccount(db, actor, p.value);
    accountId = account.id;
    key = (await createIntakeKey(db, actor, account.id, "Website")).key;
    holder.access = { account, user: admin, actingAs: false, role: "seller_admin" };
  });
  afterAll(async () => t.close());
  // Fixed clock in the middle of a window, so no test straddles a window boundary.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-15T10:20:30Z")); });
  afterEach(() => { vi.useRealTimers(); });

  const intakeCall = (slug: string, ip: string, opts: { body?: string; key?: string; headers?: Record<string, string> } = {}) =>
    intake.POST(new Request(`http://test/api/leads/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1`, ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...opts.headers },
      body: opts.body ?? "{}",
    }), { params: Promise.resolve({ account: slug }) });

  it("intake: 60 per minute per account and IP, then 429 with Retry-After", async () => {
    for (let i = 0; i < 60; i++) expect((await intakeCall("alpha", "203.0.113.1")).status).toBe(401);
    const limited = await intakeCall("alpha", "203.0.113.1", { key });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("30");
    expect((await limited.json()).error).toBe("rate_limited");
    // Another IP on the same account is not affected.
    expect((await intakeCall("alpha", "203.0.113.2")).status).toBe(401);
  });

  it("intake: 120 per minute per IP across accounts", async () => {
    for (let i = 0; i < 120; i++) expect((await intakeCall(`slug-${i % 3}`, "203.0.113.3")).status).toBe(401);
    expect((await intakeCall("slug-9", "203.0.113.3")).status).toBe(429);
  });

  it("intake: refuses an over-size Content-Length with 413 before reading, and logs it", async () => {
    const res = await intakeCall("alpha", "203.0.113.4", { key, body: "{}", headers: { "content-length": "40000" } });
    expect(res.status).toBe(413);
    const deliveries = await listDeliveries(db, accountId);
    expect(deliveries.some((d) => d.delivery.reason === "Body over 32 KB")).toBe(true);
    // The slice stays as a backstop when the header is missing.
    expect((await intakeCall("alpha", "203.0.113.4", { key, body: "x".repeat(40_000) })).status).toBe(413);
  });

  const payCall = (ip: string, body: string, headers: Record<string, string> = {}) =>
    fakePay.POST(new Request("http://test/api/payments/fake", { method: "POST", headers: { "x-forwarded-for": ip, ...headers }, body }));

  it("fake payment webhook: 60 per minute per IP, then 429", async () => {
    for (let i = 0; i < 60; i++) expect((await payCall("203.0.113.10", "{}")).status).toBe(400);
    const limited = await payCall("203.0.113.10", "{}");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await payCall("203.0.113.11", "{}")).status).toBe(400);
  });

  it("fake payment webhook: 413 on an over-size Content-Length", async () => {
    expect((await payCall("203.0.113.12", "{}", { "content-length": "20000" })).status).toBe(413);
  });

  it("rejected provider events keep only size and hash, never the body", async () => {
    const forged = JSON.stringify({ id: "evt_forged", type: "payment.succeeded", provider_ref: "x", note: "<script>attacker</script>" });
    expect(await handleProviderEvent(db, "fake", forged, "0".repeat(64))).toBe("rejected: bad signature");
    const junk = "not json attacker-text";
    expect(await handleProviderEvent(db, "fake", junk, signFake(junk))).toBe("rejected: malformed");
    const rows = await db.select().from(providerEvents);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const raws = rows.map((r) => r.raw);
    expect(raws).toContainEqual({ size: Buffer.byteLength(forged), sha256: sha(forged) });
    expect(raws).toContainEqual({ size: junk.length, sha256: sha(junk) });
    expect(rows.filter((r) => r.result === "rejected: malformed")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("attacker");
  });

  it("buyer actions: 20 per 10 minutes per link; the key holds no token", async () => {
    const token = "tok_example_not_real_123";
    const urls: (string | null)[] = [];
    for (let i = 0; i < 20; i++) urls.push(await redirectOf(buyer.payBankAction(form({ token, lang: "en" }))));
    expect(urls.every((u) => u !== null && !u.includes("rate_limited"))).toBe(true);
    expect(await redirectOf(buyer.payBankAction(form({ token, lang: "en" })))).toBe(`/f/${token}?lang=en&err=rate_limited`);
    expect(await redirectOf(buyer.payCardAction(form({ token, lang: "he" })))).toBe(`/f/${token}?lang=he&err=rate_limited`);
    expect(await redirectOf(buyer.acceptPriceAction(form({ token, lang: "en" })))).toBe(`/f/${token}?lang=en&err=rate_limited`);
    expect(await redirectOf(buyer.stepAction(form({ token, lang: "en", step: "3", intent: "sign" })))).toBe(`/f/${token}?lang=en&step=3&err=rate_limited`);
    // Another link has its own budget.
    expect(await redirectOf(buyer.payBankAction(form({ token: "tok_other", lang: "en" })))).not.toContain("rate_limited");
    const keys = (await db.select().from(rateLimits)).map((r) => r.key);
    expect(keys.some((k) => k.includes(token))).toBe(false);
  });

  it("test lab: 120 messages per account per hour, then rate_limited without calling the model", async () => {
    const c = (await startTestConversation(db, accountId, userId, { language: "en" }))!;
    const now = new Date();
    for (let i = 0; i < 120; i++) await rateLimit(db, `testlab:${accountId}`, { limit: 120, windowSeconds: 3600 }, now);
    const url = await redirectOf(lab.sendTestMessageAction(form({ slug: "alpha", conversationId: c.conversationId, text: "Hi" })));
    expect(url).toBe(`/app/alpha/setup/test-lab?c=${c.conversationId}&error=rate_limited`);
  });

  it("test lab: a non-uuid id from the form is refused before any query", async () => {
    expect(await redirectOf(lab.sendTestMessageAction(form({ slug: "alpha", conversationId: "nope' or 1=1", text: "Hi" })))).toBe("/app/alpha/setup/test-lab");
    expect(await redirectOf(lab.rollbackAction(form({ slug: "alpha", versionId: "not-a-uuid" })))).toBe("/app/alpha/setup/test-lab");
  });
});
