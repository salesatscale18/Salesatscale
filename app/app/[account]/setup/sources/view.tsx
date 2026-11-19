/**
 * Shared bits of the Sources pages: the type badge, the size line and the
 * language words. Server-safe (no hooks).
 */
import type { Source } from "@/db/schema";
import { isLocale, messages, t, type MessageKey } from "@/lib/i18n";

/** `key` with {count} filled, or its `_one` form ("1 section") when count is 1 and that key exists. */
export function plural(key: MessageKey, count: number): string {
  const one = `${key}_one` as MessageKey;
  return t(count === 1 && messages.en[one] ? one : key, { count: count.toLocaleString("en"), n: count.toLocaleString("en") });
}
import { formatClock } from "@/lib/sources/text";
import { Icon, type IconName } from "@/components/sas/icon";

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
  if (s.kind === "website") return (st.pagesRead ?? 0) === 1 ? t("sources.size.pages_read_one") : t("sources.size.pages_read", { n: n(st.pagesRead ?? 0) });
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

/**
 * The locator chip of a section or fact, or null when it says nothing: a
 * note is one section with the locator "note" (the page already says it is a note).
 */
export function shownLocator(kind: string, locator: string | null | undefined): string | null {
  if (!locator) return null;
  if (kind === "text" && locator.trim().toLowerCase() === "note") return null;
  return locator;
}

/** File size in KB or MB. */
export function fileSize(bytes: number | undefined): string | null {
  if (!bytes) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The icon for each source type (list rows, detail header, add tiles). */
export const KIND_ICON = { website: "globe", file: "file-text", text: "sticky-note", call: "phone-call" } as const satisfies Record<Row["kind"], IconName>;

/** The type icon in a small square, before a source's title. */
export function SourceIcon({ kind }: { kind: Row["kind"] }) {
  return (
    <span aria-hidden="true" style={{ flex: "none", display: "inline-grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-md)", background: "var(--surface-sunken)", color: "var(--ink-muted)" }}>
      <Icon name={KIND_ICON[kind]} />
    </span>
  );
}

/** "12 Nov 2026" from a call date ("2026-11-12"). */
export function callDateText(iso: string | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
}

/**
 * The detail line under a source's title in the list: "Website · 14 pages read
 * · /products /faq", "Call · 02:22 long · rep: Dana · 12 Nov 2026", "File · could
 * not be read".
 */
export function detailLine(s: Pick<Source, "kind" | "stats" | "origin" | "status">): string {
  const parts: string[] = [t(`sources.kind.${s.kind}`)];
  if (s.status === "failed") parts.push(t("sources.size.failed"));
  else if (s.status !== "processing") parts.push(sizeLine(s));
  if (s.kind === "website" && s.origin.allowedPaths?.length) parts.push(s.origin.allowedPaths.join(" "));
  if (s.kind === "call") {
    if (s.origin.rep) parts.push(t("sources.call.rep_is", { rep: s.origin.rep }));
    const d = callDateText(s.origin.callDate);
    if (d) parts.push(d);
  }
  return parts.join(" · ");
}
