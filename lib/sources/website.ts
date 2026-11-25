/**
 * Website sources (P8.3): reads the start page and same-site pages under the
 * allowed paths, one section per page with the path as locator, plus the PDF
 * and Word documents those pages link to (their text, one section each).
 * What matters is the text: a page is read up to 5 MB and only its text is
 * kept; the limits count the text, not the page's markup.
 * Limits: 40 pages, 10 documents (10 MB each), the source's text cap, 15 s
 * per request, 4 requests at a time, 150 s in all; robots.txt respected.
 * "www." and the bare domain are the same site. Only the start page and the
 * sections the seller listed report problems; a broken link elsewhere is
 * skipped. Every request goes through safeFetch (SSRF guard).
 */
import type { SourceProblem } from "@/db/schema";
import { htmlToText } from "./html";
import { parseDocx, parsePdf } from "./files";
import { safeFetch, parsePublicUrl, UnsafeUrlError, type FetchFn, type LookupFn, type SafeResponse } from "./ssrf";
import { MAX_SOURCE_CHARS, type ParseResult, type ParsedSection } from "./text";

export const WEBSITE_LIMITS = {
  maxPages: 40, maxDocs: 10, maxPageBytes: 5 * 1024 * 1024, maxDocBytes: 10 * 1024 * 1024,
  /** Downloads in all (a safety net: the text cap below normally ends the read first). */
  maxTotalBytes: 60 * 1024 * 1024,
  maxTextChars: MAX_SOURCE_CHARS,
  timeoutMs: 15_000, budgetMs: 150_000, concurrency: 4,
};

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|rar|7z|mp3|mp4|mov|avi|wav|woff2?|ttf|eot|xlsx?|pptx?|csv|dmg|exe|apk)$/i;
const DOC_EXT = /\.(pdf|docx)$/i;

/** "www.polar.example" and "polar.example" are one site. */
export const siteKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Normalises the seller's path list: each starts with "/", no query, no duplicates. Empty = the whole site. */
export function normalizePaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    let p = raw.trim();
    if (!p) continue;
    try {
      if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
    } catch { continue; }
    p = p.split(/[?#]/)[0];
    if (!p.startsWith("/")) p = `/${p}`;
    p = p.replace(/\/{2,}/g, "/");
    if (p.length > 1) p = p.replace(/\/$/, "");
    if (p.length <= 200) out.add(p);
  }
  return [...out].slice(0, 20);
}

/** True when `path` is one of the allowed paths or below one. */
export function underAllowed(path: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((a) => a === "/" || path === a || path.startsWith(`${a}/`));
}

type RobotRule = { allow: boolean; path: string };

/** Rules from robots.txt that apply to us (our agent's group, else "*"). */
export function parseRobots(txt: string, agent = "salesatscalebot"): RobotRule[] {
  const groups: { agents: string[]; rules: RobotRule[] }[] = [];
  let cur: { agents: string[]; rules: RobotRule[] } | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, "").match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "disallow" && m[2]) cur.rules.push({ allow: false, path: m[2] });
      if (key === "allow" && m[2]) cur.rules.push({ allow: true, path: m[2] });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  return (mine ?? groups.find((g) => g.agents.includes("*")))?.rules ?? [];
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; Allow wins a tie. No rule = allowed. */
export function robotsAllows(rules: RobotRule[], path: string): boolean {
  let best: RobotRule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export type CrawlOptions = {
  url: string;
  allowedPaths: string[];
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  limits?: Partial<typeof WEBSITE_LIMITS>;
  now?: () => number;
};

const pageKey = (u: URL) => `${siteKey(u.host)}${u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "/"}`;

type Fetched = { url: URL; res?: SafeResponse; error?: Error };

/**
 * Crawls breadth-first, a few requests at a time. Throws UnsafeUrlError when
 * the start address itself is refused; every other failure becomes a problem
 * on the result (start page and listed sections only).
 */
export async function crawlWebsite(opts: CrawlOptions): Promise<ParseResult & { lang: string | null }> {
  const limits = { ...WEBSITE_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const started = now();
  const start = parsePublicUrl(opts.url);
  const allowed = normalizePaths(opts.allowedPaths);
  const fetchOpts = { fetchImpl: opts.fetchImpl, lookup: opts.lookup, timeoutMs: limits.timeoutMs };
  const site = siteKey(start.host);
  // Problems are worth reporting only where the seller pointed us.
  const reported = (u: URL) => pageKey(u) === pageKey(start) || allowed.includes(u.pathname.replace(/\/$/, "") || "/");

  let rules: RobotRule[] = [];
  try {
    const r = await safeFetch(`${start.origin}/robots.txt`, { ...fetchOpts, maxBytes: 200_000 });
    if (r.status === 200) rules = parseRobots(r.body);
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    // No robots.txt reachable: nothing is disallowed.
  }

  const queue: URL[] = [start, ...allowed.filter((p) => p !== start.pathname).map((p) => new URL(p, start.origin))];
  const docs: URL[] = [];
  const seen = new Set<string>(queue.map(pageKey));
  const sections: ParsedSection[] = [];
  const problems: SourceProblem[] = [];
  let totalBytes = 0;
  let textChars = 0;
  let pagesRead = 0;
  let fetched = 0;
  let lang: string | null = null;
  let stopped: "time" | "size" | null = null;
  const full = () => textChars >= limits.maxTextChars || totalBytes >= limits.maxTotalBytes;

  const fetchOne = async (url: URL, maxBytes: number, accept?: string): Promise<Fetched> => {
    try {
      return { url, res: await safeFetch(url.toString(), { ...fetchOpts, maxBytes, accept }) };
    } catch (e) {
      if (e instanceof UnsafeUrlError && pageKey(url) === pageKey(start)) throw e;
      return { url, error: e as Error };
    }
  };
  const add = (locator: string, heading: string | null, text: string) => {
    const room = limits.maxTextChars - textChars;
    if (room <= 0 || !text) return false;
    const kept = text.length > room ? text.slice(0, room) : text;
    sections.push({ locator, heading, text: kept });
    textChars += kept.length;
    return true;
  };

  while (queue.length && fetched < limits.maxPages && !full()) {
    if (now() - started > limits.budgetMs) { stopped = "time"; break; }
    // Robots first (no request for a disallowed page), then a batch at a time.
    const batch: URL[] = [];
    while (queue.length && batch.length < limits.concurrency && fetched + batch.length < limits.maxPages) {
      const url = queue.shift()!;
      if (!robotsAllows(rules, url.pathname)) {
        if (reported(url)) problems.push({ where: url.pathname, message: "The website's robots.txt asks us not to read this page.", fix: "Upload the content as a file or write a note instead." });
        continue;
      }
      batch.push(url);
    }
    if (batch.length === 0) continue;
    fetched += batch.length;
    const results = await Promise.all(batch.map((u) => fetchOne(u, limits.maxPageBytes)));
    for (const { url, res, error } of results) {
      const path = url.pathname;
      if (error || !res) {
        if (reported(url)) problems.push({ where: path, message: error?.message || "The page could not be loaded.", fix: "Check the address and re-read the website." });
        continue;
      }
      totalBytes += res.bytes.byteLength;
      const final = new URL(res.url);
      if (siteKey(final.host) !== site) {
        // The start page moved to another site: say where, rather than read a site the seller did not give.
        if (pageKey(url) === pageKey(start)) problems.push({ where: start.host, message: `This address opens ${final.host}.`, fix: `Add ${final.origin} as the website instead.` });
        continue;
      }
      if (res.status !== 200) {
        if (reported(url)) problems.push({ where: path, message: `The page answered with error ${res.status}.`, fix: "Check the path or remove it from the list." });
        continue;
      }
      const ct = res.contentType.toLowerCase();
      if (ct.includes("pdf") || ct.includes("officedocument.wordprocessingml")) {
        if (docs.length < limits.maxDocs) docs.push(final);
        continue;
      }
      if (ct && !ct.includes("html") && !ct.includes("text/plain")) continue;
      const page = ct.includes("text/plain") ? { title: null, text: res.body.trim(), links: [], lang: null } : htmlToText(res.body);
      lang ??= page.lang;
      if (underAllowed(final.pathname, allowed) && add(final.pathname, page.title, page.text)) pagesRead++;
      else if (!page.text && reported(url)) {
        problems.push({ where: path, message: "This page shows no text to us (it may be built in the browser).", fix: "Upload the content as a file, or add pages that show their text." });
      }
      for (const href of page.links) {
        let next: URL;
        try { next = new URL(href, final); } catch { continue; }
        if (next.protocol !== "https:" && next.protocol !== "http:") continue;
        if (siteKey(next.host) !== site || SKIP_EXT.test(next.pathname) || !underAllowed(next.pathname, allowed)) continue;
        next.search = "";
        next.hash = "";
        const key = pageKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        if (DOC_EXT.test(next.pathname)) { if (docs.length < limits.maxDocs) docs.push(next); }
        else queue.push(next);
      }
    }
  }

  // Linked documents: their text, one section each (a document that fails is skipped).
  for (let i = 0; i < docs.length && !full(); i += limits.concurrency) {
    if (now() - started > limits.budgetMs) { stopped = "time"; break; }
    const batch = docs.slice(i, i + limits.concurrency).filter((u) => robotsAllows(rules, u.pathname));
    const results = await Promise.all(batch.map((u) => fetchOne(u, limits.maxDocBytes, "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5")));
    for (const { url, res } of results) {
      if (!res || res.status !== 200 || res.truncated) continue;
      totalBytes += res.bytes.byteLength;
      const isPdf = /\.pdf$/i.test(url.pathname) || res.contentType.toLowerCase().includes("pdf");
      try {
        const parsed = isPdf ? await parsePdf(res.bytes) : await parseDocx(res.bytes);
        const name = decodeURIComponent(url.pathname.split("/").pop() || url.pathname);
        const text = parsed.sections.map((x) => x.text).join("\n\n").trim();
        if (add(url.pathname, name, text)) pagesRead++;
      } catch {
        // Not a readable document: skipped.
      }
    }
  }

  if (sections.length === 0) {
    if (stopped === "time") problems.push({ where: start.host, message: "The website was too slow to answer.", fix: "Re-read the website later, or upload the content as a file." });
    if (problems.length === 0) problems.push({ where: start.host, message: "We found no readable text on this website.", fix: "Check the address and sections, or upload the content as a file." });
  }
  return { sections, problems, stats: { pagesRead }, lang };
}
