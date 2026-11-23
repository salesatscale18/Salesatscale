import type { ReactNode } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { contactHoursOrDefault, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { ContactHoursFields } from "@/components/sas/contact-hours-fields";
import { countLeadsByMarket, listIntakeKeys } from "@/lib/leads/service";
import { legalByLanguage, marketLegal } from "@/lib/markets/legal";
import { canGoLive, checkCount, countryName, formCountryLabels, type GoLiveCheckKey } from "@/lib/markets/rules";
import { ensureHomeMarket, getMarketView, listMarkets, type MarketView } from "@/lib/markets/service";
import type { AccountDefaults, EffectiveSettings, SettingKey } from "@/lib/markets/settings";
import { marketOptionLabel } from "@/components/sas/market-switcher";
import { AutoSubmit } from "@/components/sas/auto-submit";
import { listPriceLists } from "@/lib/pricing/price-lists";
import { currencyLabel, localDateIso, timezoneLabel } from "@/lib/format";
import { LOCALES, t, type MessageKey } from "@/lib/i18n";
import { leadTimeText, MAX_LEAD_DAYS, weekendFor } from "@/lib/delivery/eta";
import type { LeadIntakeKey, Market } from "@/db/schema";
import {
  addMarketAction, overrideSettingAction, resetSettingAction, setMarketStatusAction, setPriceListAction, updateWhereAction,
} from "./actions";
import "./markets.css";
import { HolidaysField } from "./holidays-field";
import { holidaysText } from "./form";
import { checkStateWord, WhatsAppStatusPill } from "../settings/whatsapp-status";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const langNames = (ls: string[]) => ls.map((l) => LANG_NAME[l] ?? l).join(", ");

/**
 * Settings the account holds a default for: "Different here" + Reset when the market has its own value.
 * Holidays are left out: the account has none, so they belong to the market itself (no tag, no Reset).
 */
const INHERITED: SettingKey[] = ["languages", "timezone", "contactHours", "paymentMethods", "bankDetails", "leadTime"];

/** Short check labels for the readiness strip (canvas: MarketsV2). */
const CHECK_SHORT: Record<GoLiveCheckKey, MessageKey> = {
  where: "markets.check_short.where",
  price_list: "markets.check_short.price_list",
  legal_texts: "markets.check_short.legal_texts",
  payment_methods: "markets.check_short.payment_methods",
  whatsapp: "markets.check_short.whatsapp",
};

const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** "Friday, Saturday": the weekend business days skip in a market. */
const weekendText = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => t(`settings.hours.day.${DAY_SHORT[d]}` as MessageKey)).join(", ");

/** One setting's effective value in words. */
function describe<K extends SettingKey>(key: K, value: AccountDefaults[K]): string {
  switch (key) {
    case "languages": return langNames(value as string[]);
    case "timezone": return timezoneLabel(value as string);
    case "contactHours": return summarizeContactHours(value as AccountDefaults["contactHours"]);
    case "paymentMethods": {
      const pm = value as AccountDefaults["paymentMethods"];
      return [pm.card ? t("golive.method.card") : null, pm.bankTransfer ? t("golive.method.bank") : null].filter(Boolean).join(", ") || t("markets.none");
    }
    case "bankDetails": return (value as string | null)?.trim() || t("markets.none");
    case "holidays": return holidaysText(value as string[], localDateIso(new Date(), "UTC"));
    case "leadTime": {
      const lt = value as AccountDefaults["leadTime"];
      return lt ? leadTimeText(lt) : t("markets.lead_time_not_set");
    }
  }
  return "";
}

/** "Mon–Thu 09:00–17:30 · Fri 09:00–16:00": each part on one line, breaking only at " · " (R5-7). */
function KeepParts({ text }: { text: string }) {
  return <>{text.split(" · ").map((p, i) => <span key={i}>{i > 0 ? " · " : null}<span className="sas-nowrap">{p}</span></span>)}</>;
}

/** "Different here": the market has its own value (Trust Blue soft tint, R5-10). Shown only on rows that differ. */
const DiffTag = () => <span className="mk-diff" data-source="market">{t("markets.different_here")}</span>;

/**
 * One row of a settings card (canvas: MarketsV2): label (muted, 132px) · value · action, close together.
 * `tag` follows the value ("Different here"); `note` is a small line under it.
 */
function Row({ label, value, tag, note, action, muted, id }: { label: string; value: ReactNode; tag?: ReactNode; note?: ReactNode; action?: ReactNode; muted?: boolean; id?: string }) {
  return (
    <div id={id} className="mk-row">
      <span className="mk-row__label">{label}</span>
      <span className="mk-row__value">
        <span style={muted ? { color: "var(--ink-muted)" } : undefined}>{value}</span>
        {tag ? <>{" "}{tag}</> : null}
        {note ? <span className="sas-small" style={{ display: "block", marginBlockStart: 2 }}>{note}</span> : null}
      </span>
      <span className="mk-row__act" data-row-end="">{action}</span>
    </div>
  );
}

/** A grouped card ("Where", "Money", ...). */
function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="sas-panel mk-card" aria-labelledby={id} data-card={id}>
      <h3 id={id} className="mk-card__h">{title}</h3>
      {children}
    </section>
  );
}

/** Muted text in the action column for a row that cannot differ per market. */
const AccountWide = () => <span className="mk-row__note" data-account-wide="">{t("markets.account_wide")}</span>;

/** The form that sets a market's own value for one setting, prefilled with the current effective value. */
function OverrideForm({ slug, market, settingKey, settings, timezones, weekend }: { slug: string; market: Market; settingKey: SettingKey; settings: EffectiveSettings; timezones: string[]; weekend: number[] }) {
  const v = settings[settingKey].value;
  let fields: ReactNode = null;
  switch (settingKey) {
    case "languages":
      fields = (
        <fieldset className="sas-checks" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sas-sr">{t("markets.setting.languages")}</legend>
          {LOCALES.map((l) => (
            <label key={l} className="sas-check"><input type="checkbox" name="languages" value={l} defaultChecked={(v as string[]).includes(l)} />{t(`lang.${l}`)}</label>
          ))}
        </fieldset>
      );
      break;
    case "timezone":
      fields = (
        <select className="sas-select" name="timezone" defaultValue={v as string} aria-label={t("markets.setting.timezone")}>
          {timezones.map((tz) => <option key={tz} value={tz}>{timezoneLabel(tz)}</option>)}
        </select>
      );
      break;
    case "contactHours": {
      const hours = contactHoursOrDefault(v as AccountDefaults["contactHours"]);
      fields = <ContactHoursFields hours={hours} />;
      break;
    }
    case "paymentMethods": {
      const pm = v as AccountDefaults["paymentMethods"];
      fields = (
        <fieldset className="sas-checks" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sas-sr">{t("markets.setting.paymentMethods")}</legend>
          <label className="sas-check"><input type="checkbox" name="card" defaultChecked={pm.card} />{t("golive.method.card")}</label>
          <label className="sas-check"><input type="checkbox" name="bankTransfer" defaultChecked={pm.bankTransfer} />{t("golive.method.bank")}</label>
        </fieldset>
      );
      break;
    }
    case "bankDetails":
      fields = <textarea className="sas-textarea" name="bankDetails" rows={3} maxLength={500} defaultValue={(v as string | null) ?? ""} aria-label={t("markets.setting.bankDetails")} />;
      break;
    case "holidays":
      // A date field with "Add date" and the chosen dates (client); the form still sends a list of dates.
      fields = (
        <HolidaysField
          initial={v as string[]}
          labels={{
            field: t("markets.holiday_field"), add: t("markets.holiday_add"), remove: t("markets.holiday_remove", { date: "{date}" }),
            empty: t("markets.holidays_empty"), invalid: t("markets.holiday_invalid", { format: "{format}" }),
          }}
        />
      );
      break;
    case "leadTime": {
      const lt = v as AccountDefaults["leadTime"];
      fields = (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px" }}>
            <legend className="sas-sr">{t("markets.setting.leadTime")}</legend>
            <span>{t("markets.setting.leadTime")}: {t("company.delivery.from")}</span>
            <input className="sas-input sas-num" type="number" name="minDays" min={0} max={MAX_LEAD_DAYS} step={1} inputMode="numeric" required defaultValue={lt ? lt.minDays : ""} aria-label={t("company.delivery.min_label")} style={{ width: 88 }} />
            <span>{t("company.delivery.to")}</span>
            <input className="sas-input sas-num" type="number" name="maxDays" min={0} max={MAX_LEAD_DAYS} step={1} inputMode="numeric" required defaultValue={lt ? lt.maxDays : ""} aria-label={t("company.delivery.max_label")} style={{ width: 88 }} />
            <span>{t("company.delivery.days")}</span>
          </fieldset>
          <label className="sas-check"><input type="checkbox" name="businessDays" defaultChecked={lt ? lt.businessDays : true} />{t("company.delivery.business")}</label>
          <span className="sas-hint">{t("markets.lead_time_weekend", { days: weekendText(weekend) })} {t("markets.lead_time_hint")}</span>
        </>
      );
      break;
    }
  }
  return (
    <form action={overrideSettingAction} className="sas-stack-2 mk-edit" data-override-form={settingKey}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="marketId" value={market.id} />
      <input type="hidden" name="key" value={settingKey} />
      <span className="sas-small">{settingKey === "holidays" ? t("markets.holidays_intro", { market: market.name }) : t("markets.override_intro", { market: market.name })}</span>
      {fields}
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="submit" variant="primary" size="sm">{t("markets.save_override")}</Button>
        <a className={buttonClass("ghost", "sm")} href={`?m=${market.id}`}>{t("markets.cancel")}</a>
      </div>
    </form>
  );
}

function WhereForm({ slug, market, keys }: { slug: string; market: Market | null; keys: LeadIntakeKey[] }) {
  const isNew = !market;
  return (
    <form action={isNew ? addMarketAction : updateWhereAction} className={isNew ? "sas-stack-4" : "sas-stack-4 mk-edit"} style={isNew ? { padding: "14px 20px", borderTop: "1px solid var(--line)" } : undefined} data-where-form={isNew ? "new" : market.id}>
      <input type="hidden" name="slug" value={slug} />
      {market ? <input type="hidden" name="marketId" value={market.id} /> : null}
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="mk-name">{t("markets.field.name")}<span className="sas-req" aria-hidden="true">*</span></label>
          <input className="sas-input" id="mk-name" name="name" required maxLength={80} defaultValue={market?.name ?? ""} />
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="mk-countries">{t("markets.field.countries")}</label>
          <input className="sas-input" id="mk-countries" name="countries" defaultValue={market?.countries.join(", ") ?? ""} aria-describedby="mk-countries-hint" />
          <span className="sas-hint" id="mk-countries-hint">{t("markets.field.countries_hint")}</span>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="mk-prefixes">{t("markets.field.phone_prefixes")}</label>
          <input className="sas-input sas-num" id="mk-prefixes" name="phonePrefixes" dir="ltr" defaultValue={market?.phonePrefixes.join(", ") ?? ""} aria-describedby="mk-prefixes-hint" />
          <span className="sas-hint" id="mk-prefixes-hint">{t(isNew ? "markets.field.phone_prefixes_new_hint" : "markets.field.phone_prefixes_hint")}</span>
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="mk-form">{t("markets.field.form_values")}</label>
          <input className="sas-input" id="mk-form" name="formCountryValues" defaultValue={market?.formCountryValues.join(", ") ?? ""} aria-describedby="mk-form-hint" />
          <span className="sas-hint" id="mk-form-hint">{t("markets.field.form_values_hint")}</span>
        </div>
      </div>
      {market ? (
        <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sas-input-label">{t("markets.field.intake_keys")}</legend>
          {keys.length === 0 ? <span className="sas-small">{t("markets.field.intake_keys_none")}</span> : (
            <div className="sas-checks">
              {keys.map((k) => (
                <label key={k.id} className="sas-check"><input type="checkbox" name="intakeKeyIds" value={k.id} defaultChecked={market.intakeKeyIds.includes(k.id)} />{k.name}</label>
              ))}
            </div>
          )}
          <span className="sas-hint">{t("markets.field.intake_keys_hint")}</span>
        </fieldset>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="submit" variant="primary" size="sm">{t(isNew ? "markets.add_submit" : "markets.save")}</Button>
        <a className={buttonClass("ghost", "sm")} href={market ? `?m=${market.id}` : "?"}>{t("markets.cancel")}</a>
      </div>
    </form>
  );
}

const STATUS_ERROR: Record<string, MessageKey> = {
  checks_failed: "markets.status_error.checks_failed",
  not_allowed: "markets.status_error.not_allowed",
  not_found: "markets.status_error.not_found",
};

/** "16 leads" / "1 lead". */
const leadsText = (n: number) => (n === 1 ? t("markets.leads_one") : t("markets.leads_count", { count: n }));

/** Settings › Markets (canvas: MarketsV2). Each market starts from the account defaults and changes only what differs. */
export default async function MarketsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account } = access;
  // Accounts made before markets existed get their home market the first time this screen opens.
  const home = await ensureHomeMarket(appDb, account.id, actorOf(access));
  const [all, lists, keys, leadCounts] = await Promise.all([
    listMarkets(appDb, account.id),
    listPriceLists(appDb, account.id),
    listIntakeKeys(appDb, account.id),
    countLeadsByMarket(appDb, account.id, home!.id),
  ]);
  const views = new Map<string, MarketView>();
  for (const v of await Promise.all(all.map((m) => getMarketView(appDb, account.id, m.id)))) if (v) views.set(v.market.id, v);

  const adding = one(sp.add) === "1";
  const selected = all.find((m) => m.id === one(sp.m)) ?? all[0];
  const view = selected ? views.get(selected.id)! : null;
  const editing = one(sp.edit);
  const overriding = one(sp.override);
  const error = one(sp.error);
  const saved = one(sp.saved) || one(sp.reset);
  const statusError = STATUS_ERROR[one(sp.status_error)];
  const base = `/app/${account.slug}`;
  const here = `${base}/markets`;
  const keyName = (id: string) => keys.find((k) => k.id === id)?.name;
  const allLegal = selected && view ? await marketLegal(appDb, account.id, selected.id) : [];
  const legal = view ? allLegal.filter((s) => view.settings.languages.value.includes(s.language)) : [];
  // R5-7: the section order comes from every language's texts, so a one-language market lists them as the others do.
  const legalOrder = [...new Set(allLegal.map((s) => s.sectionKey))];
  const ownLegal = legal.filter((s) => s.source === "market").length;
  const timezones = overriding === "timezone" ? Intl.supportedValuesOf("timeZone") : [];
  // The rows tagged "Different here": the settings with the market's own value, and the legal texts when some are its own.
  const differ = view ? INHERITED.filter((k) => view.settings[k].source === "market").length + (ownLegal > 0 ? 1 : 0) : 0;

  /** One inherited setting: value; "Different here" + Reset + Change when it differs, else only Change. */
  const settingRow = (k: SettingKey) => {
    if (!selected || !view) return null;
    const s = view.settings[k];
    const formHref = `${here}?m=${selected.id}&override=${k}#set-${k}`;
    const own = s.source === "market";
    const text = describe(k, s.value as AccountDefaults[typeof k]);
    return (
      <div key={k} data-setting={k}>
        <Row
          id={`set-${k}`}
          label={t(`markets.setting.${k}` as MessageKey)}
          value={k === "contactHours" ? <KeepParts text={text} /> : text}
          tag={own ? <DiffTag /> : null}
          action={
            <>
              {own ? (
                // Reset follows the account again; Change opens the same form, prefilled with the market's value.
                <form action={resetSettingAction} style={{ display: "inline" }}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="marketId" value={selected.id} />
                  <input type="hidden" name="key" value={k} />
                  <button type="submit" className="mk-act" data-reset-setting={k}>{t("markets.reset")}</button>
                </form>
              ) : null}
              {overriding === k ? null : <a className="mk-act" href={formHref} data-edit-setting={k}>{t("markets.change")}</a>}
            </>
          }
        />
        {overriding === k ? <OverrideForm slug={account.slug} market={selected} settingKey={k} settings={view.settings} timezones={timezones} weekend={weekendFor(selected.countries, account.market)} /> : null}
      </div>
    );
  };

  /** Where each failing check is fixed (the strip's fix link). */
  const fixHref = (key: GoLiveCheckKey): string | null => {
    if (!selected || !view) return null;
    const m = `${here}?m=${selected.id}`;
    switch (key) {
      case "where": return `${m}&edit=where#where`;
      case "price_list": return selected.priceListLineageId ? `${base}/setup/price-lists` : `${m}&edit=price_list#set-price_list`;
      case "legal_texts": return `${base}/setup/order-form?market=${selected.id}`;
      case "payment_methods": {
        const pm = view.settings.paymentMethods.value;
        return pm.card || pm.bankTransfer ? `${m}&override=bankDetails#set-bankDetails` : `${m}&override=paymentMethods#set-paymentMethods`;
      }
      case "whatsapp": return `${base}/settings?section=whatsapp`;
    }
  };

  const assigned = selected?.priceListLineageId ? lists.find((l) => l.lineageId === selected.priceListLineageId) ?? null : null;

  return (
    <main className="sas-shell__content">
      <div className="mk-page">
        <header className="sas-page-head">
          <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 300px", minWidth: 0 }}>
            <h1 className="sas-title">{t("markets.title")}</h1>
            <span className="sas-small">{t("markets.intro")}</span>
          </div>
          <div className="sas-page-head__actions">
            <a className={buttonClass("primary")} href={`${here}?add=1`}><Icon name="plus" />{t("markets.add")}</a>
          </div>
        </header>

        {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{error}</span></div> : null}
        {statusError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(statusError)}</span></div> : null}
        {saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(saved === "added" ? "markets.added" : one(sp.reset) ? "markets.reset_done" : "markets.saved")}</span></div> : null}

        {adding ? (
          <section className="sas-panel" aria-labelledby="add-h" style={{ overflow: "hidden" }}>
            <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
              <h2 id="add-h" className="sas-heading">{t("markets.add_title")}</h2>
              <span className="sas-small">{t("markets.add_intro")}</span>
            </div>
            <WhereForm slug={account.slug} market={null} keys={keys} />
          </section>
        ) : null}

        {/* Phone: the markets list becomes a picker on top (markets.css). */}
        {selected ? (
          <form method="get" action={here} className="mk-picker" data-market-picker="">
            <label className="sas-input-label" htmlFor="mk-pick">{t("markets.switcher.label")}</label>
            <span style={{ display: "flex", gap: 8 }}>
              <select id="mk-pick" className="sas-select" name="m" defaultValue={selected.id}>
                {all.map((m) => <option key={m.id} value={m.id}>{marketOptionLabel(m)}</option>)}
              </select>
              <noscript><button type="submit" className={buttonClass("secondary", "sm")}>{t("kit.apply")}</button></noscript>
            </span>
            <AutoSubmit />
          </form>
        ) : null}

        <div className="mk-layout">
          <section className="sas-panel mk-list" aria-labelledby="ml-h">
            <h2 id="ml-h" className="mk-list__h">{t("markets.your_markets", { count: all.length })}</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {all.map((m) => {
                const v = views.get(m.id);
                // Only blocking checks count; the optional WhatsApp check is shown apart.
                const { passed, total } = v ? checkCount(v.checks) : { passed: 0, total: 0 };
                // "Home market · 16 leads" / "0 leads · 3 of 4 checks": the checks only while some fail.
                const line = [
                  m.isHome ? t("markets.home") : null,
                  leadsText(leadCounts.get(m.id) ?? 0),
                  passed < total ? t("markets.checks_short", { passed, total }) : null,
                ].filter(Boolean).join(" · ");
                return (
                  <li key={m.id} data-market-row={m.id}>
                    <a className="mk-list__row" href={`${here}?m=${m.id}`} aria-current={m.id === selected?.id ? "page" : undefined}>
                      <span className="mk-list__top">
                        <strong>{m.name}</strong>
                        <StatusPill object="market" state={m.status} />
                      </span>
                      <span className="sas-small" data-market-line="">{line}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
            <div className="sas-small" style={{ padding: "10px 14px", borderTop: "1px solid var(--line)" }}>{t("markets.fallback")}</div>
          </section>

          {selected && view ? (
            <div className="mk-detail" data-market-detail={selected.id}>
              <section className="sas-panel mk-head" aria-labelledby="md-h">
                <div className="mk-head__top">
                  <h2 id="md-h" className="mk-head__name">{selected.name}</h2>
                  {selected.isHome ? <span className="sas-pill" data-home-market="">{t("markets.home")}</span> : null}
                  <StatusPill object="market" state={selected.status} />
                  <form action={setMarketStatusAction} style={{ display: "flex", gap: 8, marginInlineStart: "auto" }}>
                    <input type="hidden" name="slug" value={account.slug} />
                    <input type="hidden" name="marketId" value={selected.id} />
                    {selected.status === "live" ? (
                      <Button type="submit" name="status" value="paused" variant="secondary" size="sm" icon="pause">{t("markets.pause")}</Button>
                    ) : (
                      <Button type="submit" name="status" value="live" variant="primary" size="sm" icon="rocket" disabled={!canGoLive(view.checks)}>{t(selected.status === "paused" ? "markets.resume" : "markets.go_live")}</Button>
                    )}
                  </form>
                </div>
                <span className="sas-small" data-differ-count={differ}>
                  {differ === 0 ? t("markets.sub_follows") : t("markets.sub_differs", { count: differ })}
                </span>
                {/* The go-live checks, as one strip (the same checks as before; only blocking ones count). */}
                <div className="mk-ready" data-ready={canGoLive(view.checks) ? "yes" : "no"}>
                  <strong>{t("markets.ready", checkCount(view.checks))}</strong>
                  <ul className="mk-ready__list" aria-label={t("markets.checks_label", checkCount(view.checks))}>
                    {view.checks.map((c) => {
                      const state = c.ok ? "pass" : c.blocking ? "fail" : "optional";
                      const href = state === "fail" ? fixHref(c.key) : null;
                      if (c.key === "whatsapp" && !c.ok) {
                        // Optional: muted, with the dashed icon; the label leads to Settings › WhatsApp.
                        return (
                          <li key={c.key} className="mk-ck mk-ck--optional" data-check={c.key} data-ok={c.ok}>
                            <span className="mk-ck__icon mk-ck__icon--optional" data-check-icon="optional" aria-hidden="true" />
                            <a className="mk-ck__muted" href={fixHref("whatsapp")!} title={c.detail ?? undefined}>{t("markets.check_short.whatsapp_optional")}</a>
                            <span className="sas-sr"> · {checkStateWord("optional")}</span>
                            {c.channel && c.channel !== "optional" ? <WhatsAppStatusPill status={c.channel} /> : null}
                          </li>
                        );
                      }
                      return (
                        <li key={c.key} className={`mk-ck mk-ck--${state}`} data-check={c.key} data-ok={c.ok}>
                          <span className={`mk-ck__icon mk-ck__icon--${state}`} data-check-icon={state} aria-hidden="true"><Icon name={state === "pass" ? "check" : "alert-triangle"} /></span>
                          <span>{t(CHECK_SHORT[c.key])}</span>
                          <span className="sas-sr"> · {checkStateWord(state)}</span>
                          {href ? <a className="mk-act" href={href} data-check-fix={c.key}>{c.detail ?? t(CHECK_SHORT[c.key])}</a> : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>

              <div className="mk-cols">
                <div className="mk-col">
                  <Card id="card-where" title={t("markets.group.where")}>
                    <Row
                      id="where"
                      label={t("markets.setting.countries")}
                      value={selected.countries.map(countryName).join(", ") || t("markets.no_countries")}
                      muted={selected.countries.length === 0}
                      action={editing === "where" ? null : <a className="mk-act" href={`${here}?m=${selected.id}&edit=where#where`} data-row-action="">{t("markets.edit")}</a>}
                    />
                    <Row
                      label={t("markets.setting.routing")}
                      value={selected.isHome && selected.phonePrefixes.length + selected.formCountryValues.length + selected.intakeKeyIds.length === 0
                        ? t("markets.routing_home")
                        : [
                            selected.phonePrefixes.length ? t("markets.routing.phone", { prefixes: selected.phonePrefixes.join(", ") }) : null,
                            selected.formCountryValues.length ? t("markets.routing.form", { values: formCountryLabels(selected.formCountryValues).join(", ") }) : null,
                            ...selected.intakeKeyIds.map((id) => (keyName(id) ? t("markets.routing.key", { name: keyName(id)! }) : null)),
                          ].filter(Boolean).join(" · ") || t("markets.routing_none")}
                      // The routing is this market's own (phone prefixes, form values, intake keys): edited in the same form as the countries.
                      action={editing === "where" ? null : <a className="mk-act" href={`${here}?m=${selected.id}&edit=where#where`} data-routing-action="">{t("markets.edit")}</a>}
                    />
                    {editing === "where" ? <WhereForm slug={account.slug} market={selected} keys={keys} /> : null}
                  </Card>

                  <Card id="card-language" title={t("markets.group.language")}>
                    {(["languages", "timezone", "contactHours"] as const).map(settingRow)}
                    {(() => {
                      // Holidays: the account has none, so there is no account default to compare with or reset to.
                      // "None" + Add dates, or "8 dates · next 25 Dec 2026" + Edit; removing every date clears them.
                      const dates = view.settings.holidays.value;
                      return (
                        <div data-setting="holidays">
                          <Row
                            id="set-holidays"
                            label={t("markets.setting.holidays")}
                            value={overriding === "holidays" ? null : holidaysText(dates, localDateIso(new Date(), view.settings.timezone.value))}
                            muted={dates.length === 0}
                            action={overriding === "holidays" ? null : <a className="mk-act" href={`${here}?m=${selected.id}&override=holidays#set-holidays`}>{t(dates.length ? "markets.edit" : "markets.holidays_add")}</a>}
                          />
                          {overriding === "holidays" ? <OverrideForm slug={account.slug} market={selected} settingKey="holidays" settings={view.settings} timezones={timezones} weekend={weekendFor(selected.countries, account.market)} /> : null}
                        </div>
                      );
                    })()}
                  </Card>
                </div>

                <div className="mk-col">
                  <Card id="card-money" title={t("markets.group.money")}>
                    <div data-setting="price_list">
                      <Row
                        id="set-price_list"
                        label={t("markets.setting.price_list")}
                        value={assigned
                          // "Israel 2026 · ILS · live v3"
                          ? `${assigned.shown.name} · ${assigned.shown.currency} · ${assigned.live ? t("markets.price_list_live", { version: assigned.live.version }) : t("markets.price_list_draft_short")}`
                          : t("markets.no_price_list")}
                        muted={!assigned}
                        note={view.livePriceList ? null : (
                          <span data-price-list-note={selected.priceListLineageId ? "not_live" : "none"}>
                            {selected.priceListLineageId ? <>{t("markets.price_list_not_live")} <a href={`${base}/setup/price-lists`}>{t("markets.price_lists_link")}</a></> : t("markets.price_list_none_hint")}
                          </span>
                        )}
                        action={editing === "price_list" ? null : <a className="mk-act" href={`${here}?m=${selected.id}&edit=price_list#set-price_list`} data-edit-setting="price_list">{t("markets.change")}</a>}
                      />
                      {editing === "price_list" ? (
                        // The picker: the same list as before, saved through setPriceListAction.
                        <form action={setPriceListAction} className="sas-stack-2 mk-edit" data-price-list-form="">
                          <input type="hidden" name="slug" value={account.slug} />
                          <input type="hidden" name="marketId" value={selected.id} />
                          <label className="sas-small" htmlFor="mk-pl">{t("markets.price_list_pick_intro", { market: selected.name })}</label>
                          <select className="sas-select" id="mk-pl" name="lineageId" defaultValue={selected.priceListLineageId ?? ""}>
                            <option value="">{t("markets.no_price_list")}</option>
                            {lists.map((l) => (
                              <option key={l.lineageId} value={l.lineageId}>
                                {/* Short, so it is not cut on a phone: "Israel 2026 · ILS · live v3". */}
                                {l.shown.name} · {l.shown.currency} · {l.live ? t("markets.price_list_live", { version: l.live.version }) : t("markets.price_list_draft_short")}
                              </option>
                            ))}
                          </select>
                          <span className="sas-small" data-price-list-link=""><a href={`${base}/setup/price-lists`}>{t("markets.price_lists_link")}</a></span>
                          <div style={{ display: "flex", gap: 8 }}>
                            <Button type="submit" variant="primary" size="sm">{t("markets.save_override")}</Button>
                            <a className={buttonClass("ghost", "sm")} href={`?m=${selected.id}`}>{t("markets.cancel")}</a>
                          </div>
                        </form>
                      ) : null}
                    </div>
                    {(["paymentMethods", "bankDetails"] as const).map(settingRow)}
                    <div data-setting="currency">
                      <Row
                        label={t("markets.setting.currency")}
                        value={currencyLabel(view.settings.currency.value)}
                        // The currency comes with the price list, else it is the account's: never set per market here.
                        action={view.settings.currency.source === "market" ? <span className="mk-row__note">{t("markets.currency_from_list")}</span> : <AccountWide />}
                      />
                    </div>
                  </Card>

                  <Card id="card-delivery" title={t("markets.group.delivery_legal")}>
                    {settingRow("leadTime")}
                    <div data-setting="legal">
                      <Row
                        label={t("markets.setting.legal")}
                        value={legal.length === 0 ? t("markets.legal_none") : (
                          // One line per language; each title in <bdi> so Hebrew titles don't flip the reading order.
                          <span className="sas-stack-2" style={{ gap: 2 }}>
                            {legalByLanguage(legal, view.settings.languages.value, legalOrder).map(({ language: lang, sections }) => (
                              <span key={lang} data-legal-lang={lang}>
                                {/* "English · Sales terms v1, Privacy notice v1 · from account" */}
                                {LANG_NAME[lang] ?? lang}{" · "}
                                {sections.map((s, i, all) => (
                                  // R5-7: "v1" stays with its title (no-break space).
                                  <span key={s.id}>{i > 0 ? ", " : null}<bdi>{s.title}</bdi>{` v${s.version}`}{s.source === "account" && !all.every((x) => x.source === "account") ? ` (${t("markets.from_account")})` : ""}</span>
                                ))}
                                {/* Only when some texts are the market's own: otherwise nothing differs. */}
                                {ownLegal > 0 && sections.every((s) => s.source === "account") ? ` · ${t("markets.from_account")}` : null}
                              </span>
                            ))}
                          </span>
                        )}
                        muted={legal.length === 0}
                        tag={ownLegal > 0 ? <DiffTag /> : null}
                        action={<a className="mk-act" href={`${base}/setup/order-form?market=${selected.id}`} data-row-action="" data-legal-action="">{t("markets.change")}</a>}
                      />
                    </div>
                  </Card>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
