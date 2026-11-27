/**
 * A spoken line the buyer cut short, as stored and shown: the words played, then ONE "…" right after the last word
 * (owner, 26 Nov 2026). Sentence punctuation the line had at that point (. , ; : ! ? and dashes, Hebrew's maqaf,
 * Arabic and full-width marks) and any "…" or "..." already there go first, so a cut never reads "₪100.00.…" or "……".
 * Pure, no server imports: the relay (lib/voice/engine.ts) stores it, the buyer chat shows it (lib/voice/client/live-text.ts).
 */
const TRAILING = /[\s.,;:!?…–—־،؛؟。！，？-]+$/u;

export function cutLine(s: string): string {
  return `${s.trim().replace(TRAILING, "")}…`;
}
