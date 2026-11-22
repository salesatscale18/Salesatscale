import { describe, expect, it } from "vitest";
import {
  bearerKey, csvEscape, csvToRawLeads, formatPhone, generateIntakeKey, hashIntakeKey, maskPhone, mergeLeadFields, normalizePhone, parseCsv, parseLead,
  CONSENT_WORDING_DEFAULT, consentSourceImport, consentSourceIntake, consentSourceManual,
} from "@/lib/leads/rules";
import { displayName } from "@/lib/auth/display";

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

  it("never requires consent text (default wording), keeps it when sent, and validates email", () => {
    const r = parseLead(base, "IL", { language: "en", now });
    expect(r.ok && r.value.consent?.wording).toBe(CONSENT_WORDING_DEFAULT);
    const ok = parseLead({ ...base, consentWording: "I agree", email: "A@B.co" }, "IL", { language: "en", now });
    expect(ok.ok && ok.value).toMatchObject({ email: "a@b.co", consent: { wording: "I agree" } });
    expect(parseLead({ ...base, email: "nope" }, "IL", { language: "en", now }).ok).toBe(false);
  });

  it("consent by default (CSV box ticked, intake API): the automatic source, unless the input says no", () => {
    const opts = { language: "en" as const, now, consentByDefault: true, consentSource: consentSourceIntake("Main site") };
    const bare = parseLead({ fullName: "Rina", phone: "0525550193" }, "IL", opts);
    expect(bare.ok && bare.value).toMatchObject({
      consent: { source: 'Sent with intake key "Main site"', wording: CONSENT_WORDING_DEFAULT, capturedAt: now },
      consentDefaulted: true,
    });
    // A note that is sent is kept, and counts as given by the input (not the default).
    const noted = parseLead({ fullName: "Rina", phone: "0525550193", consentSource: "yoursite/contact" }, "IL", opts);
    expect(noted.ok && noted.value).toMatchObject({ consent: { source: "yoursite/contact" }, consentDefaulted: false });
    for (const no of ["no", "false", "0", false]) {
      const r = parseLead({ fullName: "Rina", phone: "0525550193", consent: no, consentSource: "x" }, "IL", opts);
      expect(r.ok && r.value.consent).toBeNull();
    }
    // Without consentByDefault nothing is assumed.
    expect(parseLead({ fullName: "Rina", phone: "0525550193" }, "IL", { language: "en", now, consentSource: "x" }).ok
      && parseLead({ fullName: "Rina", phone: "0525550193" }, "IL", { language: "en", now, consentSource: "x" })).toMatchObject({ value: { consent: null } });
  });

  it("names the three automatic sources, never a full email", () => {
    expect(consentSourceManual("Dana Levi")).toBe("Added by Dana Levi in the app");
    expect(consentSourceImport("expo-leads.csv")).toBe("Imported from expo-leads.csv");
    expect(consentSourceIntake("Main site")).toBe('Sent with intake key "Main site"');
    expect(consentSourceManual(displayName({ firstName: null, lastName: null, email: "dana+test@seller.example" }))).toBe("Added by dana in the app");
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
    // Consent columns are optional (owner, 22 Nov): no "how" column is required.
    expect(csvToRawLeads(parseCsv("name,phone")).missingColumns).toEqual(["language"]);
    expect(csvToRawLeads(parseCsv("full_name,phone,language\nA,1,he")).missingColumns).toEqual([]);
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
