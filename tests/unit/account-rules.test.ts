import { describe, expect, it } from "vitest";
import {
  generateInviteToken, hashInviteToken, inviteEmailMatches, inviteState, parseCreateAccount,
  parseMajorToMinor, slugify, statusAfterResume,
} from "@/lib/accounts/rules";

const valid = {
  tradeName: "Polar Monitoring",
  market: "il",
  languages: ["en", "he"],
  timezone: "Asia/Jerusalem",
  currency: "ils",
  plan: "pilot",
  monthlySpendCap: "1,500",
  ownerName: "Danny Levi",
  ownerEmail: " Danny@Example.com ",
};

describe("parseCreateAccount", () => {
  it("accepts the required fields and applies defaults", () => {
    const r = parseCreateAccount(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      market: "IL",
      currency: "ILS",
      languages: ["en", "he"],
      monthlySpendCapMinor: 150_000,
      dailyConversationLimit: 200,
      retentionMonths: 24,
      ownerEmail: "danny@example.com",
      legalName: null,
    });
  });

  it("reports every missing required field", () => {
    const r = parseCreateAccount({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(
      ["currency", "languages", "market", "ownerEmail", "ownerName", "plan", "timezone", "tradeName"].sort(),
    );
  });

  it.each([
    [{ languages: ["en", "fr"] }, "languages"],
    [{ languages: [] }, "languages"],
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [{ monthlySpendCap: "0" }, "monthlySpendCapMinor"],
    [{ monthlySpendCap: "12.345" }, "monthlySpendCapMinor"],
    [{ dailyConversationLimit: "-3" }, "dailyConversationLimit"],
    [{ retentionMonths: "500" }, "retentionMonths"],
    [{ ownerEmail: "not-an-email" }, "ownerEmail"],
    [{ plan: "enterprise" }, "plan"],
  ])("rejects %o", (patch, field) => {
    const r = parseCreateAccount({ ...valid, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveProperty(field);
  });
});

describe("parseMajorToMinor", () => {
  it.each([
    ["1,500", "ILS", 150_000],
    ["1500.5", "USD", 150_050],
    ["1500", "JPY", 1500],
    ["abc", "ILS", null],
    ["1.5", "JPY", null],
  ] as const)("%s %s → %s", (v, c, expected) => {
    expect(parseMajorToMinor(v, c)).toBe(expected);
  });
});

describe("slugify", () => {
  it.each([
    ["Polar Monitoring", "polar-monitoring"],
    ["  Café & Co. Ltd ", "cafe-co-ltd"],
    ["מקררים בע״מ", "account"],
    ["---", "account"],
  ])("%s → %s", (name, slug) => expect(slugify(name)).toBe(slug));
});

describe("invites", () => {
  it("stores only a hash of a high-entropy token", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.tokenHash).toBe(hashInviteToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
  });

  const now = new Date("2026-11-12T10:00:00Z");
  const base = { acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-11-19T10:00:00Z") };
  it("derives state: accepted > revoked > expired > valid", () => {
    expect(inviteState(base, now)).toBe("valid");
    expect(inviteState({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(inviteState({ ...base, revokedAt: now }, now)).toBe("revoked");
    expect(inviteState({ ...base, revokedAt: now, acceptedAt: now }, now)).toBe("accepted");
  });

  it("matches email case-insensitively against verified addresses only", () => {
    expect(inviteEmailMatches("danny@example.com", ["Danny@Example.com"])).toBe(true);
    expect(inviteEmailMatches("danny@example.com", ["other@example.com"])).toBe(false);
    expect(inviteEmailMatches("danny@example.com", [])).toBe(false);
  });
});

describe("statusAfterResume", () => {
  it("returns to Live only if the account went live before", () => {
    expect(statusAfterResume({ wentLiveAt: new Date() })).toBe("live");
    expect(statusAfterResume({ wentLiveAt: null })).toBe("setting_up");
  });
});
