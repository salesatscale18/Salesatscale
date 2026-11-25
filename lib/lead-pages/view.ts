/**
 * Lead pages, seller side (slice a-2): pure helpers for the list, the add/edit
 * form and the page view. No database, no React.
 */
import type { LeadPage, LeadPageTopic } from "@/db/schema";
import type { IconName } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import { firstParam, type SearchParamsLike } from "@/lib/list-kit";
import { stepPercents } from "@/lib/overview/kpi-cards";
import { LEAD_PAGE_STATUSES, type LeadPageConnection, type LeadPageRaw, type LeadPageStatus } from "./rules";
import type { Funnel } from "./stats";
import type { ReadinessKey } from "./service";

export const CONNECTION_LABEL: Record<LeadPageConnection, MessageKey> = {
  snippet: "lead_pages.connection.snippet",
  own_form: "lead_pages.connection.own_form",
  link: "lead_pages.connection.link",
  hosted: "lead_pages.connection.hosted",
};

/** The connection cards of the add form, in the board's order. Only "Button or link" can be chosen in phase 1. */
export const CONNECTION_CARDS: { id: LeadPageConnection; icon: IconName; title: MessageKey; line: MessageKey; tag: MessageKey | null }[] = [
  { id: "snippet", icon: "panel-top", title: "lead_pages.card.snippet.title", line: "lead_pages.card.snippet.line", tag: "lead_pages.card.coming_next" },
  { id: "own_form", icon: "file-text", title: "lead_pages.card.own_form.title", line: "lead_pages.card.own_form.line", tag: "lead_pages.card.coming_next" },
  { id: "link", icon: "link-2", title: "lead_pages.card.link.title", line: "lead_pages.card.link.line", tag: null },
  { id: "hosted", icon: "globe", title: "lead_pages.card.hosted.title", line: "lead_pages.card.hosted.line", tag: "lead_pages.card.later" },
];

/** Whether our script runs where the visit happens, so visits can be counted (not for a button or link, nor the seller's own form). */
export const countsVisits = (connection: LeadPageConnection) => connection === "snippet" || connection === "hosted";

/** "polardemo.co.il/restaurants": the address without its scheme, or null. */
export const shortAddress = (address: string | null | undefined) => (address ? address.replace(/^https?:\/\//i, "").replace(/\/$/, "") : null);

/** "Israel · HE": the page market's name (or "Any market") and the form language. */
export function marketLine(page: Pick<LeadPage, "marketId" | "language">, markets: readonly { id: string; name: string }[]): string {
  const name = page.marketId ? markets.find((m) => m.id === page.marketId)?.name : null;
  return `${name ?? t("lead_pages.any_market")} · ${page.language.toUpperCase()}`;
}

/** "Name, Phone, Company": what the buyer fills in. */
export function fieldsLine(form: LeadPage["form"]): string {
  const f = form?.fields ?? {};
  const keys: MessageKey[] = ["lead_pages.form.field.name", "lead_pages.form.field.phone"];
  if (f.company) keys.push("lead_pages.form.field.company");
  if (f.email) keys.push("lead_pages.form.field.email");
  if (f.sites) keys.push("lead_pages.form.field.sites");
  return keys.map((k) => t(k)).join(", ");
}

/** The opening topic as the seller wrote it (English first, else Hebrew), or null. */
export const topicLine = (topic: LeadPageTopic | null | undefined) => topic?.en || topic?.he || null;

// ---------------------------------------------------------------------------
// List filters (URL)
// ---------------------------------------------------------------------------

export type ListFilters = { q: string | null; status: LeadPageStatus | null; marketId: string | null; days: 7 | 30 | 90 };

export function parseListFilters(params: SearchParamsLike, marketIds: readonly string[]): ListFilters {
  const status = firstParam(params, "status") ?? "";
  const marketId = firstParam(params, "market") ?? "";
  const days = firstParam(params, "days");
  return {
    q: (firstParam(params, "q") ?? "").trim().slice(0, 100) || null,
    status: (LEAD_PAGE_STATUSES as readonly string[]).includes(status) ? (status as LeadPageStatus) : null,
    marketId: marketIds.includes(marketId) ? marketId : null,
    days: days === "7" ? 7 : days === "90" ? 90 : 30,
  };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export type FunnelStep = { key: "visits" | "opens" | "leftDetails" | "startedTalking" | "gotQuote" | "ordered"; label: MessageKey; value: number | null; pct: string | null };

const FUNNEL_LABEL: Record<FunnelStep["key"], MessageKey> = {
  visits: "lead_pages.funnel.visits", opens: "lead_pages.funnel.opened", leftDetails: "lead_pages.funnel.left",
  startedTalking: "lead_pages.funnel.started", gotQuote: "lead_pages.funnel.quote", ordered: "lead_pages.funnel.ordered",
};

/**
 * The page's funnel rows. Visits are a dash (null) when our script does not run
 * where the visit happens (a button or link): the steps then start at "Opened
 * the form", and its percent is left out.
 */
export function funnelSteps(f: Funnel, connection: LeadPageConnection): FunnelStep[] {
  const keys: FunnelStep["key"][] = ["visits", "opens", "leftDetails", "startedTalking", "gotQuote", "ordered"];
  const visits = countsVisits(connection);
  const values = keys.map((k) => f[k]);
  const pcts = visits ? stepPercents(values) : [null, ...stepPercents(values.slice(1))];
  // Nothing in the step above: no percent at all (not a dash).
  return keys.map((k, i) => ({ key: k, label: FUNNEL_LABEL[k], value: k === "visits" && !visits ? null : values[i], pct: i > 0 && values[i - 1] === 0 ? null : pcts[i] }));
}

/** Whole percent of part in total as "12%", or null when total is 0. */
export const pctText = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : null);

/** Thousands separators for counts. */
export const countText = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

/** A source key ("facebook / spring") as a row label: "Direct or unknown" for "". */
export const sourceLabel = (key: string, other?: boolean) => (other ? t("lead_pages.sources.other") : key ? key : t("lead_pages.sources.direct"));

export const READINESS_LABEL: Record<ReadinessKey, MessageKey> = {
  privacy_notice: "lead_pages.check.privacy_notice",
  account_live: "lead_pages.check.account_live",
  form_opens: "lead_pages.check.form_opens",
  test_lead: "lead_pages.check.test_lead",
};

// ---------------------------------------------------------------------------
// The add/edit form
// ---------------------------------------------------------------------------

type FormGet = { get(name: string): FormDataEntryValue | null; has(name: string): boolean };
const str = (f: FormGet, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * The page settings from the add/edit form. The opening topic is the index of
 * a playbook topic ("" none, "keep" the page's saved one), so the saved text is
 * the playbook's own en/he snapshot. Settings the form does not show in phase 1
 * (extra origins, the page-pixel switch) keep the page's values.
 */
export function rawFromForm(f: FormGet, topics: readonly LeadPageTopic[], existing: LeadPage | null): LeadPageRaw {
  const topicRaw = str(f, "openingTopic");
  const i = /^\d+$/.test(topicRaw) ? Number(topicRaw) : -1;
  const openingTopic = topicRaw === "keep" ? existing?.openingTopic ?? null : i >= 0 && i < topics.length ? topics[i] : null;
  return {
    name: str(f, "name"),
    address: str(f, "address"),
    connection: str(f, "connection") || "link",
    language: str(f, "language"),
    marketId: str(f, "marketId"),
    fields: { company: f.has("field_company"), email: f.has("field_email"), sites: f.has("field_sites") },
    consentTicked: f.has("consentTicked"),
    openingTopic,
    tracking: {
      ...(existing?.tracking?.tellPagePixel === undefined ? {} : { tellPagePixel: existing.tracking.tellPagePixel }),
      carryAdDetails: f.has("carryAdDetails"),
    },
    extraOrigins: existing?.extraOrigins ?? [],
  };
}

/** The form's topic select value for a page: the index of its saved topic in the playbook, "keep" when it is no longer there, "" for none. */
export function topicChoice(saved: LeadPageTopic | null | undefined, topics: readonly LeadPageTopic[]): string {
  if (!saved) return "";
  const i = topics.findIndex((x) => (x.en || "") === (saved.en || "") && (x.he || "") === (saved.he || ""));
  return i >= 0 ? String(i) : "keep";
}

/** Banner refusal reasons as the seller reads them. */
export const BANNER_ERROR: Record<string, MessageKey> = {
  too_large: "lead_pages.banner.too_large",
  empty: "lead_pages.banner.empty",
  not_an_image: "lead_pages.banner.not_an_image",
  preview: "lead_pages.banner.preview",
  no_store: "lead_pages.banner.no_store",
  store_failed: "lead_pages.banner.store_failed",
  not_found: "lead_pages.not_found",
};
