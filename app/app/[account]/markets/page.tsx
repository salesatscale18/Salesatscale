import type { ReactNode } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { contactHoursOrDefault, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { ContactHoursFields } from "@/components/sas/contact-hours-fields";
import { countLeadsByMarket, listIntakeKeys } from "@/lib/leads/service";
import { marketLegal } from "@/lib/markets/legal";
import { canGoLive, checkCount, countryName } from "@/lib/markets/rules";
import { ensureHomeMarket, getMarketView, listMarkets, type MarketView } from "@/lib/markets/service";
import { overriddenCount, type AccountDefaults, type EffectiveSettings, type SettingKey } from "@/lib/markets/settings";
import { listPriceLists } from "@/lib/pricing/price-lists";
import { LOCALES, t, type MessageKey } from "@/lib/i18n";
import { leadTimeText, MAX_LEAD_DAYS, weekendFor } from "@/lib/delivery/eta";
import type { LeadIntakeKey, Market } from "@/db/schema";
import {
  addMarketAction, overrideSettingAction, resetSettingAction, setMarketStatusAction, setPriceListAction, updateWhereAction,
} from "./actions";
import { CheckIcon, checkStateWord, WhatsAppStatusPill } from "../settings/whatsapp-status";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const langNames = (ls: string[]) => ls.map((l) => LANG_NAME[l] ?? l).join(", ");

const GROUPS: { label: MessageKey; keys: SettingKey[] }[] = [
  { label: "markets.group.language", keys: ["languages", "timezone", "contactHours", "holidays"] },
  { label: "markets.group.money", keys: ["paymentMethods", "bankDetails"] },
  { label: "markets.group.delivery", keys: ["leadTime"] },
];

const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** "Friday, Saturday": the weekend business days skip in a market. */
const weekendText = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => t(`settings.hours.day.${DAY_SHORT[d]}` as MessageKey)).join(", ");

/** One setting's effective value in words. */
function describe<K extends SettingKey>(key: K, value: AccountDefaults[K]): string {
  switch (key) {
    case "languages": return langNames(value as string[]);
    case "timezone": return value as string;
    case "contactHours": return summarizeContactHours(value as AccountDefaults["contactHours"]);
    case "paymentMethods": {
      const pm = value as AccountDefaults["paymentMethods"];
      return [pm.card ? t("golive.method.card") : null, pm.bankTransfer ? t("golive.method.bank") : null].filter(Boolean).join(", ") || t("markets.none");
    }
    case "bankDetails": return (value as string | null)?.trim() || t("markets.none");
    case "holidays": return (value as string[]).length ? (value as string[]).join(", ") : t("markets.none");
    case "leadTime": {
      const lt = value as AccountDefaults["leadTime"];
      return lt ? leadTimeText(lt) : t("markets.lead_time_not_set");
    }
  }
  return "";
}

function SourcePill({ source }: { source: "account" | "market" }) {
  return source === "market"
    ? <span className="sas-pill sas-pill--agent" data-source="market">{t("markets.overridden")}</span>
    : <span className="sas-pill" data-source="account">{t("markets.same_as_account")}</span>;
}

/** A row of the detail panel: label, value, source and action. Wraps on narrow screens. */
function Row({ label, value, pill, action, muted, id }: { label: string; value: ReactNode; pill?: ReactNode; action?: ReactNode; muted?: boolean; id?: string }) {
  return (
    <div id={id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "10px 20px", borderTop: "1px solid var(--line)" }}>
      <strong style={{ flex: "0 1 180px", minWidth: 120 }}>{label}</strong>
      <span style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere", color: muted ? "var(--ink-muted)" : undefined }}>{value}</span>
      {/* Pill and action stay together on one line, so "Override" and "Reset" line up the same way. */}
      {pill || action ? (
        <span style={{ flex: "0 0 auto", minWidth: 250, display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginInlineStart: "auto" }} data-row-end="">
          {pill}
          {action}
        </span>
      ) : null}
    </div>
  );
}

const Group = ({ children }: { children: ReactNode }) => (
  <div className="sas-group-label" style={{ padding: "14px 20px 6px", margin: 0 }}>{children}</div>
);

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
          {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
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
      fields = (
        <>
          <textarea className="sas-textarea" name="holidays" rows={3} defaultValue={(v as string[]).join("\n")} aria-label={t("markets.setting.holidays")} aria-describedby="hol-hint" />
          <span className="sas-hint" id="hol-hint">{t("markets.holidays_hint")}</span>
        </>
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
    <form action={overrideSettingAction} className="sas-stack-2" style={{ padding: "4px 20px 14px", background: "var(--surface-sunken)" }} data-override-form={settingKey}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="marketId" value={market.id} />
      <input type="hidden" name="key" value={settingKey} />
      <span className="sas-small">{t("markets.override_intro", { market: market.name })}</span>
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
    <form action={isNew ? addMarketAction : updateWhereAction} className="sas-stack-4" style={{ padding: "14px 20px", borderTop: "1px solid var(--line)", background: isNew ? undefined : "var(--surface-sunken)" }} data-where-form={isNew ? "new" : market.id}>
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

/** Settings › Markets (canvas: Markets). Each market starts from the account defaults and overrides only what differs. */
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
  const listName = (lineageId: string | null) => (lineageId ? lists.find((l) => l.lineageId === lineageId)?.shown.name ?? null : null);
  const keyName = (id: string) => keys.find((k) => k.id === id)?.name;
  const legal = selected && view ? (await marketLegal(appDb, account.id, selected.id)).filter((s) => view.settings.languages.value.includes(s.language)) : [];
  const ownLegal = legal.filter((s) => s.source === "market").length;
  const timezones = overriding === "timezone" ? Intl.supportedValuesOf("timeZone") : [];

  return (
    <main className="sas-shell__content">
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 300px", minWidth: 0 }}>
          <nav aria-label={t("markets.breadcrumb")} className="sas-small"><a href={`${base}/settings`}>{t("settings.title")}</a> / {t("markets.title")}</nav>
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

      <div className="sas-split">
        <section className="sas-panel" aria-labelledby="ml-h" style={{ flex: "1 1 280px", maxWidth: 360, minWidth: 0, overflow: "hidden", gap: 0 }}>
          <h2 id="ml-h" className="sas-heading" style={{ padding: "14px 16px", margin: 0 }}>{t("markets.your_markets", { count: all.length })}</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {all.map((m) => {
              const v = views.get(m.id);
              // Only blocking checks count; the optional WhatsApp check is shown apart.
              const { passed, total } = v ? checkCount(v.checks) : { passed: 0, total: 0 };
              const pl = listName(m.priceListLineageId);
              return (
                <li key={m.id} style={{ borderTop: "1px solid var(--line)" }} data-market-row={m.id}>
                  <a className="sas-list__row" href={`${here}?m=${m.id}`} aria-current={m.id === selected?.id ? "page" : undefined} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                    <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
                      <strong>{m.name}{m.isHome ? <span className="sas-chip" style={{ marginInlineStart: 8 }}>{t("markets.home")}</span> : null}</strong>
                      <StatusPill object="market" state={m.status} />
                    </span>
                    <span className="sas-small">
                      {[
                        m.countries.map(countryName).join(", ") || t("markets.no_countries"),
                        pl ?? t("markets.no_price_list"),
                        t("markets.leads", { count: leadCounts.get(m.id) ?? 0 }),
                        t("markets.checks_short", { passed, total }),
                      ].join(" · ")}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="sas-small" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>{t("markets.fallback")}</div>
        </section>

        {selected && view ? (
          <section className="sas-panel" aria-labelledby="md-h" style={{ flex: "999 1 560px", minWidth: 0, overflow: "hidden", gap: 0 }} data-market-detail={selected.id}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "16px 20px" }}>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <h2 id="md-h" className="sas-heading" style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  {selected.name}
                  {selected.isHome ? <span className="sas-chip">{t("markets.home")}</span> : null}
                  <StatusPill object="market" state={selected.status} />
                </h2>
                <span className="sas-small">{t("markets.overridden_count", { count: overriddenCount(selected.overrides) })}</span>
              </div>
              <form action={setMarketStatusAction} style={{ display: "flex", gap: 8 }}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="marketId" value={selected.id} />
                {selected.status === "live" ? (
                  <Button type="submit" name="status" value="paused" variant="secondary" size="sm" icon="pause">{t("markets.pause")}</Button>
                ) : (
                  <Button type="submit" name="status" value="live" variant="primary" size="sm" icon="rocket" disabled={!canGoLive(view.checks)}>{t(selected.status === "paused" ? "markets.resume" : "markets.go_live")}</Button>
                )}
              </form>
            </div>

            <Group>{t("markets.group.where")}</Group>
            <Row
              label={t("markets.setting.countries")}
              value={selected.countries.map(countryName).join(", ") || t("markets.no_countries")}
              action={editing === "where" ? null : <a className="sas-small" href={`${here}?m=${selected.id}&edit=where#where`}>{t("markets.edit")}</a>}
              id="where"
            />
            <Row
              label={t("markets.setting.routing")}
              value={selected.isHome && selected.phonePrefixes.length + selected.formCountryValues.length + selected.intakeKeyIds.length === 0
                ? t("markets.routing_home")
                : [
                    selected.phonePrefixes.length ? t("markets.routing.phone", { prefixes: selected.phonePrefixes.join(", ") }) : null,
                    selected.formCountryValues.length ? t("markets.routing.form", { values: selected.formCountryValues.join(", ") }) : null,
                    ...selected.intakeKeyIds.map((id) => (keyName(id) ? t("markets.routing.key", { name: keyName(id)! }) : null)),
                  ].filter(Boolean).join(" · ") || t("markets.routing_none")}
            />
            {editing === "where" ? <WhereForm slug={account.slug} market={selected} keys={keys} /> : null}

            {GROUPS.map((g) => (
              <div key={g.label}>
                <Group>{t(g.label)}</Group>
                {g.label === "markets.group.money" ? (
                  <form action={setPriceListAction} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "10px 20px", borderTop: "1px solid var(--line)" }} data-price-list-form>
                    <input type="hidden" name="slug" value={account.slug} />
                    <input type="hidden" name="marketId" value={selected.id} />
                    <label htmlFor="mk-pl" style={{ flex: "0 1 180px", minWidth: 120, fontWeight: 600 }}>{t("markets.setting.price_list")}</label>
                    <span style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                      <select className="sas-select" id="mk-pl" name="lineageId" defaultValue={selected.priceListLineageId ?? ""}>
                        <option value="">{t("markets.no_price_list")}</option>
                        {lists.map((l) => (
                          <option key={l.lineageId} value={l.lineageId}>
                            {l.shown.name} · {l.shown.currency} · {l.live ? t("markets.price_list_live", { version: l.live.version }) : t("markets.price_list_draft")}
                          </option>
                        ))}
                      </select>
                      <span className="sas-small">
                        {view.livePriceList
                          ? t("markets.price_list_current", { name: view.livePriceList.name, currency: view.livePriceList.currency, version: view.livePriceList.version })
                          : selected.priceListLineageId ? t("markets.price_list_not_live") : t("markets.price_list_none_hint")}
                        {" "}<a href={`${base}/setup/price-lists`}>{t("markets.price_lists_link")}</a>
                      </span>
                    </span>
                    <Button type="submit" variant="secondary" size="sm">{t("markets.change")}</Button>
                  </form>
                ) : null}
                {g.keys.map((k) => {
                  const s = view.settings[k];
                  return (
                    <div key={k} data-setting={k}>
                      <Row
                        id={`set-${k}`}
                        label={t(`markets.setting.${k}` as MessageKey)}
                        value={describe(k, s.value as AccountDefaults[typeof k])}
                        muted={s.source === "account"}
                        pill={<SourcePill source={s.source} />}
                        action={s.source === "market" ? (
                          <form action={resetSettingAction}>
                            <input type="hidden" name="slug" value={account.slug} />
                            <input type="hidden" name="marketId" value={selected.id} />
                            <input type="hidden" name="key" value={k} />
                            <Button type="submit" variant="ghost" size="sm">{t("markets.reset")}</Button>
                          </form>
                        ) : overriding === k ? null : (
                          <a className={buttonClass("ghost", "sm")} href={`${here}?m=${selected.id}&override=${k}#set-${k}`}>{t("markets.override")}</a>
                        )}
                      />
                      {overriding === k ? <OverrideForm slug={account.slug} market={selected} settingKey={k} settings={view.settings} timezones={timezones} weekend={weekendFor(selected.countries, account.market)} /> : null}
                    </div>
                  );
                })}
                {g.label === "markets.group.money" ? (
                  <Row label={t("markets.setting.currency")} value={view.settings.currency.value} muted={view.settings.currency.source === "account"} pill={<span className="sas-small">{t(view.settings.currency.source === "market" ? "markets.currency_from_list" : "markets.currency_from_account")}</span>} />
                ) : null}
              </div>
            ))}

            <Group>{t("markets.group.legal")}</Group>
            <Row
              label={t("markets.setting.legal")}
              value={legal.length === 0 ? t("markets.legal_none") : (
                // One line per language; each title in <bdi> so Hebrew titles don't flip the reading order.
                <span className="sas-stack-2" style={{ gap: 4 }}>
                  {[...new Set(legal.map((s) => s.language))].map((lang) => (
                    <span key={lang} data-legal-lang={lang}>
                      <span className="sas-chip" style={{ marginInlineEnd: 8 }}>{lang.toUpperCase()}</span>
                      {legal.filter((s) => s.language === lang).map((s, i) => (
                        <span key={s.id}>{i > 0 ? " · " : null}<bdi>{s.title}</bdi> v{s.version}{s.source === "account" ? ` ${t("markets.from_account")}` : ""}</span>
                      ))}
                    </span>
                  ))}
                </span>
              )}
              pill={ownLegal === 0 ? <SourcePill source="account" /> : <span className="sas-pill sas-pill--agent">{ownLegal === legal.length ? t("markets.overridden") : t("markets.partly_overridden")}</span>}
              action={<a className="sas-small" href={`${base}/setup/order-form?market=${selected.id}`}>{t("markets.edit")}</a>}
            />

            <Group>{t("markets.group.golive")}</Group>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("markets.checks_label", checkCount(view.checks))}>
              {view.checks.map((c) => (
                <li key={c.key} data-check={c.key} data-ok={c.ok} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "10px 20px", borderTop: "1px solid var(--line)" }}>
                  <CheckIcon state={c.ok ? "pass" : c.blocking ? "fail" : "optional"} size={24} />
                  <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <strong>{t(`markets.check.${c.key}` as MessageKey)}</strong>
                    <span className="sas-sr"> · {checkStateWord(c.ok ? "pass" : c.blocking ? "fail" : "optional")}</span>
                    {c.detail ? <span className="sas-small" style={{ display: "block" }}>{c.detail}</span> : null}
                  </span>
                  {c.channel ? <WhatsAppStatusPill status={c.channel} /> : !c.ok && !c.blocking ? <span className="sas-pill">{t("golive.not_blocking")}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
