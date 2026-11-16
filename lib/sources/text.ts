/**
 * Shared, pure helpers for source ingestion (P8.3): limits, sections, the
 * size cap, language guess and the status a parse result leads to.
 * No I/O and no AI calls.
 */
import { createHash } from "node:crypto";
import type { SourceProblem, SourceStatus } from "@/db/schema";

/** One source keeps at most this many characters of text; the rest is cut with a problem. */
export const MAX_SOURCE_CHARS = 400_000;
/** Largest file accepted for upload. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A piece of a source with a locator ("p.5", "/faq", "06:12"). */
export type ParsedSection = { locator: string; heading: string | null; text: string };

/** What a parser returns. `needsInput` marks sources the seller must act on (e.g. map columns). */
export type ParseResult = {
  sections: ParsedSection[];
  problems: SourceProblem[];
  needsInput?: boolean;
  /** Pages in a PDF, pages read on a website, rows in a sheet. */
  stats?: { pages?: number; pagesRead?: number; rows?: number; durationSec?: number };
};

/** Collapses runs of spaces, trims each line and drops repeated blank lines. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough token count (about 4 characters per token) for budgeting the pipeline. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The whole text of a source, sections separated by blank lines. */
export function joinSections(sections: ParsedSection[]): string {
  return sections.map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text)).join("\n\n");
}

/**
 * Cuts the sections so the source stays within `max` characters, and records
 * a problem when anything was cut. Empty sections are dropped.
 */
export function capSections(sections: ParsedSection[], max = MAX_SOURCE_CHARS): { sections: ParsedSection[]; problem: SourceProblem | null } {
  const out: ParsedSection[] = [];
  let used = 0;
  let cutAt: string | null = null;
  for (const s of sections) {
    if (!s.text.trim()) continue;
    const room = max - used;
    if (room <= 0) { cutAt ??= s.locator; break; }
    if (s.text.length > room) {
      out.push({ ...s, text: s.text.slice(0, room) });
      cutAt = s.locator;
      used = max;
      break;
    }
    out.push(s);
    used += s.text.length;
  }
  return {
    sections: out,
    problem: cutAt === null ? null : {
      where: cutAt,
      message: `This source is longer than ${max.toLocaleString("en")} characters, so we kept only the first part (up to ${cutAt}).`,
      fix: "Split it into smaller files, or upload only the parts that matter for selling.",
    },
  };
}

/**
 * Guesses the language from the letters used: Hebrew, Latin, or both.
 * Returns "he", "en", "en,he" or null when there are too few letters.
 */
export function guessLanguage(s: string): string | null {
  const sample = s.slice(0, 50_000);
  const he = (sample.match(/[֐-׿]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const total = he + latin;
  if (total < 20) return null;
  if (he / total > 0.8) return "he";
  if (latin / total > 0.8) return "en";
  return "en,he";
}

/**
 * The source status after a parse:
 * failed = no text at all; needs_input = the seller must act;
 * partly_failed = some text, some problems; ready = all read.
 */
export function statusFor(result: Pick<ParseResult, "sections" | "problems" | "needsInput">): SourceStatus {
  const hasText = result.sections.some((s) => s.text.trim());
  if (!hasText) return "failed";
  if (result.needsInput) return "needs_input";
  if (result.problems.length > 0) return "partly_failed";
  return "ready";
}

/** "06:12" for 372 seconds; "1:02:05" past an hour. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
