/**
 * Consent on by default (owner, 22 Nov): "those all come from a lead that by
 * definition has asked for us to call him back". The Add lead panel and Import
 * have the box ticked and no "How they agreed" field; the consent record is
 * written automatically (who, when, from where). Unticked: the lead is saved
 * and every agent-initiated send refuses it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { consentRecords, conversations, leadEvents, leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { CONSENT_WORDING_DEFAULT } from "@/lib/leads/rules";
import { latestConsent } from "@/lib/leads/service";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { addLeadAction, importLeadsAction } = await import("@/app/app/[account]/leads/actions");
const { AddLeadForm } = await import("@/app/app/[account]/leads/add-lead-form");
const { ImportForm } = await import("@/app/app/[account]/leads/import/import-form");
const { startWhatsAppConversation } = await import("@/lib/channels/whatsapp");
const { ensureChatStarted } = await import("@/lib/chat/start");
const { nudgeBuyer } = await import("@/lib/sms/service");
const { MockSmsTransport } = await import("@/lib/sms/transport");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { POST: intakePost } = await import("@/app/api/leads/[account]/route");
const { createIntakeKey } = await import("@/lib/leads/service");

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const form = (v: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};

describe("consent on by default", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User, emailOnly: User;
  let acc: SellerAccount;
  const as = (user: User) => { holder.access = { account: acc, user, actingAs: false, role: "seller_admin" }; };
  const leadByPhone = async (phone: string) => (await db.select().from(leads).where(eq(leads.phone, phone)))[0];
  const add = (v: Record<string, string>) => run(addLeadAction({ status: "idle" }, form({ slug: acc.slug, fullName: "Rina Cohen", language: "en", ...v })));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u1", email: "dana.levi@seller.example", firstName: "Dana", lastName: "Levi" }).returning();
    [emailOnly] = await db.insert(users).values({ clerkId: "u2", email: "omer+test@seller.example" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await ensureDraftVersion(db, acc.id);
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc.id)).returning();
    as(me);
  });
  afterAll(async () => t.close());

  it("Add lead: the box is ticked by default, with the new hint and no 'How they agreed' field", () => {
    const html = renderToStaticMarkup(<AddLeadForm slug="polar" languages={["en", "he"]} closeHref="/app/polar/leads" />);
    const tag = (name: string, value?: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*${value ? `value="${value}"` : ""}[^>]*>`))![0];
    expect(tag("consent")).toContain('checked=""');
    expect(html).toContain("This person asked to be contacted by SMS, WhatsApp or email");
    expect(html).toContain("Leads in your system asked to hear from you. Untick only if this person must not be contacted by the agent.");
    expect(html).not.toContain("consentSource");
    expect(html).not.toContain("How they agreed");
    // With consent, "Let the agent start" is offered and chosen.
    expect(tag("after", "agent")).toContain('checked=""');
    expect(tag("after", "agent")).not.toContain("disabled");
  });

  it("Import: the whole-file box is ticked by default, nothing to type, and Import is not blocked", () => {
    const html = renderToStaticMarkup(<ImportForm slug="polar" who="Dana Levi" />);
    expect(html.match(/<input[^>]*name="fileConsent"[^>]*>/)![0]).toContain('checked=""');
    expect(html).not.toContain("fileConsentSource");
    expect(html).not.toContain("How they agreed");
    expect(html.match(/<button type="submit"[^>]*>/)![0]).not.toMatch(/ disabled=/);
  });

  it("Add lead, ticked: the consent record says who added the lead, when, and that it was in the app", async () => {
    const before = new Date();
    const r = await add({ phone: "0525550111", consent: "yes", after: "agent" });
    expect((r as { redirect: string }).redirect).toMatch(/\/leads\/[0-9a-f-]{36}$/);
    const lead = await leadByPhone("+972525550111");
    expect(lead.ownerUserId).toBeNull();
    const c = await latestConsent(db, acc.id, lead.id);
    expect(c?.consent).toMatchObject({ source: "Added by Dana Levi in the app", wording: CONSENT_WORDING_DEFAULT, recordedByUserId: me.id });
    expect(c!.consent.capturedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const [ev] = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id)).then((e) => e.filter((x) => x.type === "consent.recorded"));
    expect(ev.data).toMatchObject({ source: "Added by Dana Levi in the app" });
  });

  it("Add lead ignores a typed source and never shows a person as a full email", async () => {
    as(emailOnly);
    try {
      await add({ phone: "0525550112", consent: "yes", consentSource: "typed by hand" });
      const c = await latestConsent(db, acc.id, (await leadByPhone("+972525550112")).id);
      expect(c?.consent.source).toBe("Added by omer in the app");
      expect(c?.consent.source).not.toContain("@");
    } finally {
      as(me);
    }
  });

  it("Add lead, unticked: saved without consent, owned by the person, and every agent-initiated send refuses it", async () => {
    // The browser sends no "consent" for an unticked box; "after" is forced to "I'll contact them myself".
    const r = await add({ phone: "0525550113", after: "agent" });
    expect((r as { redirect: string }).redirect).toMatch(/\/leads\/[0-9a-f-]{36}$/);
    const lead = await leadByPhone("+972525550113");
    expect(lead).toMatchObject({ status: "new", ownerUserId: me.id });
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id))).toHaveLength(0);

    const actor = { userId: me.id, actingAs: false };
    // WhatsApp opener, the web chat opener (Send chat link, order form, the buyer opening the link), SMS.
    expect(await startWhatsAppConversation(db, null, actor, acc.id, lead.id)).toMatchObject({ ok: false, reason: "no_consent" });
    expect(await ensureChatStarted(db, { accountId: acc.id, leadId: lead.id })).toEqual({ started: false, reason: "no_consent" });
    const tr = new MockSmsTransport();
    const env = { SMS_MODE: "test", SMS_TEST_NUMBERS: lead.phone, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}`, APP_URL: "https://app.example.com" };
    expect(await nudgeBuyer(db, actor, { accountId: acc.id, leadId: lead.id, kind: "chat_link" }, { transport: tr, env })).toEqual({ outcome: "refused", reason: "no_consent" });
    expect(tr.sent).toHaveLength(0);
    // No conversation was opened, so the agent has nothing to follow up on.
    expect(await db.select().from(conversations).where(eq(conversations.leadId, lead.id))).toHaveLength(0);

    // The same gates let a ticked lead through (the refusals above are the consent gate, not something else).
    const ok = await leadByPhone("+972525550111");
    expect(await ensureChatStarted(db, { accountId: acc.id, leadId: ok.id })).toMatchObject({ started: true });
  });

  it("Import, ticked: rows without a note get a record naming the file; a row's own note is kept", async () => {
    const csv = "full_name,phone,language,consent_source\nNoa Shalev,0525550201,he,\nAvi Mizrahi,0525550202,he,Signed sheet at the expo";
    const r = await importLeadsAction({ status: "idle" }, form({ slug: acc.slug, fileConsent: "yes", file: new File([csv], "expo-leads.csv", { type: "text/csv" }) }));
    expect(r).toMatchObject({ status: "done", fileConsent: true, fileName: "expo-leads.csv", result: { created: 2, rejected: [] } });
    const noa = await latestConsent(db, acc.id, (await leadByPhone("+972525550201")).id);
    expect(noa?.consent).toMatchObject({ source: "Imported from expo-leads.csv", wording: CONSENT_WORDING_DEFAULT, recordedByUserId: me.id });
    expect((await latestConsent(db, acc.id, (await leadByPhone("+972525550202")).id))?.consent.source).toBe("Signed sheet at the expo");
  });

  it("Import, unticked: the leads are saved and none of them can be contacted", async () => {
    const csv = "full_name,phone,language,consent_source\nUn Ticked,0525550203,he,\nOwn Note,0525550204,he,Signed sheet";
    const r = await importLeadsAction({ status: "idle" }, form({ slug: acc.slug, file: new File([csv], "no-contact.csv", { type: "text/csv" }) }));
    expect(r).toMatchObject({ status: "done", fileConsent: false, result: { created: 2, rejected: [] } });
    for (const phone of ["+972525550203", "+972525550204"]) {
      const lead = await leadByPhone(phone);
      expect(await latestConsent(db, acc.id, lead.id)).toBeNull();
      expect(await ensureChatStarted(db, { accountId: acc.id, leadId: lead.id })).toEqual({ started: false, reason: "no_consent" });
    }
  });

  const consentLine = async (leadId: string) => {
    const html = renderToStaticMarkup(await LeadCardPage({ params: Promise.resolve({ account: acc.slug, leadId }), searchParams: Promise.resolve({}) }));
    return (html.split('data-testid="consent"')[1] ?? "").split("</span>")[0].replace(/^[^>]*>/, "").replace(/<[^>]+>/g, "").replace(/[\u2066-\u2069]/g, "");
  };

  it("Lead card: the automatic Add lead record has no 'Recorded by'; a typed or other source keeps it", async () => {
    const auto = await consentLine((await leadByPhone("+972525550111")).id);
    expect(auto).toMatch(/^Consent: Added by Dana Levi in the app, .+\.$/);
    expect(auto).not.toContain("Recorded by");
    // Import file and a row's own note: still "Recorded by".
    expect(await consentLine((await leadByPhone("+972525550201")).id)).toMatch(/^Consent: Imported from expo-leads\.csv, .+\. Recorded by you\.$/);
    expect(await consentLine((await leadByPhone("+972525550202")).id)).toContain("Recorded by you.");
    // A note that only looks like the automatic one but has no recording user (intake) keeps the full line.
    const [l] = await db.insert(leads).values({ accountId: acc.id, fullName: "Look Alike", phone: "+972525550299", language: "en", origin: "webhook" }).returning();
    await db.insert(consentRecords).values({ accountId: acc.id, leadId: l.id, wording: "x", source: "Added by Someone in the app", capturedAt: new Date() });
    expect(await consentLine(l.id)).toContain("Recorded by");
  });

  it("the buyer sending the website form again gives consent to a lead saved unticked; a CSV re-import or a seller re-add does not", async () => {
    // Saved unticked by the seller.
    await add({ phone: "0525550300", after: "me" });
    const lead = await leadByPhone("+972525550300");
    expect(await latestConsent(db, acc.id, lead.id)).toBeNull();

    // Seller re-adds: shown as a duplicate, nothing changes.
    expect(await add({ phone: "0525550300", consent: "yes" })).toMatchObject({ status: "error", formError: "duplicate" });
    // CSV re-import with the whole-file box ticked: updated, still no consent.
    const csv = "full_name,phone,language\nRina Cohen,0525550300,en";
    const imp = await importLeadsAction({ status: "idle" }, form({ slug: acc.slug, fileConsent: "yes", file: new File([csv], "again.csv", { type: "text/csv" }) }));
    expect(imp).toMatchObject({ status: "done", result: { updated: 1 } });
    expect(await latestConsent(db, acc.id, lead.id)).toBeNull();
    expect(await ensureChatStarted(db, { accountId: acc.id, leadId: lead.id })).toEqual({ started: false, reason: "no_consent" });

    // The buyer submits the website form (intake API) again, with no consent note: their own request.
    const { key } = await createIntakeKey(db, { userId: me.id, actingAs: false }, acc.id, "Website");
    const res = await intakePost(new Request(`http://test/api/leads/${acc.slug}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ full_name: "Rina Cohen", phone: "+972525550300" }),
    }), { params: Promise.resolve({ account: acc.slug }) });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(lead.id);
    const c = await latestConsent(db, acc.id, lead.id);
    expect(c?.consent).toMatchObject({ source: 'Sent with intake key "Website"', wording: CONSENT_WORDING_DEFAULT, recordedByUserId: null });
    expect(await ensureChatStarted(db, { accountId: acc.id, leadId: lead.id })).toMatchObject({ started: true });
  });
});
