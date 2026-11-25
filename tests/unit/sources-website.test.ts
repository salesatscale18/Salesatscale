import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPublicHost, isBlockedIp, parsePublicUrl, safeFetch, UnsafeUrlError, type FetchFn, type LookupFn } from "@/lib/sources/ssrf";
import { crawlWebsite, normalizePaths, parseRobots, robotsAllows, siteKey, underAllowed } from "@/lib/sources/website";

const publicLookup: LookupFn = async () => ["93.184.216.34"];

/** A fake site: path → response. Records every URL requested. */
function site(pages: Record<string, { status?: number; body?: string | Uint8Array; type?: string; location?: string }>) {
  const calls: string[] = [];
  const fetchImpl: FetchFn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = pages[`${u.host}${u.pathname}`] ?? pages[u.pathname];
    if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html; charset=utf-8" };
    if (p.location) headers.location = p.location;
    return new Response((p.body ?? "") as BodyInit, { status: p.status ?? 200, headers });
  };
  return { fetchImpl, calls };
}

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "224.0.0.1", "not-an-ip"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("refuses other schemes, credentials, localhost and private literal IPs", () => {
    for (const u of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com", "http://localhost:3000",
      "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://intranet/", "not a url"]) {
      expect(() => parsePublicUrl(u), u).toThrow(UnsafeUrlError);
    }
    expect(parsePublicUrl("https://example.com/a#x").toString()).toBe("https://example.com/a");
  });

  it("refuses a host that resolves to a private address (any of them)", async () => {
    await expect(assertPublicHost(new URL("https://evil.example"), async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicHost(new URL("https://ok.example"), publicLookup)).resolves.toBeUndefined();
  });

  it("re-checks every redirect and refuses one to a private address", async () => {
    const { fetchImpl, calls } = site({ "/": { status: 302, location: "http://169.254.169.254/latest/meta-data" } });
    await expect(safeFetch("https://example.com/", { fetchImpl, lookup: publicLookup })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toEqual(["https://example.com/"]);
  });

  it("refuses a redirect to a host that resolves privately", async () => {
    const { fetchImpl, calls } = site({ "/": { status: 301, location: "https://internal.example/" } });
    const lookup: LookupFn = async (h) => (h === "internal.example" ? ["192.168.0.10"] : ["93.184.216.34"]);
    await expect(safeFetch("https://example.com/", { fetchImpl, lookup })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toHaveLength(1);
  });

  it("follows a safe redirect and caps the body", async () => {
    const { fetchImpl } = site({ "/old": { status: 301, location: "/new" }, "/new": { body: "x".repeat(5000) } });
    const r = await safeFetch("https://example.com/old", { fetchImpl, lookup: publicLookup, maxBytes: 1000 });
    expect(r.url).toBe("https://example.com/new");
    expect(r.body).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it("asks fetch not to follow redirects by itself", async () => {
    let seen: RequestInit | undefined;
    await safeFetch("https://example.com/", { lookup: publicLookup, fetchImpl: async (_u, init) => { seen = init; return new Response("ok"); } });
    expect(seen?.redirect).toBe("manual");
  });
});

describe("paths and robots.txt", () => {
  it("normalises allowed paths", () => {
    expect(normalizePaths(["products", "/faq/", "https://x.example/restaurants?a=1", " ", "/faq"])).toEqual(["/products", "/faq", "/restaurants"]);
    expect(underAllowed("/products/sns-200", ["/products"])).toBe(true);
    expect(underAllowed("/productsx", ["/products"])).toBe(false);
    expect(underAllowed("/anything", [])).toBe(true);
  });

  it("applies the longest matching rule for our agent or *", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /");
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/ok/1")).toBe(true);
    expect(robotsAllows(rules, "/products")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: SalesAtScaleBot\nDisallow: /\n\nUser-agent: *\nAllow: /"), "/a")).toBe(false);
  });
});

describe("website crawl (mocked fetch)", () => {
  const page = (title: string, body: string, links: string[] = []) =>
    `<html lang="en"><head><title>${title}</title></head><body><nav><a href="/">Home</a></nav><main><p>${body}</p>${links.map((l) => `<li><a href="${l}">link</a></li>`).join("")}</main></body></html>`;

  it("reads same-host pages under the allowed paths, one section per page, and respects robots.txt", async () => {
    const { fetchImpl, calls } = site({
      "/robots.txt": { body: "User-agent: *\nDisallow: /products/secret", type: "text/plain" },
      "/": { body: page("Home", "Welcome", ["/products", "/blog/post", "https://other.example/products/x", "/products/a.pdf", "mailto:x@y.z"]) },
      "/products": { body: page("Products", "Sensors from 390", ["/products/sns-200", "/products/secret", "/products?page=2"]) },
      "/products/sns-200": { body: page("SNS-200", "Wireless sensor") },
      "/faq": { body: page("FAQ", "Answers") },
    });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: ["/products", "/faq"], fetchImpl, lookup: publicLookup });
    expect(r.sections.map((s) => [s.locator, s.heading, s.text])).toEqual([
      ["/products", "Products", "Sensors from 390\nlink\nlink\nlink"], ["/faq", "FAQ", "Answers"], ["/products/sns-200", "SNS-200", "Wireless sensor"],
    ]);
    expect(r.stats?.pagesRead).toBe(3);
    expect(r.problems).toEqual([]);
    expect(calls.some((c) => c.includes("other.example") || c.includes("/blog") || c.includes("secret"))).toBe(false);
    // A linked document under an allowed path is tried (here it is missing, so it is skipped quietly).
    expect(calls).toContain("https://polar.example/products/a.pdf");
    expect(r.lang).toBe("en");
  });

  it("stops at the page limit; a broken link the seller did not list is skipped quietly", async () => {
    const links = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const pages: Record<string, { body: string }> = { "/": { body: page("Home", "Hi", links) } };
    for (let i = 0; i < 40; i++) if (i !== 3) pages[`/p${i}`] = { body: page(`P${i}`, `Page ${i}`) };
    const { fetchImpl, calls } = site(pages);
    const r = await crawlWebsite({ url: "https://polar.example", allowedPaths: [], fetchImpl, lookup: publicLookup, limits: { maxPages: 30 } });
    expect(calls.filter((c) => !c.endsWith("/robots.txt"))).toHaveLength(30);
    expect(r.problems).toEqual([]);
    expect(r.sections.length).toBe(29);
  });

  it("stops when the source's text cap is reached, without calling it a failure", async () => {
    const big = "y".repeat(600);
    const { fetchImpl } = site({ "/": { body: page("Home", big, ["/a", "/b", "/c"]) }, "/a": { body: page("A", big) }, "/b": { body: page("B", big) }, "/c": { body: page("C", big) } });
    const r = await crawlWebsite({ url: "https://polar.example", allowedPaths: [], fetchImpl, lookup: publicLookup, limits: { maxTextChars: 1500, concurrency: 1 } });
    expect(r.problems).toEqual([]);
    expect(r.sections.length).toBeLessThan(4);
    expect(r.sections.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(1500);
  });

  it("reads a large page's text: the markup (scripts, styles) does not count against it", async () => {
    const script = `<script>${"var x=1;".repeat(250_000)}</script>`; // about 2 MB of script
    const { fetchImpl } = site({ "/": { body: `<html><head>${script}</head><body>${script}<main><p>We install sensors in 3 days.</p></main></body></html>` } });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: [], fetchImpl, lookup: publicLookup });
    expect(r.problems).toEqual([]);
    expect(r.sections.map((x) => x.text)).toEqual(["We install sensors in 3 days."]);
  });

  it("treats www and the bare domain as one site (a start page that redirects to www is read)", async () => {
    expect(siteKey("WWW.Polar.example")).toBe("polar.example");
    const { fetchImpl } = site({
      "polar.example/": { status: 301, location: "https://www.polar.example/" },
      "www.polar.example/": { body: page("Home", "Welcome", ["https://polar.example/faq", "/products"]) },
      "www.polar.example/products": { body: page("Products", "Sensors") },
      "polar.example/faq": { body: page("FAQ", "Answers") },
    });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: [], fetchImpl, lookup: publicLookup });
    expect(r.problems).toEqual([]);
    expect(r.sections.map((x) => x.locator).sort()).toEqual(["/", "/faq", "/products"]);
  });

  it("reports a section the seller listed when it fails, and a page with no text", async () => {
    const { fetchImpl } = site({ "/": { body: page("Home", "Hi") }, "/app": { body: "<html><body><div id=root></div><script>x()</script></body></html>" } });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: ["/", "/missing", "/app"], fetchImpl, lookup: publicLookup });
    expect(r.problems).toEqual([
      expect.objectContaining({ where: "/missing", message: "The page answered with error 404." }),
      expect.objectContaining({ where: "/app", message: expect.stringContaining("shows no text") }),
    ]);
    expect(r.sections.map((x) => x.locator)).toEqual(["/"]);
  });

  it("uses the page description when a page is built in the browser", async () => {
    const { fetchImpl } = site({ "/": { body: '<html><head><meta name="description" content="Smart sensors for restaurants"></head><body><div id=root></div></body></html>' } });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: [], fetchImpl, lookup: publicLookup });
    expect(r.sections.map((x) => x.text)).toEqual(["Smart sensors for restaurants"]);
  });

  it("reads the text of linked PDF and Word documents, one section each", async () => {
    const pdf = new Uint8Array(readFileSync("tests/fixtures/sources/two-pages-one-empty.pdf"));
    const docx = new Uint8Array(readFileSync("tests/fixtures/sources/guide.docx"));
    const { fetchImpl } = site({
      "/": { body: page("Home", "Hi", ["/files/price%20list.pdf", "/files/guide.docx", "/files/missing.pdf"]) },
      "/files/price%20list.pdf": { body: pdf, type: "application/pdf" },
      "/files/guide.docx": { body: docx, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: [], fetchImpl, lookup: publicLookup });
    expect(r.problems).toEqual([]);
    const docs = r.sections.filter((x) => x.locator.startsWith("/files/"));
    expect(docs.map((x) => [x.locator, x.heading])).toEqual([["/files/price%20list.pdf", "price list.pdf"], ["/files/guide.docx", "guide.docx"]]);
    for (const d of docs) expect(d.text.length).toBeGreaterThan(5);
  });

  it("refuses a start address on a private network", async () => {
    const { fetchImpl, calls } = site({});
    await expect(crawlWebsite({ url: "https://intranet.example", allowedPaths: [], fetchImpl, lookup: async () => ["10.0.0.1"] })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toEqual([]);
  });

  it("does not read another site the start page redirects to, and says where it goes", async () => {
    const { fetchImpl } = site({ "/": { status: 302, location: "https://elsewhere.example/" }, "elsewhere.example/": { body: page("Else", "Other site") } });
    const r = await crawlWebsite({ url: "https://polar.example/", allowedPaths: [], fetchImpl, lookup: publicLookup });
    expect(r.sections).toEqual([]);
    expect(r.problems).toEqual([expect.objectContaining({ message: "This address opens elsewhere.example.", fix: "Add https://elsewhere.example as the website instead." })]);
  });
});
