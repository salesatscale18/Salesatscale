/**
 * The seller's offers list (Playbook › Limits): derivation from the discount
 * limit, the derived maxDiscountBp, server-side validation, the form rows, the
 * Compare rows (their own "Offers" area) and the one-row changes of the
 * Offers part (switch, move, numbers). The part's markup: tests/integration/offers-part.test.tsx.
 */
import { describe, expect, it } from "vitest";
import type { Playbook } from "@/db/schema";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm } from "@/lib/agent/playbook";
import {
  applyOfferChange, maxDiscountBpFromOffers, maxDiscountBpOf, moveOffer, offersOf, parseOfferRows, switchOffer, syncPlaybookOffers, withDiscountLimit,
  type PlaybookWithOffers, type StoredOffer,
} from "@/lib/agent/offer-settings";
import { diffVersions } from "@/lib/agent/version-diff";

const types = (l: readonly { type: string }[]) => l.map((o) => o.type);

describe("offers list: derived from the discount limit (no migration)", () => {
  it("an existing limit becomes the General discount, on; the other percent trades start off; a smaller first step is on", () => {
    const l = offersOf(defaultPlaybook("Acme", 500));
    expect(l).toEqual([
      { type: "smaller_start", on: true },
      { type: "general", on: true, percentBp: 500 },
      { type: "more_units", on: false, percentBp: 500, minUnits: 10 },
      { type: "decide_now", on: false, percentBp: 300 },
      { type: "pay_yearly", on: false, percentBp: 800 },
    ]);
    expect(maxDiscountBpFromOffers(l)).toBe(500);
  });

  it("a limit of 0 leaves General off; maxDiscountBp stays 0", () => {
    const l = offersOf(defaultPlaybook("Acme", 0));
    expect(l.find((o) => o.type === "general")).toEqual({ type: "general", on: false, percentBp: 0 });
    expect(maxDiscountBpOf({ maxDiscountBp: 0 })).toBe(0);
  });

  it("maxDiscountBp is General's percent when it is on, else 0", () => {
    const l: StoredOffer[] = [{ type: "smaller_start", on: true }, { type: "decide_now", on: true, percentBp: 900 }, { type: "general", on: false, percentBp: 700 }];
    expect(maxDiscountBpFromOffers(l)).toBe(0);
    expect(maxDiscountBpFromOffers(l.map((o) => (o.type === "general" ? { ...o, on: true } : o)))).toBe(700);
  });

  it("a write that only sets maxDiscountBp (older form, knowledge pipeline) moves the General row; the rest is kept", () => {
    const stored: PlaybookWithOffers = { ...defaultPlaybook("Acme", 500), offers: [
      { type: "decide_now", on: true, percentBp: 300 }, { type: "smaller_start", on: true }, { type: "general", on: true, percentBp: 500 },
      { type: "more_units", on: false, percentBp: 400, minUnits: 12 }, { type: "pay_yearly", on: false, percentBp: 800 },
    ] };
    const synced = syncPlaybookOffers({ ...stored, maxDiscountBp: 900 });
    expect(synced.offers!.find((o) => o.type === "general")).toEqual({ type: "general", on: true, percentBp: 900 });
    expect(types(synced.offers!)).toEqual(["decide_now", "smaller_start", "general", "more_units", "pay_yearly"]);
    expect(synced.offers!.find((o) => o.type === "more_units")).toEqual({ type: "more_units", on: false, percentBp: 400, minUnits: 12 });
    // 0 switches General off and keeps its percent.
    expect(withDiscountLimit(synced.offers!, 0).find((o) => o.type === "general")).toEqual({ type: "general", on: false, percentBp: 900 });
    // A playbook without a list is stored as it is.
    const plain = defaultPlaybook("Acme", 500);
    expect(syncPlaybookOffers(plain)).toBe(plain);
  });

  it("a stored list is read leniently: unknown and repeated types dropped, missing ones added off, off rows after active ones", () => {
    const l = offersOf({ maxDiscountBp: 0, offers: [{ type: "pay_yearly", on: false, percentBp: 800 }, { type: "nope" }, { type: "decide_now", on: true, percentBp: 99_999 }, { type: "decide_now", on: false }] });
    expect(l).toEqual([
      { type: "decide_now", on: true, percentBp: 300 },
      { type: "smaller_start", on: true },
      { type: "pay_yearly", on: false, percentBp: 800 },
      { type: "more_units", on: false, percentBp: 500, minUnits: 10 },
      { type: "general", on: false, percentBp: 0 },
    ]);
  });
});

describe("offers rows: server-side validation", () => {
  const row = (type: string, on: string, pct = "", units = "") => ({ type, on, pct, units });
  it("percents within 0-50, units of 2 or more, the pinned row present, no repeats", () => {
    const errors: Record<string, string> = {};
    parseOfferRows([row("smaller_start", "1"), row("general", "1", "60"), row("more_units", "0", "5", "1"), row("decide_now", "1", "-1")], errors);
    expect(errors).toEqual({
      "offer.general.pct": "Enter a percentage from 0 to 50.",
      "offer.more_units.units": "Enter a whole number of units from 2.",
      "offer.decide_now.pct": "Enter a percentage from 0 to 50.",
    });
    const missing: Record<string, string> = {};
    parseOfferRows([row("general", "1", "5")], missing);
    expect(missing.offers).toBe("A smaller first step is always in the list.");
    const twice: Record<string, string> = {};
    parseOfferRows([row("smaller_start", "1"), row("general", "1", "5"), row("general", "0", "5")], twice);
    expect(twice.offers).toBe("Each offer can appear once.");
    const unknown: Record<string, string> = {};
    parseOfferRows([row("smaller_start", "1"), row("free_lunch", "1", "5")], unknown);
    expect(unknown.offers).toBe("This offer is not one the agent can make.");
  });

  it("keeps the order sent (active first), adds missing types off, and a smaller first step is always on", () => {
    const errors: Record<string, string> = {};
    const l = parseOfferRows([row("decide_now", "1", "3"), row("pay_yearly", "0", "8"), row("smaller_start", "0"), row("general", "1", "4.5")], errors);
    expect(errors).toEqual({});
    expect(l).toEqual([
      { type: "decide_now", on: true, percentBp: 300 },
      { type: "smaller_start", on: true },
      { type: "general", on: true, percentBp: 450 },
      { type: "pay_yearly", on: false, percentBp: 800 },
      { type: "more_units", on: false, percentBp: 500, minUnits: 10 },
    ]);
  });
});

describe("the playbook form: offers rows replace the single limit", () => {
  const base: [string, string][] = [["agentName", "Maya"], ["goal", "Sell."], ["tone", ""], ["offerMeetingWhen", ""], ["handOffWhen", ""]];
  const offers: [string, string][] = [
    ["offerOrder", "decide_now,smaller_start,general,more_units,pay_yearly"],
    ["offer.decide_now.on", "1"], ["offer.decide_now.pct", "3"],
    ["offer.general.on", "1"], ["offer.general.pct", "6"],
    ["offer.more_units.on", "0"], ["offer.more_units.pct", "5"], ["offer.more_units.units", "10"],
    ["offer.pay_yearly.on", "0"], ["offer.pay_yearly.pct", "8"],
  ];

  it("parses the rows in the order sent; maxDiscountBp is General's percent", () => {
    const r = parsePlaybookRows(playbookRowsFromForm(base.concat(offers)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(types(r.value.offers!)).toEqual(["decide_now", "smaller_start", "general", "more_units", "pay_yearly"]);
    expect(r.value.maxDiscountBp).toBe(600);
  });

  it("General switched off: maxDiscountBp 0", () => {
    const off = offers.map(([k, v]): [string, string] => (k === "offer.general.on" ? [k, "0"] : [k, v]));
    const r = parsePlaybookRows(playbookRowsFromForm(base.concat(off)));
    expect(r.ok && r.value.maxDiscountBp).toBe(0);
  });

  it("a bad row is refused with its own error; without offers rows the older limit field still works", () => {
    const bad = offers.map(([k, v]): [string, string] => (k === "offer.general.pct" ? [k, "51"] : [k, v]));
    const r = parsePlaybookRows(playbookRowsFromForm(base.concat(bad)));
    expect(!r.ok && r.errors).toEqual({ "offer.general.pct": "Enter a percentage from 0 to 50." });
    const old = parsePlaybookRows(playbookRowsFromForm(base.concat([["maxDiscount", "7"]])));
    expect(old.ok && old.value.maxDiscountBp).toBe(700);
    expect(old.ok && "offers" in old.value).toBe(false);
  });
});

describe("Compare versions: offers in their own Offers area, in words", () => {
  const opts = { platformDetails: false, voiceModel: { before: "google/gemini-3.8-live", after: "google/gemini-3.8-live" } };
  const v = (playbook: Playbook) => ({ playbook, model: "m", effort: "medium", voiceSettings: null });
  const text = (segs: { text: string }[] | null) => (segs ?? []).map((s) => s.text).join("");

  it("a moved offer is one Moved row with its places; a switched one is a changed row", () => {
    const a: PlaybookWithOffers = { ...defaultPlaybook("Acme", 500), offers: [
      { type: "smaller_start", on: true }, { type: "more_units", on: true, percentBp: 500, minUnits: 10 }, { type: "decide_now", on: true, percentBp: 300 },
      { type: "general", on: true, percentBp: 500 }, { type: "pay_yearly", on: false, percentBp: 800 },
    ] };
    const b: PlaybookWithOffers = { ...a, offers: [
      { type: "smaller_start", on: true }, { type: "decide_now", on: true, percentBp: 300 }, { type: "more_units", on: true, percentBp: 500, minUnits: 10 },
      { type: "general", on: true, percentBp: 500 }, { type: "pay_yearly", on: true, percentBp: 800 },
    ] };
    const rows = diffVersions(v(a), v(b), opts);
    expect(rows.map((r) => [r.area, r.item, r.kind, text(r.before), text(r.after), r.positions ?? null])).toEqual([
      ["offers", "Pay yearly", "changed", "Off · 8% off at most", "On · 8% off at most", null],
      ["offers", "More units", "moved", "More units", "More units", { before: 2, after: 3 }],
    ]);
  });

  it("a playbook without a list compares as its derived list (no change when only the storage differs)", () => {
    const a = defaultPlaybook("Acme", 500);
    const b: PlaybookWithOffers = { ...a, offers: offersOf(a) };
    expect(diffVersions(v(a), v(b), opts)).toEqual([]);
  });
});

describe("Offers part: one row at a time", () => {
  const list = offersOf(defaultPlaybook("Acme", 500));

  it("switching on puts the row last among the active ones; off puts it first among the rows that are off; a smaller first step stays on", () => {
    const on = switchOffer(list, "decide_now", true);
    expect(on.map((r) => [r.type, r.on])).toEqual([["smaller_start", true], ["general", true], ["decide_now", true], ["more_units", false], ["pay_yearly", false]]);
    const off = switchOffer(on, "general", false);
    expect(off.map((r) => [r.type, r.on])).toEqual([["smaller_start", true], ["decide_now", true], ["general", false], ["more_units", false], ["pay_yearly", false]]);
    expect(switchOffer(list, "smaller_start", false)).toEqual(list);
    // The limit without approval follows General (the never-do "Covered by Limits" check and publish read it).
    expect(maxDiscountBpFromOffers(list)).toBe(500);
    expect(maxDiscountBpFromOffers(off)).toBe(0);
  });

  it("a move changes the place among the active rows only; off rows never move", () => {
    const allOn = list.map((r) => ({ ...r, on: true }));
    expect(types(moveOffer(allOn, "general", 0))).toEqual(["general", "smaller_start", "more_units", "decide_now", "pay_yearly"]);
    expect(types(moveOffer(allOn, "smaller_start", 4))).toEqual(["general", "more_units", "decide_now", "pay_yearly", "smaller_start"]);
    expect(moveOffer(list, "more_units", 0)).toEqual(list);
  });

  it("applyOfferChange: the whole list as rows for the validator; out-of-date or impossible changes refused", () => {
    const r = applyOfferChange(list, { kind: "offer", type: "more_units", pct: "7", units: "12" });
    expect(r.ok && r.rows.find((x) => x.type === "more_units")).toEqual({ type: "more_units", on: "0", pct: "7", units: "12" });
    expect(r.ok && types(r.rows)).toEqual(types(list));
    const parsed = r.ok ? parseOfferRows(r.rows, {}) : [];
    expect(parsed.find((o) => o.type === "more_units")).toEqual({ type: "more_units", on: false, percentBp: 700, minUnits: 12 });
    // A bad percent goes to the validator (its message at offer.<type>.pct).
    const bad = applyOfferChange(list, { kind: "offer", type: "general", pct: "75" });
    const errors: Record<string, string> = {};
    if (bad.ok) parseOfferRows(bad.rows, errors);
    expect(errors).toEqual({ "offer.general.pct": "Enter a percentage from 0 to 50." });
    expect(applyOfferChange(list, { kind: "offerSwitch", type: "smaller_start", on: false })).toEqual({ ok: false, errors: { offers: "A smaller first step is always in the list." } });
    expect(applyOfferChange(list, { kind: "offer", type: "smaller_start", pct: "5" }).ok).toBe(false);
    expect(applyOfferChange(list, { kind: "offerMove", type: "pay_yearly", to: 0 }).ok).toBe(false);
    expect(applyOfferChange(list, { kind: "offerMove", type: "general", to: 2 }).ok).toBe(false);
    const moved = applyOfferChange(list, { kind: "offerMove", type: "general", to: 0 });
    expect(moved.ok && types(moved.rows)).toEqual(["general", "smaller_start", "more_units", "decide_now", "pay_yearly"]);
  });
});
