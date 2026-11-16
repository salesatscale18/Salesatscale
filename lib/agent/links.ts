/**
 * Links in agent replies (demo item 7: the order-form link in WhatsApp).
 * WhatsApp shows a link preview, and the link is easy to tap, only when the
 * URL stands on its own line. Pure; unit-tested.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Puts each link on a line of its own, and adds a link the model left out.
 * Markdown around a link (`[label](url)`, `<url>`) is dropped: WhatsApp shows it as raw text.
 */
export function linksOnOwnLine(text: string, links: string[]): string {
  let out = text;
  for (const link of [...new Set(links.filter(Boolean))]) {
    const l = escapeRe(link);
    const pattern = new RegExp(`\\[[^\\]\\n]*\\]\\(\\s*${l}\\s*\\)|<${l}>|${l}`, "g");
    if (pattern.test(out)) {
      pattern.lastIndex = 0;
      // A marker, so whitespace and line breaks around the link collapse into exactly one line break each side.
      out = out.replace(pattern, `\u0000${link}\u0000`);
    } else {
      out = `${out.trimEnd()}\n${link}`;
    }
  }
  if (out === text) return text;
  const lines = out.replace(/\s*\u0000\s*/g, "\n").split("\n").map((line) => line.trim());
  return lines
    // Punctuation left at the start of the line after a lifted link ("…here: <link>. Thanks" → "Thanks").
    .map((line, i) => (i > 0 && links.includes(lines[i - 1]) ? line.replace(/^[.,;:!?)\]]+\s*/, "") : line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
