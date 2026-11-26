/**
 * The lead form snippet (slice b): the pure logic in lib/lead-pages/snippet-core.ts,
 * the same logic inside public/lp/v1.js (run in a node vm, compared on the same
 * inputs), the script's size budget (12 KB gzipped) and its ES2019 syntax, and
 * the seller-side helpers (snippet code, preview link, "Seen on …" suggestion,
 * the other-addresses form fields, the empty funnel). No DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import type { LeadPage } from "@/db/schema";
import { translator } from "@/lib/i18n";
import { aboutLine, leadFormText, SHOW_ABOUT_TOPIC } from "@/lib/lead-pages/form-text";
import { corsHeaders } from "@/lib/lead-pages/origin";
import {
  checkLocal, freshFromHash, nextUrl, pageUrlOf, previewFromHash, readAd, readConsent, scriptBase, tellPixels, type ConsentWindow,
} from "@/lib/lead-pages/snippet-core";
import { funnelEmpty, rawFromForm, seenOriginSuggestion, snippetCode, snippetPreviewUrl, type FunnelStep } from "@/lib/lead-pages/view";

const SCRIPT = join(process.cwd(), "public/lp/v1.js");
const code = readFileSync(SCRIPT, "utf8");
const TOKEN = "lz3k9q.AbCdEfGhIjKlMnOpQrStUv";

/** v1.js's own core, loaded the way a browser would, on a page with no placeholder yet. */
function scriptCore() {
  const sandbox: Record<string, unknown> = {
    document: { currentScript: { src: "https://app.example.com/lp/v1.js" }, querySelector: () => null, documentElement: null, readyState: "complete", addEventListener: () => undefined },
    location: { hash: "", search: "", href: "https://acme.com/", hostname: "acme.com" },
    URLSearchParams, Promise, setTimeout,
  };
  sandbox.window = sandbox;
  runInNewContext(code, sandbox, { filename: "v1.js" });
  const api = sandbox.SasLeadForm as { v: number; core: Record<string, (...a: unknown[]) => unknown> };
  expect(api.v).toBe(1);
  return api.core;
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

describe("snippet core", () => {
  it("reads the preview token only from #sas-preview= in the fragment, and the script's own host", () => {
    expect(previewFromHash(`#sas-preview=${TOKEN}`)).toBe(TOKEN);
    expect(previewFromHash(`#top&sas-preview=${TOKEN}`)).toBe(TOKEN);
    expect(previewFromHash(`#sas-preview=${TOKEN}x!`)).toBeNull();
    expect(previewFromHash("#sas-preview=nope")).toBeNull();
    expect(previewFromHash("")).toBeNull();
    expect(scriptBase("https://app.example.com/lp/v1.js")).toBe("https://app.example.com");
    expect(scriptBase("http://localhost:3000/lp/v1.js?x")).toBe("http://localhost:3000");
    expect(scriptBase("")).toBeNull();
  });

  it("reads UTM values, click IDs and another site's referrer host, capped", () => {
    expect(readAd("?utm_source=facebook&utm_campaign=Spring&gclid=abc&x=1&utm_medium=", "https://www.google.com/search?q=1", "acme.com")).toEqual({
      utm_source: "facebook", utm_campaign: "Spring", gclid: "abc", referrer: "www.google.com",
    });
    expect(readAd("", "https://acme.com/other", "acme.com")).toEqual({});
    expect(readAd(`?utm_term=${"x".repeat(300)}`, "", "acme.com").utm_term).toHaveLength(200);
  });

  it("reads cookie-consent signals: denied wins, then granted, else unknown", () => {
    const cases: [ConsentWindow, Parameters<typeof readConsent>[1], string][] = [
      [{}, null, "unknown"],
      [{ dataLayer: [["consent", "default", { analytics_storage: "denied" }], ["consent", "update", { analytics_storage: "granted" }]] }, null, "granted"],
      [{ dataLayer: [["consent", "default", { analytics_storage: "granted" }], ["consent", "update", { analytics_storage: "denied" }]] }, null, "denied"],
      [{ dataLayer: [{ event: "gtm.js" }] }, null, "unknown"],
      [{ Cookiebot: { consent: { statistics: true } } }, null, "granted"],
      [{ Cookiebot: { consent: { statistics: false }, hasResponse: false } }, null, "unknown"],
      [{ Cookiebot: { consent: { statistics: false }, hasResponse: true } }, null, "denied"],
      [{ OnetrustActiveGroups: ",C0001,C0002," }, null, "granted"],
      [{ OnetrustActiveGroups: ",C0001," }, null, "denied"],
      [{}, { gdprApplies: true, purpose: { consents: { 1: true } } }, "granted"],
      [{}, { gdprApplies: true, purpose: { consents: { 1: false } } }, "denied"],
      [{}, { gdprApplies: false, purpose: { consents: {} } }, "unknown"],
      [{ OnetrustActiveGroups: ",C0001,C0002," }, { gdprApplies: true, purpose: { consents: { 1: false } } }, "denied"],
    ];
    for (const [win, tc, want] of cases) expect([win, tc, readConsent(win, tc)]).toEqual([win, tc, want]);
    // gtag pushes `arguments` objects, not arrays.
    const args = (function (..._a: unknown[]) { return arguments; })("consent", "update", { analytics_storage: "denied" });
    expect(readConsent({ dataLayer: [args] })).toBe("denied");
  });

  it("tells only the page's own pixel, never loading one", () => {
    const calls: unknown[][] = [];
    const win = { fbq: (...a: unknown[]) => calls.push(["fbq", ...a]), gtag: (...a: unknown[]) => calls.push(["gtag", ...a]), dataLayer: [] as unknown[] };
    expect(tellPixels(win, "sub-1")).toEqual({ meta: "called", google: "called" });
    expect(calls).toEqual([["fbq", "track", "Lead", {}, { eventID: "sub-1" }], ["gtag", "event", "generate_lead", {}]]);
    expect(win.dataLayer).toEqual([]);
    const gtm = { dataLayer: [] as unknown[] };
    expect(tellPixels(gtm, "x")).toEqual({ meta: "absent", google: "called" });
    expect(gtm.dataLayer).toEqual([{ event: "generate_lead" }]);
    expect(tellPixels({}, "x")).toEqual({ meta: "absent", google: "absent" });
    expect(tellPixels({ fbq: () => { throw new Error("blocked"); } }, "x").meta).toBe("called");
  });

  it("checks the two required fields, strips the page URL, and accepts only our own next URLs", () => {
    expect(checkLocal("R", "12")).toEqual(["name", "phone"]);
    expect(checkLocal("Rina", "054-555 0142")).toEqual([]);
    expect(pageUrlOf("https://acme.com/offer?utm_source=x#sas-preview=1")).toBe("https://acme.com/offer");
    expect(pageUrlOf("https://acme.com")).toBe("https://acme.com/");
    expect(nextUrl("https://app.example.com", { handover: "/h/AAAA.BBBB" })).toBe("https://app.example.com/h/AAAA.BBBB");
    expect(nextUrl("https://app.example.com", { thanks: "/p/abcABC123456?sent=1" })).toBe("https://app.example.com/p/abcABC123456?sent=1");
    expect(nextUrl("https://app.example.com", { handover: "//evil.com/h/x" })).toBeNull();
    expect(nextUrl("https://app.example.com", { handover: "javascript:alert(1)" })).toBeNull();
    expect(nextUrl("https://app.example.com", {})).toBeNull();
  });
});

describe("public/lp/v1.js", () => {
  it("is at most 12 KB gzipped", () => {
    const gz = gzipSync(readFileSync(SCRIPT)).length;
    expect(gz).toBeLessThanOrEqual(12 * 1024);
  });

  it("is ES2019: lowering it to ES2019 changes nothing (no optional chaining, ??, logical assignment, private fields…)", () => {
    // esbuild (already used by the tooling) rewrites any newer syntax when the target is es2019.
    const as = (target: string) => transformSync(code, { target, loader: "js" }).code;
    expect(as("es2019")).toBe(as("esnext"));
    // The check itself notices newer syntax.
    expect(transformSync("var q = a?.b ?? c;", { target: "es2019" }).code).not.toBe(transformSync("var q = a?.b ?? c;", { target: "esnext" }).code);
    // No cookies, never another script; storage only in the one consent-gated place (the kept ad details, slice c).
    expect(code).not.toMatch(/localStorage|document\.cookie|createElement\("script"\)|indexedDB/);
    expect(code.match(/\w+\.sessionStorage/g)).toEqual(["w.sessionStorage"]);
    expect(code).toContain('credentials: "omit"');
  });

  it("its core gives the same answers as lib/lead-pages/snippet-core.ts", () => {
    const core = scriptCore();
    const ad: [string, string, string][] = [
      ["?utm_source=facebook&utm_campaign=Spring&gclid=abc", "https://www.google.com/", "acme.com"],
      ["?fbclid=Z&utm_term=" + "y".repeat(250), "https://ACME.com/x", "acme.com"],
      ["", "", ""],
    ];
    for (const a of ad) expect(plain(core.readAd(...a))).toEqual(readAd(...a));
    const wins: [ConsentWindow, Parameters<typeof readConsent>[1]][] = [
      [{}, null], [{ dataLayer: [["consent", "default", { analytics_storage: "denied" }]] }, null], [{ Cookiebot: { consent: { statistics: false }, hasResponse: true } }, null],
      [{ OnetrustActiveGroups: ",C0001,C0002," }, null], [{}, { gdprApplies: true, purpose: { consents: { 1: false } } }], [{}, { gdprApplies: false, purpose: { consents: {} } }],
    ];
    for (const [w, tc] of wins) expect(core.readConsent(w, tc)).toBe(readConsent(w, tc));
    for (const h of [`#sas-preview=${TOKEN}`, "#x", "", `#a&sas-preview=${TOKEN}`]) expect(core.previewFromHash(h)).toBe(previewFromHash(h));
    // A preview's "Start over" (owner, 26 Nov): the fragment flag, read the same way on both sides.
    for (const h of [`#sas-preview=${TOKEN}&sas-fresh=1`, `#sas-preview=${TOKEN}`, "#sas-fresh=10", "#a&sas-fresh=1&b", ""]) expect(core.freshFromHash(h)).toBe(freshFromHash(h));
    expect(freshFromHash(`#sas-preview=${TOKEN}&sas-fresh=1`)).toBe(true);
    expect(previewFromHash(`#sas-preview=${TOKEN}&sas-fresh=1`)).toBe(TOKEN);
    expect(freshFromHash(`#sas-preview=${TOKEN}`)).toBe(false);
    for (const s of ["https://a.b/lp/v1.js", "nope", ""]) expect(core.scriptBase(s)).toBe(scriptBase(s));
    for (const [n, p] of [["R", "1"], ["Rina", "0545550142"], ["", ""]]) expect(plain(core.checkLocal(n, p))).toEqual(checkLocal(n, p));
    for (const h of ["https://acme.com/offer?x=1#y", "https://acme.com", "nope"]) expect(core.pageUrlOf(h)).toBe(pageUrlOf(h));
    for (const b of [{ handover: "/h/AAAA.BBBB" }, { thanks: "/p/k?sent=1" }, { handover: "//evil" }, {}]) expect(core.nextUrl("https://x.y", b)).toBe(nextUrl("https://x.y", b));
    const mk = () => { const calls: unknown[] = []; return { calls, win: { fbq: (...a: unknown[]) => calls.push(a), dataLayer: [] as unknown[] } }; };
    const a1 = mk(), a2 = mk();
    expect(plain(core.tellPixels(a1.win, "e1"))).toEqual(tellPixels(a2.win, "e1"));
    expect(plain(a1.calls)).toEqual(plain(a2.calls));
    expect(plain(a1.win.dataLayer)).toEqual(plain(a2.win.dataLayer));
  });
});

describe("snippet: texts and seller helpers", () => {
  it("the form texts are the hosted form's own approved strings; the About line is one flag", () => {
    const he = leadFormText(translator("he"));
    expect(he).toMatchObject({ title: "השאירו פרטים", send: "שליחה", continue: "המשך לצ'אט" });
    expect(Object.values(leadFormText(translator("en"))).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    // The line waits for the owner's approval of its wording: off until then.
    expect(aboutLine(translator("en"), { en: "Fridge monitoring", he: "ניטור מקררים" }, "en")).toBe(SHOW_ABOUT_TOPIC ? "About: Fridge monitoring" : null);
    expect(aboutLine(translator("he"), { en: "Fridge monitoring", he: "ניטור מקררים" }, "he")).toBe(SHOW_ABOUT_TOPIC ? "בנושא: ניטור מקררים" : null);
    expect(aboutLine(translator("en"), null, "en")).toBeNull();
  });

  it("CORS headers echo the origin, vary on it and never allow credentials", () => {
    const h = corsHeaders("https://www.acme.com");
    expect(h).toMatchObject({ "Access-Control-Allow-Origin": "https://www.acme.com", Vary: "Origin" });
    expect(Object.keys(h).some((k) => /credentials/i.test(k))).toBe(false);
  });

  it("the snippet code, its preview link and the \"Seen on …\" suggestion", () => {
    expect(snippetCode("https://app.example.com/", "abcABC123456")).toBe('<div data-sas-lead-form="abcABC123456"></div>\n<script async src="https://app.example.com/lp/v1.js"></script>');
    expect(snippetPreviewUrl("https://acme.com/offer#old", TOKEN)).toBe(`https://acme.com/offer#sas-preview=${TOKEN}`);
    const page = { address: "https://acme.com/offer", extraOrigins: ["staging.acme.com"], checks: {} } as Pick<LeadPage, "address" | "extraOrigins" | "checks">;
    expect(seenOriginSuggestion(page)).toBeNull();
    expect(seenOriginSuggestion({ ...page, checks: { refusedOrigin: "https://acme.webflow.io" } })).toBe("acme.webflow.io");
    expect(seenOriginSuggestion({ ...page, checks: { refusedOrigin: "https://staging.acme.com" } })).toBeNull();
    expect(seenOriginSuggestion({ ...page, checks: { refusedOrigin: "http://www.acme.com" } })).toBeNull();
  });

  it("the edit form keeps the ticked addresses, adds the suggested and the typed one, and reads the pixel switch", () => {
    const existing = { extraOrigins: ["staging.acme.com", "old.acme.com"], tracking: {}, openingTopic: null } as unknown as LeadPage;
    const fd = new FormData();
    for (const [k, v] of [["originsShown", "1"], ["extraOrigin", "staging.acme.com"], ["extraOrigin", "injected.evil.com"], ["addSeen", "acme.webflow.io"], ["newOrigin", " new.acme.com "], ["tellPagePixel", "on"]]) fd.append(k, v);
    expect(rawFromForm(fd, [], existing)).toMatchObject({ extraOrigins: ["staging.acme.com", "acme.webflow.io", "new.acme.com"], tracking: { tellPagePixel: true, carryAdDetails: false } });
    // A form without the list keeps what is saved.
    expect(rawFromForm(new FormData(), [], existing).extraOrigins).toEqual(["staging.acme.com", "old.acme.com"]);
  });

  it("an empty funnel is one line; any number keeps the bars", () => {
    const step = (value: number | null): FunnelStep => ({ key: "visits", label: "lead_pages.funnel.visits", value, pct: null });
    expect(funnelEmpty([step(null), step(0), step(0)])).toBe(true);
    expect(funnelEmpty([step(3), step(0)])).toBe(false);
  });
});
