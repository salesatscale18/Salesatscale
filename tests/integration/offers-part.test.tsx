/**
 * Playbook › Offers as its own part (after Objections) and the Limits row that
 * points there, against the database. Scripted only: no model is called.
 *
 * - The part renders read first: active offers numbered in the agent's order
 *   with a drag handle, rows that are off below without a number, "Anything
 *   above these" pinned last, the rules note; one row opens its numbers.
 * - Menu, picker, Previous / Next and the home row with its saved-values summary.
 * - Each change saves ONE row through the row action (numbers, switch, move),
 *   writes only `offers` (and `maxDiscountBp` for General), keeps the stored
 *   shape and is refused at the row when out of range.
 * - Limits: "Discounts · Set per offer · in Offers", linked to the part.
 *
 * With OFFERS_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { users, type Playbook, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { defaultPlaybook } = await import("@/lib/agent/playbook");
const { offersOf } = await import("@/lib/agent/offer-settings");
const { loadVersionComparison } = await import("@/lib/agent/version-compare");
const { partForAnchor, partOfKey, partNeighbours } = await import("@/lib/agent/playbook-parts");
const { savePlaybookRowAction } = await import("@/app/app/[account]/setup/playbook/actions");
const { default: HomePage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
type Rec = Record<string, unknown>;

describe("Playbook › Offers part and the Limits discounts row", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  const actor = () => ({ userId: me.id, actingAs: false });
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.OFFERS_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
  };
  const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) => {
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: acc.slug, ...params }), searchParams: Promise.resolve(sp) }));
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const draftOf = async (id = acc.id) => (await ensureDraftVersion(db, id)).playbook as unknown as Rec;
  const order = (html: string) => [...html.matchAll(/data-offer="([a-z_]+)" data-on="(\d)"/g)].map((m) => [m[1], m[2]]);

  /** The seller's list: decide now first, General 10%, more units off. */
  const LIST = [
    { type: "decide_now", on: true, percentBp: 300 }, { type: "smaller_start", on: true }, { type: "general", on: true, percentBp: 1000 },
    { type: "more_units", on: false, percentBp: 500, minUnits: 10 }, { type: "pay_yearly", on: false, percentBp: 800 },
  ];
  const BASE = (): Playbook => ({ ...defaultPlaybook("Polar", 1000), handOffWhen: "The buyer is upset.", offerMeetingWhen: "The deal is large." });

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-offpart", email: "offpart@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const mk = async (tradeName: string) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o@${tradeName.toLowerCase()}-off.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account;
    };
    acc = await mk("Polar");
    other = await mk("Other");
    await saveDraftPlaybook(db, acc.id, { ...BASE(), offers: LIST } as Playbook);
    await publishDraftVersion(db, actor(), acc.id);
  }, 120_000);
  afterAll(async () => t.close());

  it("registered after Objections in the conversation; Previous / Next; old anchors land on it", () => {
    expect(partNeighbours("offers")).toEqual({ previous: "objections", next: "close" });
    expect(partForAnchor("#pb-offers-h")).toBe("offers");
    expect(partForAnchor("#pb-maxDiscount")).toBe("offers");
    expect(partForAnchor("#pb-offer.general.pct")).toBe("offers");
    expect(partOfKey("offer.more_units.units")).toBe("offers");
    expect(partOfKey("offers")).toBe("offers");
    // Limits keeps its own rows.
    expect(partOfKey("offerMeetingWhen")).toBe("limits");
    expect(partOfKey("handOffWhen")).toBe("limits");
  });

  it("read first: active offers numbered in order with a handle, off rows below without a number, the approval row pinned last", async () => {
    const html = await render(PartPage, { part: "offers" });
    save("offers-read", html);
    expect(html).toMatch(/aria-current="page" data-part="offers"/);
    expect(html).toContain('data-testid="part-picker"');
    expect(html).toContain('data-testid="draft-bar"');
    expect(html).toMatch(/rel="prev">.*Objections/);
    expect(html).toMatch(/rel="next">How a deal closes/);
    expect(order(html)).toEqual([["decide_now", "1"], ["smaller_start", "1"], ["general", "1"], ["more_units", "0"], ["pay_yearly", "0"]]);
    const places = [...html.matchAll(/class="pb-offer__place">(\d+)</g)].map((m) => m[1]);
    expect(places).toEqual(["1", "2", "3"]);
    expect((html.match(/data-sort-handle="/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-label="Move Decide now, place 1 of 3"');
    expect(html.indexOf('data-offer="above"')).toBeGreaterThan(html.indexOf('data-offer="pay_yearly"'));
    const s = text(html);
    for (const x of [
      "What the agent may offer after a price objection, one at a time, in this order.",
      "After a price objection the agent gets one offer at a time, in this order.",
      "Decide now", "3% off at most", "General discount", "10% off at most", "A smaller first step", "No discount", "Always on",
      "A saving when the buyer signs while the quote is valid (7 days).",
      "Spoken condition for now: the quote can't record a yearly term yet.",
      "Anything above these", "A bigger request waits for your approval.", "Always last",
      "The first quote never carries a discount.",
    ]) expect(s).toContain(x);
    // Switches: one per offer but the always-on one; off rows read "Off".
    expect((html.match(/role="switch"/g) ?? []).length).toBe(4);
    expect(html).toMatch(/aria-label="Offer More units"/);
    expect(html).not.toMatch(/<form class="pb-row__form"/);
    expect(html).toContain('aria-label="More for Decide now"');
  });

  it("one row open: its numbers only, with Save / Cancel (more units also has its units)", async () => {
    const html = await render(PartPage, { part: "offers" }, { edit: "offer.more_units" });
    save("offers-open", html);
    expect(html.match(/<form class="pb-row__form"/g)?.length).toBe(1);
    expect(html).toMatch(/data-row="offer\.more_units" data-open=""/);
    expect(html).toContain('id="pb-offer.more_units.pct"');
    expect(html).toContain('id="pb-offer.more_units.units"');
    expect(html).toContain('value="10"');
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Cancel</button>");
  });

  it("home: the Offers row after Objections, with the saved offers in order; the menu's short line counts them", async () => {
    const html = await render(HomePage, {});
    save("offers-home", html);
    const conv = html.slice(html.indexOf('data-part="objections"'), html.indexOf('data-part="close"'));
    expect(conv).toContain('data-part="offers"');
    const row = html.match(/data-part="offers">[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(text(row)).toContain("Decide now 3% · A smaller first step · General discount 10%");
    const part = await render(PartPage, { part: "limits" });
    expect(text(part.match(/data-part="offers"[\s\S]*?<\/a>/)?.[0] ?? "")).toContain("3 offers");
    expect(text(html.match(/data-part="limits">[\s\S]*?<\/a>/)?.[0] ?? "")).toContain("Discounts set per offer · hands over when: The buyer is upset.");
  });

  it("Limits: the discounts row reads 'Set per offer · in Offers' and links there; no discount input is left", async () => {
    const html = await render(PartPage, { part: "limits" });
    save("limits-read", html);
    const row = html.match(/data-row="discounts"[\s\S]*?<\/div><\/div>|data-row="discounts"[\s\S]*?data-offers-link=""[^>]*>[^<]*</)?.[0] ?? "";
    expect(text(row)).toContain("Discounts");
    expect(text(row)).toContain("Set per offer · in Offers");
    expect(html).toMatch(/href="\/app\/polar\/setup\/playbook\/offers"[^>]*data-offers-link="">Open</);
    expect(html).not.toContain('id="pb-maxDiscount"');
    expect(html).not.toContain('data-row="maxDiscount"');
    // Its other rows are kept.
    for (const x of ["Offer a call when", "Hand over to a person when", "Approved exceptions"]) expect(text(html)).toContain(x);
  });

  it("each change saves ONE row: numbers, a switch, a move — only `offers` (and the limit for General) is written", async () => {
    const before = await draftOf();
    const run = async (raw: unknown) => {
      holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
      return savePlaybookRowAction(acc.slug, raw);
    };
    const others = (a: Rec, b: Rec, own: string[]) => {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!own.includes(k)) expect([k, b[k]]).toEqual([k, a[k]]);
    };
    expect(await run({ kind: "offer", type: "more_units", pct: "7", units: "12" })).toEqual({ ok: true });
    let after = await draftOf();
    others(before, after, ["offers"]);
    expect((after.offers as { type: string }[]).find((o) => o.type === "more_units")).toEqual({ type: "more_units", on: false, percentBp: 700, minUnits: 12 });

    expect(await run({ kind: "offerSwitch", type: "more_units", on: true })).toEqual({ ok: true });
    after = await draftOf();
    expect((after.offers as { type: string; on: boolean }[]).map((o) => [o.type, o.on])).toEqual([["decide_now", true], ["smaller_start", true], ["general", true], ["more_units", true], ["pay_yearly", false]]);

    expect(await run({ kind: "offerMove", type: "more_units", to: 0 })).toEqual({ ok: true });
    after = await draftOf();
    expect((after.offers as { type: string }[]).map((o) => o.type)).toEqual(["more_units", "decide_now", "smaller_start", "general", "pay_yearly"]);
    others(before, after, ["offers"]);

    // General is the discount without approval: switching it off sets the limit to 0, as the offers branch defined it.
    expect(await run({ kind: "offerSwitch", type: "general", on: false })).toEqual({ ok: true });
    after = await draftOf();
    expect(after.maxDiscountBp).toBe(0);
    others(before, after, ["offers", "maxDiscountBp"]);
    expect(await run({ kind: "offer", type: "general", pct: "6" })).toEqual({ ok: true });
    expect((await draftOf()).maxDiscountBp).toBe(0);
    expect(await run({ kind: "offerSwitch", type: "general", on: true })).toEqual({ ok: true });
    expect((await draftOf()).maxDiscountBp).toBe(600);

    // Refused at the row, nothing stored.
    const kept = await draftOf();
    expect(await run({ kind: "offer", type: "decide_now", pct: "75" })).toEqual({ ok: false, errors: { "offer.decide_now.pct": "Enter a percentage from 0 to 50." } });
    expect(await run({ kind: "offer", type: "more_units", pct: "5", units: "1" })).toMatchObject({ ok: false, errors: { "offer.more_units.units": "Enter a whole number of units from 2." } });
    expect(await run({ kind: "offerSwitch", type: "smaller_start", on: false })).toMatchObject({ ok: false });
    expect(await run({ kind: "offerMove", type: "pay_yearly", to: 0 })).toMatchObject({ ok: false });
    expect(await run({ kind: "offerMove", type: "general", to: 9 })).toMatchObject({ ok: false });
    expect(await run({ kind: "offerSwitch", type: "bogus", on: true })).toMatchObject({ ok: false });
    expect(await draftOf()).toEqual(kept);

    // Compare with live: the offers changes, in words, in their own Offers area; never JSON.
    const cmp = await loadVersionComparison(db, acc.id, { languages: ["en", "he"], platformDetails: false });
    const rows = cmp!.changes.filter((r) => r.area === "offers");
    expect(rows.length).toBeGreaterThan(0);
    expect(cmp!.changes.filter((r) => r.area === "other")).toEqual([]);
    for (const r of rows) {
      expect(r.item).toMatch(/^(A smaller first step|More units|Decide now|General discount|Pay yearly)$/);
      expect([...(r.before ?? []), ...(r.after ?? [])].map((x) => x.text).join("")).not.toMatch(/[{}[\]]/);
    }
    // Another account's playbook is untouched.
    expect((await draftOf(other.id)).offers).toBeUndefined();
  });

  it("a playbook without a stored list shows the one derived from its limit, and its first row change stores the list", async () => {
    await saveDraftPlaybook(db, other.id, { ...defaultPlaybook("Other", 500) });
    holder.access = { account: other, user: me, actingAs: false, role: "seller_admin" };
    const html = renderToStaticMarkup(await (PartPage as Page)({ params: Promise.resolve({ account: other.slug, part: "offers" }), searchParams: Promise.resolve({}) }));
    expect(order(html)).toEqual([["smaller_start", "1"], ["general", "1"], ["more_units", "0"], ["decide_now", "0"], ["pay_yearly", "0"]]);
    expect(text(html)).toContain("5% off at most");
    expect(await savePlaybookRowAction(other.slug, { kind: "offerSwitch", type: "decide_now", on: true })).toEqual({ ok: true });
    const pb = (await ensureDraftVersion(db, other.id)).playbook;
    expect(offersOf(pb).filter((o) => o.on).map((o) => o.type)).toEqual(["smaller_start", "general", "decide_now"]);
    expect(pb.maxDiscountBp).toBe(500);
  });
});
