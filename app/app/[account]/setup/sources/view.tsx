/**
 * Shared bits of the Sources pages: the type badge, the size line and the
 * language words. Server-safe (no hooks).
 */
import type { Source } from "@/db/schema";
import { isLocale, t } from "@/lib/i18n";
import { formatClock } from "@/lib/sources/text";

type Row = Pick<Source, "kind" | "title" | "origin" | "stats" | "language">;

const BADGES: Record<string, { label: string; mod: string }> = {
  website: { label: "WEB", mod: "web" },
  text: { label: "NOTE", mod: "note" },
  call: { label: "CALL", mod: "call" },
  pdf: { label: "PDF", mod: "pdf" },
  docx: { label: "DOC", mod: "doc" },
  xlsx: { label: "XLS", mod: "xls" },
  csv: { label: "CSV", mod: "xls" },
  md: { label: "MD", mod: "note" },
  txt: { label: "TXT", mod: "note" },
};

export function badgeFor(s: Pick<Row, "kind" | "origin" | "title">) {
  if (s.kind !== "file") return BADGES[s.kind];
  const ext = (s.origin.fileName ?? s.title).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return BADGES[ext] ?? { label: "FILE", mod: "note" };
}

export function SourceBadge({ source }: { source: Pick<Row, "kind" | "origin" | "title"> }) {
  const b = badgeFor(source);
  return <span className={`sas-file-badge sas-file-badge--${b.mod}`} aria-hidden="true">{b.label}</span>;
}

const n = (x: number) => x.toLocaleString("en");

/** "24 pages read", "14 pages", "11 rows", "18 min", "1,240 characters". */
export function sizeLine(s: Pick<Row, "kind" | "stats" | "origin">): string {
  const st = s.stats ?? {};
  if (s.kind === "website") return t("sources.size.pages_read", { n: n(st.pagesRead ?? 0) });
  if (s.kind === "call" && s.origin.durationSec) return t("sources.size.duration", { time: formatClock(s.origin.durationSec) });
  if (st.pages) return t("sources.size.pages", { n: n(st.pages) });
  if (st.rows) return t("sources.size.rows", { n: n(st.rows) });
  return t("sources.size.chars", { n: n(st.chars ?? 0) });
}

/** "English, Hebrew" from "en,he"; unknown codes as they are; "—" when not known. */
export function languageWords(code: string | null): string {
  if (!code) return "—";
  return code.split(",").map((c) => (isLocale(c) ? t(`lang.${c}`) : c)).join(", ");
}

/** File size in KB or MB. */
export function fileSize(bytes: number | undefined): string | null {
  if (!bytes) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
