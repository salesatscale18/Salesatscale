/**
 * Lead pages phase 1 (slice a-1), pure parts: tokens, the origin matcher, the
 * submission rules (honeypot, timing, validation, ad details and source key),
 * the consent default and line, the hand-over variant, the SMS country rule,
 * the page_link SMS kind and the banner sniffing. No database, no network.
 */
import { describe, expect, it } from "vitest";
import {
  allowedOrigins, checkOrigin, normalizeAddress, normalizeOriginHost, requestOrigin, shouldRecordRefusedOrigin,
} from "@/lib/lead-pages/origin";
import {
  bannerBlobPath, checkBanner, consentTickedOf, defaultConsentTicked, firstNameOf, handoverVariant, initialsOf, parseLeadPageInput,
  phoneInSellingMarkets, readSubmission, sanitizeAd, sellingPrefixes, sniffImage, sourceKeyOf, trackingOf, validateSubmission, withoutQuery,
  BANNER_MAX_BYTES, goLiveBlockers,
} from "@/lib/lead-pages/rules";
import {
  checkFormTiming, cookieHoldsLead, FORM_MIN_AGE_MS, formTimingToken, generatePublicKey, handoverExpired, handoverTokenFor, HANDOVER_TTL_MS,
  leadCookieFrom, leadCookieHeader, leadCookieValue, previewTokenFor, previewTokenValid, PUBLIC_KEY_RE, submissionIdFromHandoverToken,
} from "@/lib/lead-pages/tokens";
import { chatTokenFor, linkIdFromChatToken } from "@/lib/simulator/token";
import { SMS_COMMERCIAL_KINDS, SMS_KIND_TIMING, SMS_SPACING_EXEMPT, smsRefusal, smsSegments } from "@/lib/sms/rules";
import { smsText } from "@/lib/sms/texts";
import { leadPageConsentLine, leadPageConsentParts } from "@/lib/leads/consent-line";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER = "0f1e2d3c-4b5a-4968-8776-655443322111";
const NOW = new Date("2026-11-25T10:00:00Z");

describe("lead page tokens", () => {
  it("hand-over token: holds only the submission id, signed under its own domain", () => {
    const t = handoverTokenFor(ID);
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(submissionIdFromHandoverToken(t)).toBe(ID);
    // Tampered, or another kind of token with the same shape: refused.
    expect(submissionIdFromHandoverToken(`${t.slice(0, -2)}AA`)).toBeNull();
    expect(submissionIdFromHandoverToken(chatTokenFor(ID))).toBeNull();
    expect(linkIdFromChatToken(t)).toBeNull();
    expect(submissionIdFromHandoverToken(leadCookieValue(ID))).toBeNull();
    expect(submissionIdFromHandoverToken("garbage")).toBeNull();
  });

  it("hand-over expires 30 minutes after the submission", () => {
    const at = new Date(NOW.getTime() - HANDOVER_TTL_MS);
    expect(handoverExpired(at, NOW)).toBe(false);
    expect(handoverExpired(new Date(at.getTime() - 1), NOW)).toBe(true);
  });

  it("form timing: too fast, fine, too old, forged, for another page", () => {
    const t = formTimingToken(ID, NOW.getTime());
    expect(checkFormTiming(t, ID, new Date(NOW.getTime() + 1000))).toBe("too_fast");
    expect(checkFormTiming(t, ID, new Date(NOW.getTime() + FORM_MIN_AGE_MS))).toBe("ok");
    expect(checkFormTiming(t, ID, new Date(NOW.getTime() + 25 * 3600_000))).toBe("too_old");
    expect(checkFormTiming(t, OTHER, new Date(NOW.getTime() + 5000))).toBe("invalid");
    expect(checkFormTiming(t.replace(/^[0-9a-z]+/, (m) => (parseInt(m, 36) - 10_000).toString(36)), ID, new Date(NOW.getTime() + 5000))).toBe("invalid");
    expect(checkFormTiming(undefined, ID, NOW)).toBe("missing");
    expect(checkFormTiming("x.y", ID, NOW)).toBe("invalid");
  });

  it("preview token: 24 hours, one page only", () => {
    const t = previewTokenFor(ID, NOW);
    expect(previewTokenValid(t, ID, new Date(NOW.getTime() + 23 * 3600_000))).toBe(true);
    expect(previewTokenValid(t, ID, new Date(NOW.getTime() + 25 * 3600_000))).toBe(false);
    expect(previewTokenValid(t, OTHER, NOW)).toBe(false);
    expect(previewTokenValid("", ID, NOW)).toBe(false);
  });

  it("the sas_lp cookie names one lead; HttpOnly, SameSite=Lax, 30 days", () => {
    const header = leadCookieHeader(ID);
    expect(header).toMatch(/^sas_lp=[A-Za-z0-9_.-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const value = leadCookieFrom(`a=1; ${header.split(";")[0]}; b=2`);
    expect(cookieHoldsLead(value, ID)).toBe(true);
    expect(cookieHoldsLead(value, OTHER)).toBe(false);
    expect(cookieHoldsLead(handoverTokenFor(ID), ID)).toBe(false);
    expect(cookieHoldsLead(null, ID)).toBe(false);
  });

  it("public keys: 12 base62 characters, random", () => {
    const keys = new Set(Array.from({ length: 200 }, generatePublicKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(PUBLIC_KEY_RE);
  });
});

describe("lead page origins", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const APP = "https://app.example.com";

  it("normalises the address the seller typed", () => {
    expect(normalizeAddress("acme.com/offer/")).toBe("https://acme.com/offer");
    expect(normalizeAddress("https://WWW.Acme.com/Offer?x=1#y")).toBe("https://www.acme.com/Offer");
    expect(normalizeAddress("http://acme.com:8080")).toBe("http://acme.com:8080");
    expect(normalizeAddress("ftp://acme.com")).toBeNull();
    expect(normalizeAddress("https://user:pw@acme.com")).toBeNull();
    expect(normalizeAddress("not a url")).toBeNull();
    expect(normalizeAddress("localhost")).toBeNull();
    expect(normalizeOriginHost("https://Staging.Acme.com/path")).toBe("staging.acme.com");
    expect(normalizeOriginHost("bücher.de")).toBe("xn--bcher-kva.de");
  });

  it("allows the address, its www twin, extra hosts and our own origin; nothing else", () => {
    const page = { address: "https://acme.com/offer", extraOrigins: ["acme.webflow.io"] };
    const allowed = allowedOrigins(page, APP);
    expect([...allowed].sort()).toEqual(["https://acme.com", "https://acme.webflow.io", "https://app.example.com", "https://www.acme.com"]);
    expect(checkOrigin(page, h({ origin: "https://www.acme.com" }), APP)).toEqual({ ok: true, origin: "https://www.acme.com" });
    // No wildcard subdomains, no other scheme, no other port.
    expect(checkOrigin(page, h({ origin: "https://shop.acme.com" }), APP).ok).toBe(false);
    expect(checkOrigin(page, h({ origin: "http://acme.com" }), APP).ok).toBe(false);
    expect(checkOrigin(page, h({ origin: "https://acme.com:8443" }), APP).ok).toBe(false);
    expect(checkOrigin(page, h({ origin: "https://acme.com.evil.io" }), APP).ok).toBe(false);
    // http only when the address is http; ports must match.
    const httpPage = { address: "http://acme.com:8080/x", extraOrigins: ["staging.acme.com"] };
    expect(checkOrigin(httpPage, h({ origin: "http://acme.com:8080" }), APP).ok).toBe(true);
    expect(checkOrigin(httpPage, h({ origin: "http://staging.acme.com" }), APP).ok).toBe(true);
    expect(checkOrigin(httpPage, h({ origin: "http://acme.com" }), APP).ok).toBe(false);
    // Punycode hosts compare as the browser sends them.
    expect(checkOrigin({ address: normalizeAddress("bücher.de"), extraOrigins: [] }, h({ origin: "https://xn--bcher-kva.de" }), APP).ok).toBe(true);
    // A button/link page without an address: only our hosted form.
    expect(checkOrigin({ address: null, extraOrigins: [] }, h({ origin: APP }), APP).ok).toBe(true);
    expect(checkOrigin({ address: null, extraOrigins: [] }, h({ origin: "https://acme.com" }), APP).ok).toBe(false);
  });

  it("falls back to the Referer; refuses a request with neither (curl, a server)", () => {
    expect(requestOrigin(h({ referer: "https://acme.com/offer?utm_source=x" }))).toBe("https://acme.com");
    expect(requestOrigin(h({ origin: "null", referer: "https://acme.com/a" }))).toBe("https://acme.com");
    expect(requestOrigin(h({}))).toBeNull();
    expect(checkOrigin({ address: "https://acme.com", extraOrigins: [] }, h({}), APP)).toEqual({ ok: false, origin: null });
  });

  it("records a refused origin at most every 10 minutes", () => {
    expect(shouldRecordRefusedOrigin({}, "https://x.io", NOW)).toBe(true);
    const at = { refusedOrigin: "https://x.io", refusedAt: NOW.toISOString() };
    expect(shouldRecordRefusedOrigin(at, "https://x.io", new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(shouldRecordRefusedOrigin(at, "https://y.io", new Date(NOW.getTime() + 60_000))).toBe(true);
    expect(shouldRecordRefusedOrigin(at, "https://x.io", new Date(NOW.getTime() + 600_000))).toBe(true);
  });
});

describe("lead page submissions", () => {
  const all = { company: true, email: true };

  it("reads the usual aliases, the consent box and the honeypot", () => {
    const f = readSubmission({ full_name: "Rina Mizrahi", tel: "054-555-0142", business: "Cafe", consent: "on", sas_url: "", utm_source: "Facebook", gclid: "abc" });
    expect(f).toMatchObject({ name: "Rina Mizrahi", phone: "054-555-0142", company: "Cafe", consent: true, honeypot: false });
    expect(f.ad).toEqual({ utm_source: "Facebook", gclid: "abc" });
    expect(readSubmission({ name: "x", sas_url: "http://spam" }).honeypot).toBe(true);
    expect(readSubmission({ name: "x" }).consent).toBe(false);
    expect(readSubmission({ name: "x", consent: true }).consent).toBe(true);
  });

  it("validates the name and phone; optional fields never block", () => {
    const ok = validateSubmission(readSubmission({ name: "  Rina   Mizrahi ", phone: "054-555-0142", company: "x".repeat(200), email: "bad", sites: "12" }), "IL", all);
    // A posted `sites` (an older form) is ignored.
    expect(ok).toEqual({ ok: true, value: { fullName: "Rina Mizrahi", phone: "+972545550142", company: "x".repeat(120), email: null } });
    expect(validateSubmission(readSubmission({ name: "R", phone: "054-555-0142" }), "IL", all)).toEqual({ ok: false, errors: ["name"] });
    expect(validateSubmission(readSubmission({ name: "Visit https://spam.io", phone: "054-555-0142" }), "IL", all)).toEqual({ ok: false, errors: ["name"] });
    expect(validateSubmission(readSubmission({ name: "Rina", phone: "12" }), "IL", all)).toEqual({ ok: false, errors: ["phone"] });
    // The fictional demo range is never a buyer.
    expect(validateSubmission(readSubmission({ name: "Rina", phone: "+972505550142" }), "IL", all)).toEqual({ ok: false, errors: ["phone"] });
    // Fields the page does not ask for are dropped.
    const off = validateSubmission(readSubmission({ name: "Rina", phone: "+44 7700 900123", company: "Cafe", email: "r@cafe.example" }), "IL", { company: false, email: false });
    expect(off).toEqual({ ok: true, value: { fullName: "Rina", phone: "+447700900123", company: null, email: null } });
    expect(firstNameOf("  Rina   Mizrahi")).toBe("Rina");
  });

  it("ad details are capped; the source key is lowercase source / campaign", () => {
    const ad = sanitizeAd({ utm_source: "Facebook", utm_campaign: "Spring Sale", utm_term: "x".repeat(500), fbclid: "abc.DEF-1", gclid: "<script>", referrer: "https://www.google.com/search?q=1" });
    expect(ad).toEqual({ utm: { source: "Facebook", campaign: "Spring Sale", term: "x".repeat(200) }, clickIds: { fbclid: "abc.DEF-1" }, referrerHost: "www.google.com" });
    expect(sourceKeyOf(ad)).toBe("facebook / spring sale");
    expect(sourceKeyOf(sanitizeAd({ gclid: "abc" }))).toBe("google");
    expect(sourceKeyOf(sanitizeAd({ referrer: "www.linkedin.com" }))).toBe("linkedin.com");
    expect(sourceKeyOf(sanitizeAd({ utm_source: "a".repeat(100) }))).toHaveLength(80);
    expect(sanitizeAd({})).toBeNull();
    expect(sourceKeyOf(null)).toBe("");
    expect(withoutQuery("https://acme.com/offer?utm_source=x#top")).toBe("https://acme.com/offer");
  });

  it("consent box default: ticked for Israel only, unticked for the EU, the UK and others", () => {
    expect(defaultConsentTicked(["IL"])).toBe(true);
    expect(defaultConsentTicked(["GB"])).toBe(false);
    expect(defaultConsentTicked(["DE", "FR"])).toBe(false);
    expect(defaultConsentTicked(["IL", "GB"])).toBe(false);
    expect(defaultConsentTicked([])).toBe(false);
    expect(consentTickedOf({ consentTicked: false }, ["IL"])).toBe(false);
    expect(consentTickedOf({}, ["IL"])).toBe(true);
    expect(trackingOf({})).toEqual({ tellPagePixel: true, carryAdDetails: true });
    expect(trackingOf({ carryAdDetails: false })).toEqual({ tellPagePixel: true, carryAdDetails: false });
  });

  it("the consent line names the seller and the automated assistant", () => {
    expect(leadPageConsentLine("en", "Polar Demo", "Maya")).toBe("By sending, you agree that Polar Demo and its automated assistant Maya may contact you about your request by SMS, WhatsApp, email or a call in the chat. You can stop anytime.");
    expect(leadPageConsentLine("he", "פולאר", "מאיה")).toContain("פולאר והעוזר האוטומטי מאיה");
    // A $ in a name is not a replacement pattern.
    expect(leadPageConsentLine("en", "A$&B", "M")).toContain("that A$&B and");
  });

  it("the consent line in parts (for display, names at odd indexes) joins back to the exact stored sentence", () => {
    const seller = "Polar Demo 2026-11-18 19:16:31";
    for (const lang of ["en", "he"] as const) {
      for (const [s, a] of [[seller, "Maya"], ["פולאר", "מאיה"], ["A$&B {agent}", "<b>M</b>"]]) {
        const parts = leadPageConsentParts(lang, s, a);
        expect(parts.join("")).toBe(leadPageConsentLine(lang, s, a));
        expect(parts.filter((_, i) => i % 2)).toEqual([s, a]);
      }
    }
    // The stored Hebrew wording with a Latin and digits trade name: the plain sentence, no isolate or mark characters.
    const line = leadPageConsentLine("he", seller, "Maya");
    expect(line).toBe(`בשליחה, את/ה מסכים/ה ש-${seller} והעוזר האוטומטי Maya ייצרו איתך קשר בנוגע לפנייה ב-SMS, וואטסאפ, מייל או שיחה בצ'אט. אפשר להפסיק בכל עת.`);
    expect(line).not.toMatch(/[‪-‮⁦-⁩‎‏؜<>]/);
  });
});

describe("hand-over variant (returning-buyer rule)", () => {
  const base = { consent: true, optedOut: false, inBrowser: true, chatReady: true, sms: null } as const;
  it("opens the chat only in the browser that created the lead (or holds its cookie)", () => {
    expect(handoverVariant(base)).toBe("chat");
    expect(handoverVariant({ ...base, chatReady: false })).toBe("received");
    // Someone typed an existing lead's phone: never that lead's chat here; the SMS carries the link.
    expect(handoverVariant({ ...base, inBrowser: false, sms: "sent" })).toBe("welcome_back");
    expect(handoverVariant({ ...base, inBrowser: false, sms: "mocked" })).toBe("received");
    expect(handoverVariant({ ...base, inBrowser: false, sms: null })).toBe("received");
    expect(handoverVariant({ ...base, consent: false })).toBe("received");
    expect(handoverVariant({ ...base, optedOut: true, sms: "sent" })).toBe("received");
  });
});

describe("page_link SMS", () => {
  it("only to numbers of the account's selling markets", () => {
    const prefixes = sellingPrefixes([{ countries: ["GB"], phonePrefixes: [] }, { countries: ["US"], phonePrefixes: ["+1 212"] }], "IL");
    expect(prefixes.sort()).toEqual(["+1212", "+44", "+972"]);
    expect(phoneInSellingMarkets("+972545550142", prefixes)).toBe(true);
    expect(phoneInSellingMarkets("+447700900123", prefixes)).toBe(true);
    expect(phoneInSellingMarkets("+12125550100", prefixes)).toBe(true);
    expect(phoneInSellingMarkets("+13105550100", prefixes)).toBe(false);
    // Premium international ranges (SMS pumping) are outside every selling market.
    expect(phoneInSellingMarkets("+88213456789", prefixes)).toBe(false);
  });

  it("any hour, never held back by the spacing, not commercial; one SMS each", () => {
    expect(SMS_KIND_TIMING.page_link).toBe("buyer_named");
    expect(SMS_SPACING_EXEMPT.has("page_link")).toBe(true);
    expect(SMS_COMMERCIAL_KINDS.has("page_link")).toBe(false);
    const vars = { seller: "Polar Demo", chat: "salesatscale18.vercel.app/c/Ab3dE6gH9k" };
    expect(smsText("page_link", "en", vars)).toBe("Polar Demo: your chat is here: salesatscale18.vercel.app/c/Ab3dE6gH9k");
    expect(smsText("page_link", "he", vars)).toBe("Polar Demo: השיחה שלך כאן: salesatscale18.vercel.app/c/Ab3dE6gH9k");
    expect(smsSegments(smsText("page_link", "he", vars))).toBe(1);
    const lead = { isTest: false, status: "new", phone: "+972545550142", sourceRef: null };
    const recent = [new Date(NOW.getTime() - 60_000)];
    expect(smsRefusal({ lead, stopped: false, hasConsent: true, kind: "page_link", contactHours: null, timezone: "Asia/Jerusalem", recent, now: NOW })).toBeNull();
    expect(smsRefusal({ lead, stopped: false, hasConsent: false, kind: "page_link", contactHours: null, timezone: "Asia/Jerusalem", recent, now: NOW })).toBe("no_consent");
  });
});

describe("lead page settings", () => {
  it("parses the add/edit form; the snippet and Button or link can be saved, the own form too; hosted not yet", () => {
    const ok = parseLeadPageInput({
      name: " Spring  offer ", connection: "link", language: "he", address: "", fields: { company: "on", email: undefined },
      openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" }, extraOrigins: "acme.webflow.io, https://Acme.webflow.io/ staging.acme.com", consentTicked: "",
    }, { languages: ["en", "he"] });
    expect(ok).toEqual({
      ok: true,
      value: {
        name: "Spring offer", address: null, connection: "link", language: "he", marketId: null,
        form: { fields: { company: true, email: false } }, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" }, tracking: {},
        extraOrigins: ["acme.webflow.io", "staging.acme.com"],
      },
    });
    const bad = parseLeadPageInput({ name: "", connection: "hosted", language: "fr", address: "nope nope", extraOrigins: ["bad host!"] }, { languages: ["en"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["address", "connection", "extraOrigins", "language", "name"]);
    // Slice b: "Our form on your page" can be saved, and needs the page's address.
    expect(parseLeadPageInput({ name: "x", connection: "snippet", language: "en" }, { languages: ["en"] })).toMatchObject({ ok: false, errors: { address: expect.any(String) } });
    expect(parseLeadPageInput({ name: "x", connection: "snippet", language: "en", address: "acme.com/offer" }, { languages: ["en"] })).toMatchObject({ ok: true, value: { connection: "snippet", address: "https://acme.com/offer" } });
    // Slice c: "Your own form" can be saved; its address is optional (recommended).
    expect(parseLeadPageInput({ name: "x", connection: "own_form", language: "en" }, { languages: ["en"] })).toMatchObject({ ok: true, value: { connection: "own_form", address: null } });
    expect(parseLeadPageInput({ name: "x", connection: "own_form", language: "en", address: "acme.com/contact" }, { languages: ["en"] })).toMatchObject({ ok: true, value: { connection: "own_form", address: "https://acme.com/contact" } });
    expect(goLiveBlockers({ hasPrivacyNotice: false, accountStatus: "setting_up" })).toEqual(["privacy_notice", "account_not_live"]);
    expect(goLiveBlockers({ hasPrivacyNotice: true, accountStatus: "live" })).toEqual([]);
    expect(initialsOf("Polar Demo")).toBe("PD");
  });
});

describe("banner", () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  const jpeg = (w: number, h: number) => {
    // SOI, an APP0 segment, then SOF0 with height and width.
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0]);
    return b;
  };
  const webp = (chunk: "VP8X" | "VP8 " | "VP8L", w: number, h: number) => {
    const b = new Uint8Array(40);
    b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk)]);
    if (chunk === "VP8X") { b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, 0], 24); b.set([(h - 1) & 255, ((h - 1) >> 8) & 255, 0], 27); }
    if (chunk === "VP8 ") { b.set([0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8], 23); }
    if (chunk === "VP8L") {
      const bits = (w - 1) | ((h - 1) << 14);
      b.set([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 20);
    }
    return b;
  };

  it("reads the type by magic bytes and the size from the header", () => {
    expect(sniffImage(png(1600, 500))).toEqual({ contentType: "image/png", width: 1600, height: 500 });
    expect(sniffImage(jpeg(1200, 400))).toEqual({ contentType: "image/jpeg", width: 1200, height: 400 });
    expect(sniffImage(webp("VP8X", 1500, 600))).toEqual({ contentType: "image/webp", width: 1500, height: 600 });
    expect(sniffImage(webp("VP8 ", 800, 300))).toEqual({ contentType: "image/webp", width: 800, height: 300 });
    expect(sniffImage(webp("VP8L", 640, 200))).toEqual({ contentType: "image/webp", width: 640, height: 200 });
    // SVG, GIF, text: never.
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a.........................."))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
  });

  it("checks size and type; the path is immutable by sha256", () => {
    expect(checkBanner(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    const big = new Uint8Array(BANNER_MAX_BYTES + 1);
    big.set(png(10, 10));
    expect(checkBanner(big)).toEqual({ ok: false, reason: "too_large" });
    expect(checkBanner(new TextEncoder().encode("<svg/>"))).toEqual({ ok: false, reason: "not_an_image" });
    expect(checkBanner(png(10, 10))).toMatchObject({ ok: true, contentType: "image/png" });
    expect(bannerBlobPath("production", "acc", "page", "ab".repeat(32), "image/webp")).toBe(`lead-pages/production/acc/page/${"ab".repeat(32)}.webp`);
  });
});
