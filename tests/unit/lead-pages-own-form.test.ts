/**
 * Lead pages slice c, pure parts: the own form's error redirect (allowed Referer
 * origin only), its consent wording, the field aliases, the funnel with dashes
 * for visits and opens, the ready HTML example, the snippet's consent-gated
 * keep of ad details (TypeScript core and v1.js on the same inputs) and the
 * snippet's consent-line colour. No DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OWN_FORM_ERRORS, OWN_FORM_FIELDS, ownFormConsentWording, ownFormErrorUrl, readSubmission, validateSubmission, OWN_FORM_ALL_FIELDS } from "@/lib/lead-pages/rules";
import { sitePageUrl } from "@/lib/lead-pages/origin";
import type { SubmitResult } from "@/lib/lead-pages/intake";
import { OWN_FORM_ERROR_TEXT, ownFormErrorCode, REFUSAL_PAGE_CSP, refusalPageHtml, refusalSentenceKey } from "@/lib/lead-pages/refusal";
import { messages } from "@/lib/i18n";
import { AD_STORE_KEY, keepAd, parseKeptAd, type ConsentSignal } from "@/lib/lead-pages/snippet-core";
import type { Funnel } from "@/lib/lead-pages/stats";
import { countsOpens, countsVisits, funnelSteps, ownFormAction, ownFormExample, ownFormPreviewField } from "@/lib/lead-pages/view";

const code = readFileSync(join(process.cwd(), "public/lp/v1.js"), "utf8");
function scriptCore() {
  const sandbox: Record<string, unknown> = {
    document: { currentScript: { src: "https://app.example.com/lp/v1.js" }, querySelector: () => null, documentElement: null, readyState: "complete", addEventListener: () => undefined },
    location: { hash: "", search: "", href: "https://acme.com/", hostname: "acme.com" },
    URLSearchParams, Promise, setTimeout, JSON, Object, Array,
  };
  sandbox.window = sandbox;
  runInNewContext(code, sandbox, { filename: "v1.js" });
  return (sandbox.SasLeadForm as { core: Record<string, (...a: unknown[]) => unknown> }).core;
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

describe("the seller's own form", () => {
  it("goes back only to the Referer page on the allowed origin, with ?sas_error= and without the page's query", () => {
    const A = "https://acme.com";
    const noAddress = { address: null };
    expect(ownFormErrorUrl(noAddress, "https://acme.com/contact?name=Dana&utm_source=x#top", A, "phone")).toBe("https://acme.com/contact?sas_error=phone");
    expect(ownFormErrorUrl(noAddress, "https://acme.com", A, "busy")).toBe("https://acme.com/?sas_error=busy");
    for (const ref of ["https://evil.example/contact", "https://acme.com.evil.example/x", "http://acme.com/contact", "https://acme.com:8443/x", "javascript:alert(1)", "data:text/html,x", "//evil.example", "https://u:p@acme.com/x", "not a url"]) {
      expect(ownFormErrorUrl(noAddress, ref, A, "generic")).toBeNull();
      expect(ownFormErrorUrl({ address: "https://acme.com/contact" }, ref, A, "generic")).toBeNull();
    }
    expect(ownFormErrorUrl(noAddress, "https://acme.com/contact", null, "generic")).toBeNull();
    expect(ownFormErrorUrl(noAddress, "https://evil.example/x", "https://evil.example/x", "generic")).toBeNull();
    expect(OWN_FORM_ERRORS).toEqual(["name", "phone", "busy", "closed", "generic"]);
  });

  it("an origin-only Referer (a cross-site form post) goes back to the page's address on its host or www twin; an extra address keeps its origin", () => {
    const page = { address: "https://acme.com/contact" };
    // Origin-only Referer, or none (Origin header only): the address's path.
    for (const ref of ["https://acme.com/", "https://acme.com", "", null]) {
      expect(sitePageUrl(page, ref, "https://acme.com")).toBe("https://acme.com/contact");
      expect(ownFormErrorUrl(page, ref, "https://acme.com", "phone")).toBe("https://acme.com/contact?sas_error=phone");
    }
    // The www twin: its own origin with the address's path.
    expect(sitePageUrl(page, "https://www.acme.com/", "https://www.acme.com")).toBe("https://www.acme.com/contact");
    expect(ownFormErrorUrl(page, "https://www.acme.com/", "https://www.acme.com", "name")).toBe("https://www.acme.com/contact?sas_error=name");
    // A full Referer wins (query dropped).
    expect(sitePageUrl(page, "https://acme.com/offer?utm_source=fb", "https://acme.com")).toBe("https://acme.com/offer");
    // An "Other addresses" host: its origin only.
    expect(sitePageUrl(page, "https://staging.acme.com/", "https://staging.acme.com")).toBe("https://staging.acme.com");
    expect(ownFormErrorUrl(page, "https://staging.acme.com/", "https://staging.acme.com", "busy")).toBe("https://staging.acme.com/?sas_error=busy");
    expect(sitePageUrl(page, "https://staging.acme.com/try?x=1", "https://staging.acme.com")).toBe("https://staging.acme.com/try");
    // A Referer on another origin than the checked one: null (never a redirect there).
    expect(sitePageUrl(page, "https://www.acme.com/contact", "https://acme.com")).toBeNull();
    // An address at the site root.
    expect(sitePageUrl({ address: "https://acme.com" }, "https://acme.com/", "https://acme.com")).toBe("https://acme.com");
    expect(ownFormErrorUrl({ address: "https://acme.com" }, "https://acme.com/", "https://acme.com", "phone")).toBe("https://acme.com/?sas_error=phone");
  });

  it("keeps where the buyer ticked the box as the consent wording (we cannot see the seller's text)", () => {
    expect(ownFormConsentWording("https://acme.com/contact")).toBe("Seller's own form on acme.com/contact");
    expect(ownFormConsentWording("https://www.acme.com")).toBe("Seller's own form on www.acme.com");
  });

  it("reads the intake API's field aliases; consent only for true/on/yes/1; every optional field it sends", () => {
    const f = readSubmission({ full_name: "Avi Levi", tel: "0547200002", business: "Diner", email: "a@b.co", sites: "3", consent: "YES" });
    expect(f).toMatchObject({ name: "Avi Levi", phone: "0547200002", company: "Diner", email: "a@b.co", consent: true, honeypot: false });
    // "Number of sites" is no longer a field: a posted `sites` is not read.
    expect(f).not.toHaveProperty("sites");
    expect(OWN_FORM_FIELDS.map((x) => x.name)).toEqual(["name", "phone", "company", "email", "consent"]);
    expect(readSubmission({ name: "A", mobile: "1" }).phone).toBe("1");
    for (const v of ["true", "on", "1", "yes", "On"]) expect(readSubmission({ consent: v }).consent).toBe(true);
    for (const v of ["", "no", "false", "0", "off", "y"]) expect(readSubmission({ consent: v }).consent).toBe(false);
    expect(readSubmission({ sas_url: "http://spam" }).honeypot).toBe(true);
    const v = validateSubmission(f, "IL", OWN_FORM_ALL_FIELDS);
    expect(v).toEqual({ ok: true, value: { fullName: "Avi Levi", phone: "+972547200002", company: "Diner", email: "a@b.co" } });
    // The documented names are the ones read.
    for (const field of OWN_FORM_FIELDS) {
      for (const name of [field.name, ...field.aliases]) {
        const got = readSubmission({ [name]: field.name === "consent" ? "on" : "Value One" });
        const key = field.name === "name" ? "name" : field.name;
        expect(got[key as keyof typeof got]).toBeTruthy();
      }
    }
  });

  it("the funnel shows a dash for visits and opens; percents start at the first counted step", () => {
    const f: Funnel = { visits: 0, opens: 0, leftDetails: 10, startedTalking: 5, gotQuote: 2, ordered: 1, percents: [] };
    expect(countsVisits("own_form")).toBe(false);
    expect(countsOpens("own_form")).toBe(false);
    expect(countsOpens("link")).toBe(true);
    const steps = funnelSteps(f, "own_form");
    expect(steps.map((s) => [s.key, s.value, s.pct])).toEqual([
      ["visits", null, null], ["opens", null, null], ["leftDetails", 10, null], ["startedTalking", 5, "50%"], ["gotQuote", 2, "40%"], ["ordered", 1, "50%"],
    ]);
    // Button or link: unchanged (only visits are a dash).
    expect(funnelSteps({ ...f, opens: 20 }, "link").map((s) => s.value)).toEqual([null, 20, 10, 5, 2, 1]);
  });

  it("a ready HTML example posting to the page's address, escaped, with the test code when there is one", () => {
    const action = ownFormAction("https://app.example.com/", "abcABC123456");
    expect(action).toBe("https://app.example.com/api/lp/abcABC123456/submit");
    const html = ownFormExample(action, 'By sending, you agree that "A&B" <may> contact you.', { name: "Full name", phone: "Mobile number", send: "Send" });
    expect(html).toContain('<form method="post" action="https://app.example.com/api/lp/abcABC123456/submit">');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="phone" type="tel"');
    expect(html).toContain('<input type="checkbox" name="consent" value="yes"> By sending, you agree that &quot;A&amp;B&quot; &lt;may&gt; contact you.</label>');
    expect(html).toContain('name="sas_url" tabindex="-1"');
    expect(html).not.toContain("preview");
    expect(ownFormExample(action, "x", { name: "שם מלא", phone: "נייד", send: "שליחה" }, "lz3k9q.AbCdEfGhIjKlMnOpQrStUv")).toContain('<input type="hidden" name="preview" value="lz3k9q.AbCdEfGhIjKlMnOpQrStUv">');
    expect(ownFormPreviewField("a\"b")).toBe('<input type="hidden" name="preview" value="a&quot;b">');
  });
});

describe("the snippet keeps ad details only with a granted consent signal", () => {
  const cur = { utm_source: "facebook", utm_campaign: "Spring" };
  const kept = JSON.stringify({ utm_source: "google", gclid: "abc", evil: "x", utm_term: 5 });

  it("granted: this URL's details are kept; a later page without any uses the kept ones", () => {
    expect(keepAd(cur, kept, "granted")).toEqual({ ad: cur, store: JSON.stringify(cur), clear: false });
    expect(keepAd({}, kept, "granted")).toEqual({ ad: { utm_source: "google", gclid: "abc" }, store: null, clear: false });
    expect(keepAd({}, null, "granted")).toEqual({ ad: {}, store: null, clear: false });
  });

  it("unknown or denied: the current URL only, nothing kept; denied clears what was kept", () => {
    expect(keepAd({}, kept, "unknown")).toEqual({ ad: {}, store: null, clear: false });
    expect(keepAd(cur, kept, "unknown")).toEqual({ ad: cur, store: null, clear: false });
    expect(keepAd({}, kept, "denied")).toEqual({ ad: {}, store: null, clear: true });
  });

  it("reads back only known keys, capped; junk is ignored", () => {
    expect(parseKeptAd(`{"utm_content":"${"x".repeat(300)}","referrer":"google.com"}`)).toEqual({ utm_content: "x".repeat(200), referrer: "google.com" });
    for (const junk of ["", "null", "[1]", "{", "\"x\"", undefined]) expect(parseKeptAd(junk)).toEqual({});
    expect(AD_STORE_KEY).toBe("sas_lp_ad");
  });

  it("v1.js gives the same answers as the TypeScript core", () => {
    const core = scriptCore();
    const cases: [Record<string, string>, string | null, ConsentSignal][] = [
      [cur, kept, "granted"], [{}, kept, "granted"], [{}, null, "granted"], [{}, kept, "unknown"], [cur, kept, "denied"], [{}, "{", "granted"],
    ];
    for (const [c, k, s] of cases) expect(plain(core.keepAd(c, k, s))).toEqual(keepAd(c, k, s));
    expect(plain(core.parseKeptAd(`{"utm_content":"${"x".repeat(300)}","x":"1"}`))).toEqual(parseKeptAd(`{"utm_content":"${"x".repeat(300)}","x":"1"}`));
    expect(code).toContain('var STORE = "sas_lp_ad"');
  });

  it("the consent line takes the host's text colour at about 80% (not a fixed grey); its link keeps the underline", () => {
    expect(code).toContain("color:color-mix(in srgb,currentColor 80%,transparent)");
    expect(code).toMatch(/\.c span\{opacity:\.8\}/);
    expect(code).toContain("a{color:inherit;text-decoration:underline}");
  });
});

describe("a refused own-form post: codes, sentences and the styled page", () => {
  const results: SubmitResult[] = [
    { kind: "invalid", errors: ["name"] }, { kind: "invalid", errors: ["phone", "name"] }, { kind: "invalid", errors: [] },
    { kind: "busy", retryAfterSeconds: 60 },
    { kind: "refused", reason: "closed" }, { kind: "refused", reason: "origin" }, { kind: "refused", reason: "timing" },
    { kind: "not_found" }, { kind: "thanks" },
  ];

  it("the codes the endpoint can return are exactly the codes the panel lists, each with an approved buyer sentence in en and he", () => {
    const returned = new Set(results.map(ownFormErrorCode));
    expect([...returned].sort()).toEqual([...OWN_FORM_ERRORS].sort());
    expect(Object.keys(OWN_FORM_ERROR_TEXT).sort()).toEqual([...OWN_FORM_ERRORS].sort());
    for (const c of OWN_FORM_ERRORS) {
      const key = OWN_FORM_ERROR_TEXT[c];
      expect(key.startsWith("buyer.lp.form.")).toBe(true);
      expect(messages.en[key]).toBeTruthy();
      expect(messages.he[key]).toBeTruthy();
    }
  });

  it("without a redirect: busy and closed say so, anything else is the generic sentence", () => {
    expect(OWN_FORM_ERRORS.map(refusalSentenceKey)).toEqual(["buyer.lp.form.err_generic", "buyer.lp.form.err_generic", "buyer.lp.form.err_busy", "buyer.lp.form.closed", "buyer.lp.form.err_generic"]);
  });

  it("the styled page: the sentence, lang and dir, noindex, inline CSS only, no scripts or external assets", () => {
    const en = refusalPageHtml("en", "buyer.lp.form.err_generic");
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain("<p>Something went wrong. Please try again.</p>");
    expect(en).toContain('<meta name="robots" content="noindex, nofollow">');
    const he = refusalPageHtml("he", "buyer.lp.form.closed");
    expect(he).toContain('<html lang="he" dir="rtl">');
    expect(he).toContain(`<p>${messages.he["buyer.lp.form.closed"]}</p>`);
    for (const html of [en, he]) {
      expect(html).not.toMatch(/<script|<link|<img|<form|<a\s|src=|href=|url\(|@import|https?:/i);
      expect(html).toContain("<style>");
    }
    expect(REFUSAL_PAGE_CSP).toMatch(/default-src 'none'.*style-src 'unsafe-inline'/);
  });
});
