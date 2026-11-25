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

/** The connection cards of the add form, in the board's order. "Our form on your page", "Your own form" and "Button or link" can be chosen; a card with a tag cannot. */
export const CONNECTION_CARDS: { id: LeadPageConnection; icon: IconName; title: MessageKey; line: MessageKey; tag: MessageKey | null }[] = [
  { id: "snippet", icon: "panel-top", title: "lead_pages.card.snippet.title", line: "lead_pages.card.snippet.line", tag: null },
  { id: "own_form", icon: "file-text", title: "lead_pages.card.own_form.title", line: "lead_pages.card.own_form.line", tag: null },
  { id: "link", icon: "link-2", title: "lead_pages.card.link.title", line: "lead_pages.card.link.line", tag: null },
  { id: "hosted", icon: "globe", title: "lead_pages.card.hosted.title", line: "lead_pages.card.hosted.line", tag: "lead_pages.card.later" },
];

/** Whether our script runs where the visit happens, so visits can be counted (not for a button or link, nor the seller's own form). */
export const countsVisits = (connection: LeadPageConnection) => connection === "snippet" || connection === "hosted";
/** Whether opening the form can be counted: not on the seller's own form (our script is not there). */
export const countsOpens = (connection: LeadPageConnection) => connection !== "own_form";

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
 * where the visit happens (a button or link, the seller's own form), and so is
 * "Opened the form" on the seller's own form: the steps then start at the first
 * counted one, and its percent is left out.
 */
export function funnelSteps(f: Funnel, connection: LeadPageConnection): FunnelStep[] {
  const keys: FunnelStep["key"][] = ["visits", "opens", "leftDetails", "startedTalking", "gotQuote", "ordered"];
  const start = countsVisits(connection) ? 0 : countsOpens(connection) ? 1 : 2;
  const values = keys.map((k) => f[k]);
  const pcts = [...Array<null>(start).fill(null), ...stepPercents(values.slice(start))];
  // Nothing in the step above: no percent at all (not a dash).
  return keys.map((k, i) => ({ key: k, label: FUNNEL_LABEL[k], value: i < start ? null : values[i], pct: i > 0 && values[i - 1] === 0 ? null : pcts[i] }));
}

/** Nothing at all in the period (no visit, open or lead): the page view shows one line instead of empty bars. */
export const funnelEmpty = (steps: readonly FunnelStep[]) => steps.every((s) => !s.value);

/** The snippet the seller pastes: the placeholder, then the script (async, from our host). */
export function snippetCode(appBase: string, publicKey: string): string {
  return `<div data-sas-lead-form="${publicKey}"></div>\n<script async src="${appBase.replace(/\/+$/, "")}/lp/v1.js"></script>`;
}

/** The address the seller's own form sends to (method post). */
export const ownFormAction = (appBase: string, publicKey: string) => `${appBase.replace(/\/+$/, "")}/api/lp/${publicKey}/submit`;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A ready HTML example of the seller's own form: name, phone, the consent box with
 * the given line, the hidden honeypot field and the send button, posting to our address.
 * `labels`: the field labels in the form's language (our own form's). `preview`: a test code, added as a hidden field.
 */
export function ownFormExample(action: string, consentLine: string, labels: { name: string; phone: string; send: string }, preview?: string | null): string {
  return [
    `<form method="post" action="${escAttr(action)}">`,
    `  <label>${escAttr(labels.name)} <input name="name" autocomplete="name" required></label>`,
    `  <label>${escAttr(labels.phone)} <input name="phone" type="tel" autocomplete="tel" required></label>`,
    `  <label><input type="checkbox" name="consent" value="yes"> ${escAttr(consentLine)}</label>`,
    `  <input name="sas_url" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">`,
    ...(preview ? [`  <input type="hidden" name="preview" value="${escAttr(preview)}">`] : []),
    `  <button type="submit">${escAttr(labels.send)}</button>`,
    `</form>`,
  ].join("\n");
}

/** The test code as the hidden field the seller adds to their form. */
export const ownFormPreviewField = (token: string) => `<input type="hidden" name="preview" value="${escAttr(token)}">`;

/** The snippet's preview link: the seller's page with the preview token in its fragment (never sent to any server). */
export function snippetPreviewUrl(address: string, token: string): string {
  return `${address.replace(/#.*$/, "")}#sas-preview=${token}`;
}

/** The refused origin to suggest ("Seen on {host}. Add it?"): its host, unless the page already allows it. */
export function seenOriginSuggestion(page: Pick<LeadPage, "address" | "extraOrigins" | "checks">): string | null {
  const o = page.checks?.refusedOrigin;
  if (!o) return null;
  let host: string;
  try {
    host = new URL(o).host;
  } catch {
    return null;
  }
  if (page.extraOrigins.includes(host)) return null;
  const own = page.address ? (() => { try { return new URL(page.address).host; } catch { return null; } })() : null;
  if (own && (own === host || own === `www.${host}` || host === `www.${own}`)) return null;
  return host;
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
  snippet_seen: "lead_pages.check.snippet_seen",
  own_form_lead: "lead_pages.check.own_form_lead",
  test_lead: "lead_pages.check.test_lead",
};

// ---------------------------------------------------------------------------
// The add/edit form
// ---------------------------------------------------------------------------

type FormGet = { get(name: string): FormDataEntryValue | null; getAll?(name: string): FormDataEntryValue[]; has(name: string): boolean };
const str = (f: FormGet, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * The page settings from the add/edit form. The opening topic is the index of
 * a playbook topic ("" none, "keep" the page's saved one), so the saved text is
 * the playbook's own en/he snapshot. Other addresses (slice b): the saved ones
 * still ticked (`extraOrigin`), plus a typed one (`newOrigin`) and the
 * "Seen on …, add it?" suggestion when ticked (`addSeen`).
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
    tracking: { tellPagePixel: f.has("tellPagePixel"), carryAdDetails: f.has("carryAdDetails") },
    extraOrigins: originsFromForm(f, existing),
  };
}

/** The other addresses from the form: the saved ones left ticked, then the suggested and the typed one. */
function originsFromForm(f: FormGet, existing: LeadPage | null): string[] {
  const saved = existing?.extraOrigins ?? [];
  // A form without the list (an older page) keeps what is saved.
  if (!f.has("originsShown")) return [...saved];
  const kept = (f.getAll?.("extraOrigin") ?? []).filter((v): v is string => typeof v === "string").filter((v) => saved.includes(v));
  const out = [...kept];
  for (const v of [str(f, "addSeen"), str(f, "newOrigin")]) if (v.trim()) out.push(v.trim());
  return out;
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
