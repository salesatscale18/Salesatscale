import { describe, expect, it } from "vitest";
import {
  bearerKey, csvEscape, csvToRawLeads, formatPhone, generateIntakeKey, hashIntakeKey, maskPhone, mergeLeadFields, normalizePhone, parseCsv, parseLead,
} from "@/lib/leads/rules";

describe("normalizePhone", () => {
  it.each([
    ["+972 52-555-0193", "IL", "+972525550193"],
    ["00972525550193", "IL", "+972525550193"],
    ["052-555-0193", "IL", "+972525550193"],
    ["(415) 555-0100", "US", "+14155550100"],
    ["07700 900123", "GB", "+447700900123"],
    ["+44 7700 900123", "IL", "+447700900123"],
  ])("%s (%s) → %s", (raw, market, out) => expect(normalizePhone(raw, market)).toBe(out));

  it.each([["", "IL"], ["abc", "IL"], ["123", "IL"], ["+12+34", "IL"], ["052-555-0193", "ZZ"], ["+0123456789", "IL"]])(
    "rejects %s (%s)",
    (raw, market) => expect(normalizePhone(raw, market)).toBeNull(),
  );
});

describe("maskPhone", () => {
  it("keeps the country code and last four digits", () => {
    expect(maskPhone("+972525550193")).toBe("+972 52-***-0193");
    expect(maskPhone("+14155550100")).toBe("+1 41-***-0100");
  });
});

describe("formatPhone", () => {
  it("formats Israeli mobiles and landlines for reading", () => {
    expect(formatPhone("+972501112233")).toBe("+972 50-111-2233");
    expect(formatPhone("+97221234567")).toBe("+972 2-123-4567");
  });
  it("formats NANP and UK numbers", () => {
    expect(formatPhone("+14155550123")).toBe("+1 415-555-0123");
    expect(formatPhone("+447700900123")).toBe("+44 7700 900123");
  });
  it("groups other known calling codes in threes, without a lone last digit", () => {
    expect(formatPhone("+971501234567")).toBe("+971 501 234 567");
    expect(formatPhone("+4930123456")).toBe("+49 301 234 56");
    expect(formatPhone("+33612345678")).toBe("+33 612 345 678");
    expect(formatPhone("+31612345678")).toBe("+31 612 345 678");
    expect(formatPhone("+341234567890")).toBe("+34 123 456 7890");
  });
  it("returns anything else unchanged", () => {
    expect(formatPhone("+8613812345678")).toBe("+8613812345678");
    expect(formatPhone("0501112233")).toBe("0501112233");
    expect(formatPhone("")).toBe("");
    expect(formatPhone("+97250-111")).toBe("+97250-111");
  });
  it("always keeps every digit", () => {
    for (const n of ["+972501112233", "+14155550123", "+447700900123", "+4930123456", "+61412345678"]) expect(formatPhone(n).replace(/[^\d+]/g, "")).toBe(n);
  });
});

describe("parseLead", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const base = { fullName: "Shira Golan", phone: "052-555-0193", consent: "yes", consentSource: "Contact sheet at HoReCa Expo" };

  it("accepts a lead with consent and fills defaults", () => {
    const r = parseLead(base, "IL", { language: "he", now });
    expect(r.ok && r.value).toMatchObject({ phone: "+972525550193", language: "he", consent: { source: "Contact sheet at HoReCa Expo", capturedAt: now } });
  });

  it("returns no consent without a yes or a consent source, and an explicit no wins", () => {
    for (const consent of ["", "no", "false", undefined]) {
      const r = parseLead({ ...base, consent, consentSource: "" }, "IL", { language: "en", now });
      expect(r.ok && r.value.consent).toBeNull();
    }
    const no = parseLead({ ...base, consent: "no" }, "IL", { language: "en", now });
    expect(no.ok && no.value.consent).toBeNull();
    const bySource = parseLead({ ...base, consent: undefined }, "IL", { language: "en", now });
    expect(bySource.ok && bySource.value.consent?.source).toBe("Contact sheet at HoReCa Expo");
  });

  it("requires consent text for CSV and API, and validates email", () => {
    const r = parseLead(base, "IL", { language: "en", now, requireConsentText: true });
    expect(!r.ok && r.errors.consentText).toMatch(/consent_text/);
    const ok = parseLead({ ...base, consentWording: "I agree", email: "A@B.co" }, "IL", { language: "en", now, requireConsentText: true });
    expect(ok.ok && ok.value).toMatchObject({ email: "a@b.co", consent: { wording: "I agree" } });
    expect(parseLead({ ...base, email: "nope" }, "IL", { language: "en", now }).ok).toBe(false);
  });

  it("requires a description of how the person agreed", () => {
    const r = parseLead({ ...base, consentSource: " " }, "IL", { language: "en", now });
    expect(!r.ok && r.errors.consentSource).toBeTruthy();
  });

  it("rejects future consent dates, bad names, phones and languages", () => {
    const r = parseLead({ ...base, fullName: "", phone: "12", language: "fr", consentCapturedAt: "2030-01-01" }, "IL", { language: "en", now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["consentSource", "fullName", "language", "phone"]);
  });

  it("understands language names in English and Hebrew", () => {
    expect(parseLead({ ...base, language: "Hebrew" }, "IL", { language: "en", now }).ok).toBe(true);
    const r = parseLead({ ...base, language: "עברית" }, "IL", { language: "en", now });
    expect(r.ok && r.value.language).toBe("he");
  });
});

describe("CSV", () => {
  it("parses quotes, escaped quotes, CRLF, BOM and skips blank lines", () => {
    const rows = parseCsv('﻿name,company\r\n"Cohen, Rina","Rina""s Kitchen"\r\n\r\nOmer,\n');
    expect(rows).toEqual([["name", "company"], ["Cohen, Rina", 'Rina"s Kitchen'], ["Omer", ""]]);
  });

  it("maps header aliases and reports missing and unknown columns", () => {
    const r = csvToRawLeads(parseCsv("Full Name,WhatsApp,Language,How they agreed,consent_text,Colour\nA,1,he,form,I agree,red"));
    expect(r.missingColumns).toEqual([]);
    expect(r.unknownColumns).toEqual(["colour"]);
    expect(r.rows[0]).toEqual({ line: 2, raw: { fullName: "A", phone: "1", language: "he", consentSource: "form", consentWording: "I agree" } });
    expect(csvToRawLeads(parseCsv("name,phone")).missingColumns).toEqual(["language", "consent_source", "consent_text"]);
  });

  it("fills whole-file consent only into rows without their own", () => {
    const r = csvToRawLeads(parseCsv("full_name,phone,language,consent_source\nA,1,he,\nB,2,he,own"), { source: "Expo", wording: "W" });
    expect(r.rows[0].raw).toMatchObject({ consentSource: "Expo", consentWording: "W" });
    expect(r.rows[1].raw).toMatchObject({ consentSource: "own" });
    expect(r.rows[1].raw.consentWording).toBeUndefined();
  });
});

describe("intake keys", () => {
  it("stores only a hash and a short prefix", () => {
    const k = generateIntakeKey();
    expect(k.key.startsWith("sas_lead_")).toBe(true);
    expect(k.keyHash).toBe(hashIntakeKey(k.key));
    expect(k.key.startsWith(k.keyPrefix)).toBe(true);
    expect(k.keyPrefix.length).toBeLessThan(20);
  });

  it("reads Bearer or x-api-key", () => {
    expect(bearerKey("Bearer abc", null)).toBe("abc");
    expect(bearerKey(null, " xyz ")).toBe("xyz");
    expect(bearerKey("Basic abc", null)).toBeNull();
  });
});

describe("csvEscape (rejected-rows download, L8)", () => {
  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ["+972 52 555 0193", "'+972 52 555 0193"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", `"'\rcmd"`],
    ["Shira Golan", "Shira Golan"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
  ])("%j → %j", (input, out) => expect(csvEscape(input)).toBe(out));

  it("leaves numbers alone", () => {
    expect(csvEscape(12)).toBe("12");
  });
});

describe("mergeLeadFields (security M2)", () => {
  const existing = { fullName: "Noa Buyer", company: null, email: "noa@buyer.example", language: "he", sourceLabel: "Expo" };
  const incoming = { fullName: "Mallory", company: "Evil Co", email: "m@evil.example", language: "en" as const, sourceLabel: null };

  it("intake fills empty fields only and proposes the rest", () => {
    for (const origin of ["webhook", "csv"] as const) {
      expect(mergeLeadFields(existing, incoming, origin)).toEqual({
        fields: { fullName: "Noa Buyer", company: "Evil Co", email: "noa@buyer.example", language: "he", sourceLabel: "Expo" },
        proposed: { fullName: "Mallory", email: "m@evil.example", language: "en" },
      });
    }
  });

  it("proposes nothing when intake sends the same or empty values", () => {
    expect(mergeLeadFields(existing, { ...incoming, fullName: "Noa Buyer", email: null, company: null, language: "he" }, "webhook").proposed).toEqual({});
  });

  it("a manual edit replaces name and language and any email or company it sends", () => {
    expect(mergeLeadFields(existing, { ...incoming, email: null }, "manual")).toEqual({
      fields: { fullName: "Mallory", company: "Evil Co", email: "noa@buyer.example", language: "en", sourceLabel: "Expo" },
      proposed: {},
    });
  });
});
