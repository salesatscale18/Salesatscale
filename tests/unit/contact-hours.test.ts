import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTACT_HOURS, contactHoursOrDefault, isWithinContactHours, parseContactHours, summarizeContactHours, WEEKDAYS,
} from "@/lib/accounts/contact-hours";
import type { ContactHours } from "@/db/schema";

const TLV = "Asia/Jerusalem";
const at = (iso: string) => new Date(iso);

describe("isWithinContactHours", () => {
  it("uses the default Sun–Thu 08:30–20:00, Fri 08:30–13:00, Sat off", () => {
    // November: Israel is UTC+2.
    expect(isWithinContactHours(null, TLV, at("2026-11-15T06:29:00Z"))).toBe(false); // Sun 08:29
    expect(isWithinContactHours(null, TLV, at("2026-11-15T06:30:00Z"))).toBe(true); // Sun 08:30, start is inclusive
    expect(isWithinContactHours(null, TLV, at("2026-11-15T17:59:00Z"))).toBe(true); // Sun 19:59
    expect(isWithinContactHours(null, TLV, at("2026-11-15T18:00:00Z"))).toBe(false); // Sun 20:00, end is exclusive
    expect(isWithinContactHours(null, TLV, at("2026-11-20T10:59:00Z"))).toBe(true); // Fri 12:59
    expect(isWithinContactHours(null, TLV, at("2026-11-20T11:00:00Z"))).toBe(false); // Fri 13:00
    expect(isWithinContactHours(null, TLV, at("2026-11-21T10:00:00Z"))).toBe(false); // Sat
  });

  it("follows daylight saving time", () => {
    // July: Israel is UTC+3, so 08:30 local is 05:30Z.
    expect(isWithinContactHours(DEFAULT_CONTACT_HOURS, TLV, at("2026-07-05T05:29:00Z"))).toBe(false);
    expect(isWithinContactHours(DEFAULT_CONTACT_HOURS, TLV, at("2026-07-05T05:30:00Z"))).toBe(true);
  });

  it("reads the same instant differently in other time zones", () => {
    const instant = at("2026-11-15T13:30:00Z"); // 15:30 in Tel Aviv, 08:30 in New York, 21:30 in Singapore
    expect(isWithinContactHours(null, TLV, instant)).toBe(true);
    expect(isWithinContactHours(null, "America/New_York", instant)).toBe(true);
    expect(isWithinContactHours(null, "America/New_York", at("2026-11-15T13:29:00Z"))).toBe(false);
    expect(isWithinContactHours(null, "Asia/Singapore", instant)).toBe(false);
  });

  it("uses the local weekday, not the UTC one", () => {
    const nightOwl: ContactHours = WEEKDAYS.map((d) => ({ on: d === "sun", from: "00:00", to: "02:00" }));
    const instant = at("2026-11-14T23:00:00Z"); // Saturday in UTC, Sunday 01:00 in Tel Aviv
    expect(isWithinContactHours(nightOwl, TLV, instant)).toBe(true);
    expect(isWithinContactHours(nightOwl, "UTC", instant)).toBe(false);
  });

  it("treats days that are off as closed and falls back to defaults on malformed data", () => {
    const off: ContactHours = DEFAULT_CONTACT_HOURS.map((d) => ({ ...d, on: false }));
    expect(isWithinContactHours(off, TLV, at("2026-11-15T10:00:00Z"))).toBe(false);
    expect(contactHoursOrDefault([] as unknown as ContactHours)).toBe(DEFAULT_CONTACT_HOURS);
  });
});

describe("parseContactHours and summary", () => {
  const form = (h: ContactHours) =>
    Object.fromEntries(WEEKDAYS.flatMap((d, i) => [...(h[i].on ? [[`${d}_on`, "on"]] : []), [`${d}_from`, h[i].from], [`${d}_to`, h[i].to]]));

  it("round-trips the form fields", () => {
    expect(parseContactHours(form(DEFAULT_CONTACT_HOURS))).toEqual({ ok: true, value: DEFAULT_CONTACT_HOURS });
  });

  it("refuses bad times, end before start and no open days", () => {
    expect(parseContactHours({ ...form(DEFAULT_CONTACT_HOURS), sun_from: "8:30" }).ok).toBe(false);
    expect(parseContactHours({ ...form(DEFAULT_CONTACT_HOURS), sun_from: "21:00" }).ok).toBe(false);
    const raw = form(DEFAULT_CONTACT_HOURS);
    for (const d of WEEKDAYS) delete raw[`${d}_on`];
    expect(parseContactHours(raw)).toEqual({ ok: false, error: "Turn on at least one day." });
  });

  it("summarizes consecutive days with the same hours", () => {
    expect(summarizeContactHours(null)).toBe("Sun–Thu 08:30–20:00 · Fri 08:30–13:00 · Sat off");
  });
});
