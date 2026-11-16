/**
 * HTML to plain text for website sources: drops navigation, footers,
 * scripts and styles, keeps headings and paragraphs as lines. Pure.
 */
import { cleanText } from "./text";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", shekel: "₪", euro: "€", pound: "£", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Elements whose content is never seller knowledge. */
const DROP = ["script", "style", "noscript", "template", "svg", "iframe", "nav", "footer", "form", "button", "select", "canvas", "object"];
const BLOCK = /<\/?(p|div|section|article|main|aside|header|h[1-6]|li|ul|ol|tr|table|br|hr|dd|dt|dl|blockquote|pre|figcaption|address)\b[^>]*>/gi;

/** Inline tags vanish without a space, so "<b>2 minutes</b>." stays "2 minutes.". */
const INLINE = /<\/?(a|b|i|u|em|strong|span|small|sup|sub|code|mark|abbr|time|label)\b[^>]*>/gi;

export type HtmlPage = { title: string | null; text: string; links: string[]; lang: string | null };

export function htmlToText(html: string): HtmlPage {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const lang = s.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i)?.[1]?.toLowerCase() ?? null;
  const links = [...s.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
  s = s.replace(/<head\b[\s\S]*?<\/head>/i, " ");
  for (const tag of DROP) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  // Anything marked as navigation, a banner or a cookie notice.
  s = s.replace(/<(\w+)\b[^>]*\brole=["']?(navigation|banner|contentinfo)["']?[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(BLOCK, "\n").replace(INLINE, "").replace(/<[^>]+>/g, " ");
  const text = cleanText(decodeEntities(s)).replace(/\n{2,}/g, "\n");
  const plain = (x: string | undefined) => (x ? cleanText(decodeEntities(x.replace(/<[^>]+>/g, " "))).replace(/\n/g, " ") || null : null);
  return { title: plain(title) ?? plain(h1), text, links, lang };
}
