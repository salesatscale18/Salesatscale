import Link from "next/link";
import { Button, buttonClass } from "@/components/sas/primitives";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { estimateDelivery, formatDeliveryBuyer } from "@/lib/delivery/eta";
import { leadFromSigning } from "@/lib/delivery/text";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { ConfirmDelete, ListTable, RowMenu, SidePanel } from "@/components/sas/list-kit";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { currentLegal, getOrderFormSettings, legalTable, REQUIRED_FIELDS } from "@/lib/orders/settings";
import { ORDER_FORM_FIELDS } from "@/db/schema";
import { formatLocalDateTime, zoneTitle } from "@/lib/format";
import { firstParam, hrefWith, type SearchParamsLike } from "@/lib/list-kit";
import { t, translator, type Locale, type MessageKey } from "@/lib/i18n";
import { removeSectionAction, saveMarketSectionAction, saveSectionAction, saveSettingsAction, starterAction } from "./actions";
import { getMarketView, listMarkets, type MarketView } from "@/lib/markets/service";
import { headingTitle, marketLegal, type EffectiveSection } from "@/lib/markets/legal";
import { BuyerPreview } from "./preview";

const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const langName = (l: string) => LANG_NAME[l] ?? l;
/** "17 Nov 2026" in the account's zone. */
const day = (at: Date, tz: string | null) => formatLocalDateTime(at, tz).split(",")[0];
/** One-off notices and transient UI state that links never carry. */
const DROP = ["panel", "lang", "confirm", "edit", "saved", "legal", "error", "mlegal", "starter"];

/**
 * Setup 6 · Order form (boards: OrderFormNew). Legal texts are a table (title,
 * a version link per language, updated, ⋯ New version / Remove with a
 * confirm); "Add legal text", a version link and New version open the same
 * side panel (?panel=legal | legal:<key>&lang=<l>). "What the buyer fills in"
 * and "Signing and payment" are one form with one Save in the header. The
 * brand colour is shown here and changed in Company. The buyer preview
 * follows the ticked fields in English and Hebrew.
 */
export default async function OrderFormSetupPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [settings, legal, progress, marketList] = await Promise.all([getOrderFormSettings(appDb, account.id), currentLegal(appDb, account.id), setupProgress(appDb, account), listMarkets(appDb, account.id)]);
  // Market switcher: the home market edits the account defaults; another market shows its effective texts.
  const chosen = marketList.find((m) => m.id === firstParam(sp, "market"));
  const marketView = chosen && !chosen.isHome ? await getMarketView(appDb, account.id, chosen.id) : null;
  const marketSections = marketView ? await marketLegal(appDb, account.id, marketView.market.id) : [];
  const base = `/app/${account.slug}`;
  const here = `${base}/setup/order-form`;
  const tz = account.timezone;
  const link = (patch: Record<string, string | null> = {}) => hrefWith(here, sp, patch, DROP);
  // Panel: "legal" (new text) or "legal:<key>" (a section; ?lang picks the language). Older links use ?edit=<key>.
  const panel = firstParam(sp, "panel") ?? (firstParam(sp, "edit") ? `legal:${firstParam(sp, "edit")}` : undefined);
  const editKey = panel?.startsWith("legal:") ? panel.slice("legal:".length) : "";
  const confirm = firstParam(sp, "confirm");
  const rows = legalTable(legal, account.languages);
  // Delivery estimate for the market the preview shows (home market by default), as buyers see it before signing.
  const previewMarket = marketView?.market ?? marketList.find((m) => m.isHome) ?? null;
  const plan = previewMarket ? deliveryPlanFor(account, previewMarket) : null;
  const delivery = plan
    ? Object.fromEntries(account.languages.filter((l) => l === "en" || l === "he").map((l) => {
        const tr = translator(l as Locale);
        const eta = estimateDelivery({ ...plan, from: new Date() });
        return [l, { label: tr("buyer.delivery.label", { range: formatDeliveryBuyer(eta, l) }), lead: leadFromSigning(tr, plan.leadTime, l === "he") }];
      }))
    : null;
  const sectionsByLang = Object.fromEntries(account.languages.map((l) => [l, legal.filter((s) => s.language === l).map((s) => ({ title: s.title, version: s.version }))]));
  const error = firstParam(sp, "error");
  const panelOpen = !marketView && (panel === "legal" || Boolean(editKey));

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("ofs.title")}</h1>
          <div className="sas-page-head__actions">
            <button type="submit" form="ofs-settings" className={buttonClass("primary")} data-page-save="">{t("ofs.save_page")}</button>
          </div>
        </div>
        <span className="sas-small">{t("ofs.intro")}</span>
        <SetupSteps basePath={base} current="order-form" completed={progress} />
      </header>
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("ofs.saved")}</span></div> : null}
      {sp.legal ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("ofs.legal_saved", { version: (firstParam(sp, "legal") ?? "").split(".")[2] ?? "" })}</span></div> : null}
      {error && !panelOpen ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{error}</span></div> : null}
      {sp.mlegal ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("ofs.market_saved", { version: firstParam(sp, "mlegal") ?? "" })}</span></div> : null}
      {marketList.length > 1 ? (
        <nav aria-label={t("ofs.market_switch")} className="sas-views" data-market-switcher>
          {marketList.map((m) => {
            const current = marketView ? m.id === marketView.market.id : m.isHome;
            return (
              <a key={m.id} className="sas-view" href={m.isHome ? here : `${here}?market=${m.id}`} aria-current={current ? "page" : undefined}>
                {m.isHome ? t("ofs.market_home", { name: m.name }) : m.name}
              </a>
            );
          })}
        </nav>
      ) : null}

      <div className="sas-split">
        <div className="sas-split__main">
          {marketView ? (
            <MarketLegal slug={account.slug} here={here} sp={sp} view={marketView} sections={marketSections} panel={panel} tz={tz} />
          ) : (
            <section className="sas-stack-4" aria-labelledby="leg-h" data-legal-table="">
              <div className="sas-listbar__head">
                <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 280px", minWidth: 0 }}>
                  <h2 id="leg-h" className="sas-heading">{t("ofs.legal_texts")}</h2>
                  <span className="sas-small">{t("ofs.legal_intro")}</span>
                </div>
                <div className="sas-listbar__actions">
                  <Link className={buttonClass("secondary", "sm")} href={link({ panel: "legal" })} scroll={false} data-add-legal=""><Icon name="plus" />{t("ofs.add_legal")}</Link>
                </div>
              </div>
              {rows.length === 0 ? (
                <div className="sas-panel sas-panel__body sas-stack-2">
                  <span>{t("ofs.legal_empty")}</span>
                  <form action={starterAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="secondary" size="sm"><Icon name="file-text" />{t("ofs.starter")}</Button></form>
                </div>
              ) : (
                <ListTable caption={t("ofs.legal_texts")} foot={<span className="sas-small">{t("ofs.legal_table_hint")}</span>}>
                  <thead>
                    <tr>
                      <th scope="col">{t("ofs.col.title")}</th>
                      <th scope="col">{t("ofs.col.versions")}</th>
                      <th scope="col">{t("ofs.col.updated")}</th>
                      <th scope="col"><span className="sas-sr">{t("ofs.col.actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.flatMap((r) => {
                      const row = (
                        <tr key={r.sectionKey} data-current={editKey === r.sectionKey ? "" : undefined} data-legal-row={r.sectionKey}>
                          <td><strong><bdi>{r.title}</bdi></strong></td>
                          <td data-label={t("ofs.col.versions")} style={{ whiteSpace: "normal" }}>
                            <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
                              {r.versions.map((v) => v.version !== null ? (
                                <Link key={v.language} href={link({ panel: `legal:${r.sectionKey}`, lang: v.language })} scroll={false} data-legal-version={`${v.language}.${v.version}`} style={{ whiteSpace: "nowrap" }}>
                                  {t("ofs.lang_version", { lang: langName(v.language), version: v.version })}
                                </Link>
                              ) : (
                                <Link key={v.language} className="sas-pill sas-pill--warning" href={link({ panel: `legal:${r.sectionKey}`, lang: v.language })} scroll={false}>
                                  <Icon name="alert-triangle" />{t("ofs.missing", { lang: langName(v.language) })}
                                </Link>
                              ))}
                            </span>
                          </td>
                          <td data-label={t("ofs.col.updated")} className="sas-when"><time dateTime={r.updatedAt.toISOString()} title={`${formatLocalDateTime(r.updatedAt, tz)} · ${zoneTitle(r.updatedAt, tz)}`}>{day(r.updatedAt, tz)}</time></td>
                          <td data-label="" className="sas-td-actions">
                            <RowMenu
                              label={t("ofs.more", { title: r.title })}
                              items={[
                                { label: t("ofs.new_version"), href: link({ panel: `legal:${r.sectionKey}` }), icon: "pencil" },
                                { label: t("ofs.remove"), href: hrefWith(here, sp, { confirm: r.sectionKey }, DROP.filter((d) => d !== "confirm")), icon: "trash", danger: true },
                              ]}
                            />
                          </td>
                        </tr>
                      );
                      if (confirm !== r.sectionKey) return [row];
                      return [
                        row,
                        <tr key={`${r.sectionKey}-confirm`} className="sas-confirm-row">
                          <td colSpan={4} data-label="">
                            <ConfirmDelete title={t("ofs.remove_confirm", { title: r.title })} action={removeSectionAction} fields={{ slug: account.slug, sectionKey: r.sectionKey }} cancelHref={link()} confirmLabel={t("ofs.remove")}>
                              {t("ofs.remove_confirm_body")}
                            </ConfirmDelete>
                          </td>
                        </tr>,
                      ];
                    })}
                  </tbody>
                </ListTable>
              )}
            </section>
          )}

          <form id="ofs-settings" action={saveSettingsAction} className="sas-stack-4" aria-label={t("ofs.settings_label")}>
            <input type="hidden" name="slug" value={account.slug} />
            <section className="sas-panel" aria-labelledby="fld-h">
              <div className="sas-panel__body sas-stack-4">
                <div className="sas-stack-2" style={{ gap: 2 }}>
                  <h2 id="fld-h" className="sas-heading">{t("ofs.fields")}</h2>
                  <span className="sas-small">{t("ofs.fields_hint")}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px 16px" }}>
                  <label className="sas-check"><input type="checkbox" checked disabled />{t("ofs.field.signatory_name")}</label>
                  {ORDER_FORM_FIELDS.map((f) => (
                    <label key={f} className="sas-check">
                      <input type="checkbox" name="fields" value={f} defaultChecked={settings.fields.includes(f)} disabled={REQUIRED_FIELDS.includes(f)} />
                      {t(`ofs.field.${f}` as MessageKey)}
                      {REQUIRED_FIELDS.includes(f) ? <input type="hidden" name="fields" value={f} /> : null}
                    </label>
                  ))}
                </div>
              </div>
            </section>
            <section className="sas-panel" aria-labelledby="sig-h">
              <div className="sas-panel__body sas-stack-4">
                <h2 id="sig-h" className="sas-heading">{t("ofs.signing")}</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="of-sig">{t("ofs.signature")}</label>
                    <select className="sas-select" id="of-sig" disabled aria-describedby="of-sig-note"><option>{t("ofs.signature_checkbox")}</option></select>
                    <span className="sas-hint" id="of-sig-note" data-signature-note="">{t("ofs.recorded")}</span>
                  </div>
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="of-days">{t("ofs.link_valid")}</label>
                    <select className="sas-select" id="of-days" name="linkValidDays" defaultValue={String(settings.linkValidDays)}>
                      {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{t("ofs.days", { count: d })}</option>)}
                    </select>
                  </div>
                  <div className="sas-input-group" data-brand-color={settings.brandColor}>
                    <span className="sas-input-label">{t("ofs.brand_color")}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36, flexWrap: "wrap" }}>
                      <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 6, background: settings.brandColor, border: "1px solid var(--line)", flex: "none" }} />
                      <span className="sas-num">{settings.brandColor}</span>
                      <a href={`${base}/setup/company`} data-brand-change="">{t("ofs.brand_change")}</a>
                    </span>
                  </div>
                  <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="sas-input-label">{t("ofs.methods")}</legend>
                    <label className="sas-check"><input type="checkbox" name="card" defaultChecked={settings.card} />{t("ofs.method.card")}</label>
                    <label className="sas-check"><input type="checkbox" name="bankTransfer" defaultChecked={settings.bankTransfer} />{t("ofs.method.bank")}</label>
                  </fieldset>
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="of-bank">{t("ofs.bank_details")}</label>
                  <textarea className="sas-textarea" id="of-bank" name="bankDetails" rows={3} defaultValue={settings.bankDetails ?? ""} placeholder="Bank name · branch · account number" />
                </div>
              </div>
            </section>
          </form>
        </div>
        <aside className="sas-split__side">
          <BuyerPreview seller={account.tradeName} brand={settings.brandColor} languages={account.languages} sections={sectionsByLang} fields={settings.fields} fieldOrder={ORDER_FORM_FIELDS} delivery={delivery} noDeliveryHint={t("ofs.preview_no_delivery")} />
        </aside>
      </div>

      {panelOpen ? <LegalPanel slug={account.slug} languages={account.languages} legal={legal} editKey={editKey} lang={firstParam(sp, "lang")} close={link()} tabHref={(l) => link({ panel: `legal:${editKey}`, lang: l })} error={error} /> : null}
    </main>
  );
}

/**
 * The legal text panel: "Add legal text" (title, language, text) or a section
 * (New version, a version link): its languages as tabs, the current text
 * prefilled; saving creates a new version.
 */
function LegalPanel({ slug, languages, legal, editKey, lang: wanted, close, tabHref, error }: {
  slug: string; languages: string[]; legal: { sectionKey: string; language: string; title: string; body: string; version: number }[];
  editKey: string; lang: string | undefined; close: string; tabHref: (lang: string) => string; error: string | undefined;
}) {
  const rows = legal.filter((s) => s.sectionKey === editKey);
  const known = editKey !== "" && rows.length > 0;
  const lang = wanted && languages.includes(wanted) ? wanted : (rows.find((r) => languages.includes(r.language))?.language ?? languages[0]);
  const editing = known ? rows.find((s) => s.language === lang) ?? null : null;
  const title = known ? headingTitle(rows) : "";
  return (
    <SidePanel
      title={known ? t("ofs.edit_section", { title, lang: langName(lang) }) : t("ofs.add_legal")}
      meta={known ? (editing ? <span>{t("ofs.current_version", { version: editing.version })}</span> : <span className="sas-pill sas-pill--warning"><Icon name="alert-triangle" />{t("ofs.missing", { lang: langName(lang) })}</span>) : undefined}
      closeHref={close}
      tabs={known && languages.length > 1 ? languages.map((l) => ({ id: l, label: langName(l), href: tabHref(l) })) : undefined}
      currentTab={lang}
      tabsLabel={t("ofs.language")}
      footer={
        <>
          <button type="submit" form="ofs-legal" className={buttonClass("primary")}>{editing ? t("ofs.save_version", { version: editing.version + 1 }) : t("ofs.save_text")}</button>
          <Link className={buttonClass("ghost")} href={close} scroll={false}>{t("ofs.cancel")}</Link>
        </>
      }
    >
      {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{error}</span></div> : null}
      <form id="ofs-legal" action={saveSectionAction} className="sas-stack-4" key={`${editKey}-${lang}`}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="sectionKey" value={known ? editKey : ""} />
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ls-title">{t("ofs.section_title")}</label>
          <input className="sas-input" id="ls-title" name="title" defaultValue={editing?.title ?? (known ? title : "")} required maxLength={80} dir="auto" data-autofocus="" />
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ls-lang">{t("ofs.language")}</label>
          {known ? (
            <><input type="hidden" name="language" value={lang} /><input className="sas-input" id="ls-lang" value={langName(lang)} readOnly /></>
          ) : (
            <select className="sas-select" id="ls-lang" name="language" defaultValue={lang}>{languages.map((l) => <option key={l} value={l}>{langName(l)}</option>)}</select>
          )}
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="ls-body">{t("ofs.section_body")}</label>
          <textarea className="sas-textarea" id="ls-body" name="body" rows={14} required defaultValue={editing?.body ?? ""} dir={known ? (lang === "he" ? "rtl" : "ltr") : "auto"} />
          <span className="sas-hint">{t("ofs.section_hint")}</span>
        </div>
      </form>
    </SidePanel>
  );
}

/** Legal texts of a market that is not the home market: each section shows its effective text and where it comes from; Override / Edit open the panel. */
function MarketLegal({ slug, here, sp, view, sections, panel, tz }: { slug: string; here: string; sp: SearchParamsLike; view: MarketView; sections: EffectiveSection[]; panel: string | undefined; tz: string | null }) {
  const market = view.market;
  const languages = view.settings.languages.value;
  const keys = [...new Set(sections.map((s) => s.sectionKey))];
  const at = (k: string, l: string) => hrefWith(here, sp, { panel: `legal:${k}`, lang: l }, DROP);
  const close = hrefWith(here, sp, {}, DROP);
  const editKey = panel?.startsWith("legal:") ? panel.slice("legal:".length) : "";
  const wanted = firstParam(sp, "lang");
  const lang = wanted && languages.includes(wanted) ? wanted : languages[0];
  const editing = editKey ? sections.find((s) => s.sectionKey === editKey && s.language === lang) ?? null : null;
  const anyTitle = sections.find((s) => s.sectionKey === editKey)?.title ?? "";
  return (
    <>
      <section className="sas-stack-4" aria-labelledby="mleg-h" data-market-legal={market.id}>
        <div className="sas-stack-2" style={{ gap: 2 }}>
          <h2 id="mleg-h" className="sas-heading">{t("ofs.legal_texts")} · {market.name}</h2>
          <span className="sas-small">{t("ofs.market_intro", { market: market.name })}</span>
        </div>
        {keys.length === 0 ? <div className="sas-panel sas-panel__body"><span>{t("ofs.market_none")}</span></div> : (
          <ListTable caption={`${t("ofs.legal_texts")} · ${market.name}`}>
            <thead>
              <tr>
                <th scope="col">{t("ofs.col.title")}</th>
                <th scope="col">{t("ofs.col.versions")}</th>
                <th scope="col">{t("ofs.col.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const rows = sections.filter((s) => s.sectionKey === k);
                const shown = rows.filter((x) => languages.includes(x.language));
                const updated = new Date(Math.max(...rows.map((r) => r.createdAt.getTime())));
                return (
                  <tr key={k} data-current={editKey === k ? "" : undefined}>
                    <td><strong><bdi>{headingTitle(shown.length ? shown : rows)}</bdi></strong></td>
                    <td data-label={t("ofs.col.versions")} style={{ whiteSpace: "normal" }}>
                      <span className="sas-stack-2">
                        {languages.map((l) => {
                          const r = rows.find((x) => x.language === l);
                          return (
                            <span key={l} data-section={`${k}.${l}`} data-source={r?.source ?? "missing"} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px" }}>
                              {r ? (
                                <>
                                  <span data-legal-version={`${l}.${r.version}`}>{t("ofs.lang_version", { lang: langName(l), version: r.version })}</span>
                                  {r.source === "market"
                                    ? <span className="sas-pill sas-pill--agent">{t("ofs.overridden")}</span>
                                    : <span className="sas-pill">{t("ofs.same_as_account")}</span>}
                                  <Link className={buttonClass("ghost", "sm")} href={at(k, l)} scroll={false}>{t(r.source === "market" ? "ofs.edit_market" : "ofs.override")}</Link>
                                </>
                              ) : (
                                <Link className="sas-pill sas-pill--warning" href={at(k, l)} scroll={false}><Icon name="alert-triangle" />{t("ofs.market_missing", { lang: langName(l) })}</Link>
                              )}
                            </span>
                          );
                        })}
                      </span>
                    </td>
                    <td data-label={t("ofs.col.updated")} className="sas-when"><time dateTime={updated.toISOString()} title={`${formatLocalDateTime(updated, tz)} · ${zoneTitle(updated, tz)}`}>{day(updated, tz)}</time></td>
                  </tr>
                );
              })}
            </tbody>
          </ListTable>
        )}
      </section>
      {editKey && keys.includes(editKey) ? (
        <SidePanel
          title={t("ofs.market_edit_section", { title: editing?.title ?? anyTitle, lang: langName(lang), market: market.name })}
          closeHref={close}
          tabs={languages.length > 1 ? languages.map((l) => ({ id: l, label: langName(l), href: at(editKey, l) })) : undefined}
          currentTab={lang}
          tabsLabel={t("ofs.language")}
          footer={
            <>
              <button type="submit" form="ofs-market-legal" className={buttonClass("primary")}>{t("ofs.market_save", { market: market.name })}</button>
              <Link className={buttonClass("ghost")} href={close} scroll={false}>{t("ofs.cancel")}</Link>
            </>
          }
        >
          <form id="ofs-market-legal" action={saveMarketSectionAction} className="sas-stack-4" key={`${editKey}-${lang}`}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="marketId" value={market.id} />
            <input type="hidden" name="sectionKey" value={editKey} />
            <input type="hidden" name="language" value={lang} />
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="ms-title">{t("ofs.section_title")}</label>
              <input className="sas-input" id="ms-title" name="title" defaultValue={editing?.title ?? anyTitle} required maxLength={80} dir="auto" data-autofocus="" />
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="ms-body">{t("ofs.section_body")}</label>
              <textarea className="sas-textarea" id="ms-body" name="body" rows={14} required defaultValue={editing?.body ?? ""} dir={lang === "he" ? "rtl" : "ltr"} />
              <span className="sas-hint">{t("ofs.market_hint")}</span>
            </div>
          </form>
        </SidePanel>
      ) : null}
    </>
  );
}
