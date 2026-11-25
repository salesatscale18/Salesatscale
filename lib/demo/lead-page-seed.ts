/**
 * The demo account's lead page (lead pages phase 1): one live "Button or link"
 * page with the hand-over banner, 14 days of visit counters and two
 * submissions, so Lead pages, the page view, the Leads filter and the lead
 * card's "Lead page · …" line all have something to show.
 *
 * - The page is made and put live through the same services the seller uses
 *   (createLeadPage, goLiveLeadPage: audited, with the go-live checks).
 * - The banner goes in through the normal banner save (saveLeadPageBanner: the
 *   private blob store, under its sha256). Where the store cannot be written
 *   (tests, Preview, no BLOB_READ_WRITE_TOKEN) the page is seeded without it
 *   and shows the initials tile; the seller can add it from Edit.
 * - The two submissions belong to two existing demo leads (fictional numbers,
 *   never contacted): they are written the way the public form writes them
 *   (a submission row, leads.lead_page_id and the lead_page.submitted event),
 *   at the time the lead was added, so the funnel counts their chats, quote
 *   and order. No buyer request is made and nothing is sent.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents, leadPageDaily, leadPages, leadPageSubmissions, leads, sellerAccounts } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { readOpener } from "@/lib/agent/core/opener";
import { currentPlaybook } from "@/lib/agent/service";
import { LEAD_PAGE_EVENTS } from "@/lib/lead-pages/intake";
import { dayOf, createLeadPage, goLiveLeadPage, saveLeadPageBanner } from "@/lib/lead-pages/service";
import { listMarkets } from "@/lib/markets/service";
import type { FileStore } from "@/lib/sources/blob";
import { DEMO_BANNER_WEBP_BASE64 } from "./lead-page-banner";

export const DEMO_LEAD_PAGE = {
  name: "Fridge monitoring · restaurants",
  address: "https://www.polar-demo.example/restaurants",
  /** Days of visit counters before the seed ran (today included). */
  days: 14,
  /** Hosted-form loads per day and source: for a button or link each load is a visit and an open. */
  perDay: [
    { sourceKey: "facebook / restaurants-nov", opens: 9 },
    { sourceKey: "google / fridge monitoring", opens: 4 },
    { sourceKey: "", opens: 2 },
  ],
} as const;

/** The two submissions: [lead, source key, number of sites]. */
type DemoSubmission = { leadId: string; firstName: string; sourceKey: string; utm: { source: string; campaign: string }; sites: number };

export type DemoLeadPageResult = { pageId: string; bannerSaved: boolean; submissions: number };

export async function seedDemoLeadPage(
  db: Db, actor: Actor & { userId: string }, accountId: string,
  opts: { now: Date; submissions: { leadId: string; sites: number; source: "facebook" | "google" }[]; store: FileStore | null; env?: Record<string, string | undefined> },
): Promise<DemoLeadPageResult> {
  const { now } = opts;
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) throw new Error("Demo seed: account vanished");
  const [markets, playbook] = await Promise.all([listMarkets(db, accountId), currentPlaybook(db, accountId)]);
  const home = markets.find((m) => m.isHome) ?? markets[0];
  const opener = readOpener(playbook?.opener);
  const topic = opener.topics[opener.defaultTopic] ?? null;

  const made = await createLeadPage(db, actor, account, {
    name: DEMO_LEAD_PAGE.name, address: DEMO_LEAD_PAGE.address, connection: "link", language: "en", marketId: home?.id ?? "",
    fields: { company: true, sites: true }, consentTicked: true, openingTopic: topic, tracking: { carryAdDetails: true },
  });
  if (!made.ok) throw new Error(`Demo seed: lead page is invalid: ${JSON.stringify(made.errors)}`);
  const page = made.page;
  const wentLive = new Date(now.getTime() - DEMO_LEAD_PAGE.days * 86_400_000);
  const live = await goLiveLeadPage(db, actor, accountId, page.id, wentLive);
  if (!live.ok) throw new Error(`Demo seed: lead page go live refused: ${live.reason === "blocked" ? live.blockers.join(", ") : live.reason}`);
  // As if made two weeks ago, a little before it went live.
  await db.update(leadPages).set({ createdAt: new Date(wentLive.getTime() - 3_600_000) }).where(and(eq(leadPages.id, page.id), eq(leadPages.accountId, accountId)));

  // The banner, through the normal save (blob store); skipped where nothing can be stored.
  const banner = await saveLeadPageBanner(db, actor, accountId, page.id, new Uint8Array(Buffer.from(DEMO_BANNER_WEBP_BASE64, "base64")), opts.store, opts.env);
  if (!banner.ok) console.info("[demo] lead page seeded without its banner", { reason: banner.reason });

  // Visit counters: one row per day and source (the hosted form's load counts as a visit and an open).
  const rows: (typeof leadPageDaily.$inferInsert)[] = [];
  for (let d = 0; d < DEMO_LEAD_PAGE.days; d++) {
    const day = dayOf(new Date(now.getTime() - d * 86_400_000));
    for (const [i, s] of DEMO_LEAD_PAGE.perDay.entries()) {
      // A little day-to-day variation, the same on every run.
      const opens = Math.max(0, s.opens + ((d * 7 + i * 3) % 5) - 2);
      rows.push({ accountId, pageId: page.id, day, sourceKey: s.sourceKey, views: opens, opens, rejected: d % 6 === 0 && i === 0 ? 1 : 0 });
    }
  }
  await db.insert(leadPageDaily).values(rows);

  // Two submissions, as the public form writes them, at the time each lead was added.
  const UTM = { facebook: { source: "facebook", campaign: "restaurants-nov" }, google: { source: "google", campaign: "fridge monitoring" } } as const;
  const subs: DemoSubmission[] = [];
  for (const s of opts.submissions) {
    const [lead] = await db.select({ id: leads.id, fullName: leads.fullName }).from(leads).where(and(eq(leads.accountId, accountId), eq(leads.id, s.leadId)));
    if (!lead) throw new Error("Demo seed: lead page lead not found");
    subs.push({ leadId: lead.id, firstName: lead.fullName.split(" ")[0] ?? "", sourceKey: `${UTM[s.source].source} / ${UTM[s.source].campaign}`, utm: UTM[s.source], sites: s.sites });
  }
  for (const s of subs) {
    const [lead] = await db.select({ createdAt: leads.createdAt }).from(leads).where(and(eq(leads.accountId, accountId), eq(leads.id, s.leadId)));
    const at = lead.createdAt;
    const submissionId = crypto.randomUUID();
    await db.insert(leadPageSubmissions).values({
      id: submissionId, accountId, pageId: page.id, leadId: s.leadId, via: "link", leadCreated: true, consent: true, preview: false, language: "en",
      answers: { firstName: s.firstName, sites: s.sites }, ad: { utm: s.utm }, sourceKey: s.sourceKey, chatChoice: "text", handoverAt: at, sms: "skipped", createdAt: at,
    });
    await db.update(leads).set({ leadPageId: page.id }).where(and(eq(leads.accountId, accountId), eq(leads.id, s.leadId)));
    await db.insert(leadEvents).values({
      accountId, leadId: s.leadId, type: LEAD_PAGE_EVENTS.submitted, actor: "buyer", createdAt: at,
      data: { pageId: page.id, submissionId, page: page.name, topic: topic?.en || null, created: true, consent: true, sites: s.sites, source: s.sourceKey },
    });
  }
  return { pageId: page.id, bannerSaved: banner.ok, submissions: subs.length };
}
