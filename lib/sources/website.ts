/**
 * Website sources (P8.3): reads the start page and same-host pages under the
 * allowed paths, one section per page with the path as locator.
 * Limits: 30 pages, 2 MB in total, 1 MB and 10 s per page, robots.txt
 * respected. Every request goes through safeFetch (SSRF guard).
 */
import type { SourceProblem } from "@/db/schema";
import { htmlToText } from "./html";
import { safeFetch, parsePublicUrl, UnsafeUrlError, type FetchFn, type LookupFn } from "./ssrf";
import type { ParseResult, ParsedSection } from "./text";

export const WEBSITE_LIMITS = { maxPages: 30, maxTotalBytes: 2 * 1024 * 1024, maxPageBytes: 1024 * 1024, timeoutMs: 10_000, budgetMs: 50_000 };

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|rar|7z|mp3|mp4|mov|avi|wav|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)$/i;

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

const pageKey = (u: URL) => `${u.origin}${u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "/"}`;

/**
 * Crawls breadth-first. Throws UnsafeUrlError when the start address itself
 * is refused; every other failure becomes a problem on the result.
 */
export async function crawlWebsite(opts: CrawlOptions): Promise<ParseResult & { lang: string | null }> {
  const limits = { ...WEBSITE_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const started = now();
  const start = parsePublicUrl(opts.url);
  const allowed = normalizePaths(opts.allowedPaths);
  const fetchOpts = { fetchImpl: opts.fetchImpl, lookup: opts.lookup, timeoutMs: limits.timeoutMs };

  let rules: RobotRule[] = [];
  try {
    const r = await safeFetch(`${start.origin}/robots.txt`, { ...fetchOpts, maxBytes: 200_000 });
    if (r.status === 200) rules = parseRobots(r.body);
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    // No robots.txt reachable: nothing is disallowed.
  }

  const queue: URL[] = [start, ...allowed.filter((p) => p !== start.pathname).map((p) => new URL(p, start.origin))];
  const seen = new Set<string>(queue.map(pageKey));
  const sections: ParsedSection[] = [];
  const problems: SourceProblem[] = [];
  let totalBytes = 0;
  let pagesRead = 0;
  let fetched = 0;
  let lang: string | null = null;

  while (queue.length && fetched < limits.maxPages) {
    if (now() - started > limits.budgetMs) {
      problems.push({ where: start.host, message: "We ran out of time before reading every page.", fix: "Re-read the website, or narrow it to fewer sections." });
      break;
    }
    if (totalBytes >= limits.maxTotalBytes) {
      problems.push({ where: start.host, message: "We stopped after 2 MB of pages.", fix: "Narrow the website to the sections that matter for selling." });
      break;
    }
    const url = queue.shift()!;
    const path = url.pathname;
    if (!robotsAllows(rules, path)) {
      if (url === start || allowed.includes(path)) problems.push({ where: path, message: "The website's robots.txt asks us not to read this page.", fix: "Upload the content as a file or write a note instead." });
      continue;
    }
    fetched++;
    let res;
    try {
      res = await safeFetch(url.toString(), { ...fetchOpts, maxBytes: Math.min(limits.maxPageBytes, limits.maxTotalBytes - totalBytes) });
    } catch (e) {
      if (e instanceof UnsafeUrlError && url === start) throw e;
      problems.push({ where: path, message: (e as Error).message || "The page could not be loaded.", fix: "Check the address and re-read the website." });
      continue;
    }
    totalBytes += new TextEncoder().encode(res.body).byteLength;
    const final = new URL(res.url);
    if (final.host !== start.host) continue;
    if (res.status !== 200) {
      problems.push({ where: path, message: `The page answered with error ${res.status}.`, fix: "Check the path or remove it from the list." });
      continue;
    }
    const ct = res.contentType.toLowerCase();
    if (ct && !ct.includes("html") && !ct.includes("text/plain")) continue;
    const page = ct.includes("text/plain") ? { title: null, text: res.body.trim(), links: [], lang: null } : htmlToText(res.body);
    lang ??= page.lang;
    if (res.truncated) problems.push({ where: path, message: "This page is larger than 1 MB, so we read only the first part.", fix: "Upload the content as a file if the rest matters." });
    if (underAllowed(final.pathname, allowed) && page.text) {
      sections.push({ locator: final.pathname, heading: page.title, text: page.text });
      pagesRead++;
    }
    for (const href of page.links) {
      let next: URL;
      try { next = new URL(href, final); } catch { continue; }
      if (next.protocol !== "https:" && next.protocol !== "http:") continue;
      if (next.host !== start.host || SKIP_EXT.test(next.pathname) || !underAllowed(next.pathname, allowed)) continue;
      next.search = "";
      next.hash = "";
      const key = pageKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }

  if (sections.length === 0 && problems.length === 0) {
    problems.push({ where: start.host, message: "We found no readable text on this website.", fix: "Check the address and sections, or upload the content as a file." });
  }
  return { sections, problems, stats: { pagesRead }, lang };
}
