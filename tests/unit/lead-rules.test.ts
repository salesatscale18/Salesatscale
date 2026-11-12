import { describe, expect, it } from "vitest";
import {
  bearerKey, csvToRawLeads, generateIntakeKey, hashIntakeKey, maskPhone, normalizePhone, parseCsv, parseLead,
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

describe("parseLead", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const base = { fullName: "Shira Golan", phone: "052-555-0193", consent: "yes", consentSource: "Contact sheet at HoReCa Expo" };

  it("accepts a lead with consent and fills defaults", () => {
    const r = parseLead(base, "IL", { language: "he", now });
    expect(r.ok && r.value).toMatchObject({ phone: "+972525550193", language: "he", consent: { source: "Contact sheet at HoReCa Expo", capturedAt: now } });
  });

  it("returns no consent when consent is not an explicit yes", () => {
    for (const consent of ["", "no", "false", undefined]) {
      const r = parseLead({ ...base, consent }, "IL", { language: "en", now });
      expect(r.ok && r.value.consent).toBeNull();
    }
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
    const r = csvToRawLeads(parseCsv("Full Name,WhatsApp,Consent,How they agreed,Colour\nA,1,yes,form,red"));
    expect(r.missingColumns).toEqual([]);
    expect(r.unknownColumns).toEqual(["colour"]);
    expect(r.rows[0]).toEqual({ line: 2, raw: { fullName: "A", phone: "1", consent: "yes", consentSource: "form" } });
    expect(csvToRawLeads(parseCsv("name,phone")).missingColumns).toEqual(["consent", "consent_source"]);
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
