/**
 * Server-side fetch of seller-given URLs without SSRF (P8.3).
 *
 * - Only http and https, default ports or explicit ones; no credentials in the URL.
 * - The host is resolved first and every address must be public: private,
 *   loopback, link-local, carrier-grade NAT, multicast and reserved ranges
 *   (IPv4 and IPv6, including IPv4-mapped IPv6) are refused.
 * - Redirects are followed by hand (at most 5) and each hop is checked again.
 * - Each response body is read up to a byte cap, under a timeout.
 *
 * DNS and fetch are injectable so tests never touch the network.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type LookupFn = (host: string) => Promise<string[]>;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class UnsafeUrlError extends Error {}

export const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 groups of 16 bits. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  // Trailing dotted IPv4 (e.g. ::ffff:10.0.0.1).
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address a server-side fetch must never reach. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return v4Blocked(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** Parses and checks a URL's shape. Throws UnsafeUrlError with a plain message. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Enter a full web address, like https://example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http and https addresses can be read.");
  if (url.username || url.password) throw new UnsafeUrlError("Addresses with a user name or password cannot be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("This address is not on the public internet.");
  }
  if (isIP(host) && isBlockedIp(host)) throw new UnsafeUrlError("This address is not on the public internet.");
  if (!isIP(host) && !host.includes(".")) throw new UnsafeUrlError("This address is not on the public internet.");
  url.hash = "";
  return url;
}

/** Resolves the host and refuses it unless every address is public. */
export async function assertPublicHost(url: URL, lookup: LookupFn = defaultLookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new UnsafeUrlError(`We could not find ${host}. Check the address.`);
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedIp)) throw new UnsafeUrlError("This address is not on the public internet.");
}

export type SafeResponse = {
  url: string; status: number; contentType: string; body: string; truncated: boolean;
  /** The raw bytes read (for documents: PDF, Word). */
  bytes: Uint8Array;
};

export type SafeFetchOptions = {
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Accept header; defaults to web pages. */
  accept?: string;
};

/**
 * Browser-compatible (many site firewalls refuse unknown agents) and still names
 * the bot, so robots.txt rules for SalesAtScaleBot apply and site owners can see us.
 */
export const USER_AGENT = "Mozilla/5.0 (compatible; SalesAtScaleBot/1.0; +reads pages the seller asked for)";

/** Reads a body up to `maxBytes`; decodes as UTF-8 and keeps the bytes. */
async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean; bytes: Uint8Array }> {
  if (!res.body) {
    const t = (await res.text()).slice(0, maxBytes);
    return { body: t, truncated: false, bytes: new TextEncoder().encode(t) };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(all), truncated, bytes: all };
}

/**
 * GET a public URL safely. Each redirect hop is re-checked. Throws
 * UnsafeUrlError for refused addresses and Error for network failures.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const lookup = opts.lookup ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = parsePublicUrl(raw);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url, lookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en,he;q=0.9,*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new Error("The page redirected without saying where.");
        if (hop >= maxRedirects) throw new Error("The page redirected too many times.");
        url = parsePublicUrl(new URL(location, url).toString());
        continue;
      }
      const { body, truncated, bytes } = await readCapped(res, maxBytes);
      return { url: url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body, truncated, bytes };
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw e;
      if ((e as Error).name === "AbortError") throw new Error("The page took too long to answer.");
      throw e instanceof Error && e.message ? e : new Error("The page could not be loaded.");
    } finally {
      clearTimeout(timer);
    }
  }
}
