/**
 * Sales call transcripts (P8.3): WebVTT, SRT, or pasted text with "Rep:" /
 * "Buyer:" speaker labels and/or times. Turns become sections with "mm:ss"
 * locators. Personal data is masked before anything is returned. Pure.
 * Audio recordings are not handled here (a later step).
 */
import { maskPersonalData } from "./mask";
import { chunkText } from "./files";
import { cleanText, formatClock, type ParseResult, type ParsedSection } from "./text";

export type TranscriptLine = { at: number | null; who: string | null; text: string };

/** "05:31", "1:05:31", "00:05:31.250", "00:05:31,250" → seconds. */
export function parseClock(s: string): number | null {
  const m = s.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?$/);
  if (!m) return null;
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (ss > 59 || (m[1] !== undefined && mm > 59)) return null;
  return h * 3600 + mm * 60 + ss;
}

const CUE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
/** "Rep: text" (a short label of letters, spaces, dots or dashes). */
const LABEL = /^([A-Za-z֐-׿][A-Za-z֐-׿0-9 .'_-]{0,29}?)\s*:\s+(.*)$/;
/** "[05:31] text", "05:31 text", "(05:31) - text". */
const STAMP = /^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—]?\s*(.*)$/;

function speaker(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, " ");
  const lower = s.toLowerCase();
  if (["rep", "seller", "sales", "agent", "salesperson"].includes(lower)) return "Rep";
  if (["buyer", "customer", "client", "prospect", "lead"].includes(lower)) return "Buyer";
  return s.slice(0, 30);
}

/** Splits "Rep: hi" or a VTT voice tag into speaker and text. */
function splitSpeaker(text: string): { who: string | null; text: string } {
  const v = text.match(/^<v(?:\.[^\s>]+)?\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
  if (v) return { who: speaker(v[1]), text: v[2] };
  const l = text.match(LABEL);
  if (l && !/^(https?|www)$/i.test(l[1])) return { who: speaker(l[1]), text: l[2] };
  return { who: null, text };
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

/** WebVTT or SRT cues. */
function parseCues(raw: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const blocks = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    const i = lines.findIndex((l) => CUE.test(l));
    if (i < 0) continue;
    const at = parseClock(lines[i].match(CUE)![1]);
    const body = lines.slice(i + 1).join(" ").trim();
    if (!body) continue;
    const { who, text } = splitSpeaker(body);
    out.push({ at, who, text: stripTags(text).trim() });
  }
  return out;
}

/** Pasted or .txt transcripts: one turn per labelled or stamped line; other lines continue the turn. */
function parseLines(raw: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const rawLine of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let at: number | null = null;
    let rest = line;
    const st = line.match(STAMP);
    if (st && parseClock(st[1]) !== null) { at = parseClock(st[1]); rest = st[2]; }
    const { who, text } = splitSpeaker(rest);
    if (at === null && who === null && out.length) {
      out[out.length - 1].text += ` ${line}`;
      continue;
    }
    // A stamp line may carry the speaker on its own ("05:31 Rep"), with the words on the next line.
    out.push({ at, who, text: text.trim() });
  }
  return out.filter((l) => l.text || l.who);
}

/** Joins consecutive cues of the same speaker (subtitles split sentences). */
function mergeTurns(lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && l.who && prev.who === l.who && prev.text.length < 600) prev.text = `${prev.text} ${l.text}`.trim();
    else out.push({ ...l });
  }
  return out;
}

export function parseTranscriptLines(raw: string): TranscriptLine[] {
  const isCues = /^﻿?WEBVTT/.test(raw.trimStart()) || raw.split(/\r?\n/).slice(0, 6).some((l) => CUE.test(l));
  const lines = isCues ? mergeTurns(parseCues(raw)) : parseLines(raw);
  return lines.map((l) => ({ ...l, text: maskPersonalData(cleanText(l.text).replace(/\n/g, " ")) }));
}

/**
 * A transcript as sections: one per turn, locator "mm:ss" (or "#n" without
 * times), heading = speaker. Text is masked. Without labels or times the
 * text is kept in parts and a problem says so.
 */
export function parseTranscript(raw: string): ParseResult {
  const lines = parseTranscriptLines(raw);
  const structured = lines.some((l) => l.at !== null || l.who !== null);
  if (!structured) {
    const text = maskPersonalData(cleanText(raw));
    const parts = text ? chunkText(text) : [];
    return {
      sections: parts.map((p, i) => ({ locator: `part ${i + 1}`, heading: null, text: p })),
      problems: parts.length ? [{ where: "transcript", message: "We found no speaker labels or times, so suggestions cannot point to a moment in the call.", fix: "Start each line with Rep: or Buyer:, or with the time (05:31)." }] : [],
    };
  }
  const sections: ParsedSection[] = lines.map((l, i) => ({ locator: l.at !== null ? formatClock(l.at) : `#${i + 1}`, heading: l.who, text: l.text || "…" }));
  const times = lines.map((l) => l.at).filter((x): x is number => x !== null);
  return { sections, problems: [], stats: times.length ? { durationSec: Math.max(...times) } : {} };
}

/** File types a transcript upload accepts. */
export const TRANSCRIPT_ACCEPT = ".txt,.vtt,.srt,.docx";
