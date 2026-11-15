import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { currentLegal, getOrderFormSettings, REQUIRED_FIELDS } from "@/lib/orders/settings";
import { ORDER_FORM_FIELDS } from "@/db/schema";
import { t, type MessageKey } from "@/lib/i18n";
import { removeSectionAction, saveSectionAction, saveSettingsAction, starterAction } from "./actions";
import { BuyerPreview } from "./preview";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG: Record<string, string> = { en: "EN", he: "HE" };
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };

/** Setup 6 · Order form (P5.2, canvas: OrderFormSetup). */
export default async function OrderFormSetupPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [settings, legal] = await Promise.all([getOrderFormSettings(appDb, account.id), currentLegal(appDb, account.id)]);
  const base = `/app/${account.slug}`;
  const here = `${base}/setup/order-form`;
  const keys = [...new Set(legal.map((s) => s.sectionKey))];
  const editKey = one(sp.edit);
  const editLang = one(sp.lang) || account.languages[0];
  const editing = editKey ? legal.find((s) => s.sectionKey === editKey && s.language === editLang) ?? null : null;
  const editingTitle = editing?.title ?? legal.find((s) => s.sectionKey === editKey)?.title ?? "";
  const sectionsByLang = Object.fromEntries(account.languages.map((l) => [l, legal.filter((s) => s.language === l).map((s) => ({ title: s.title, version: s.version }))]));

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head"><h1 className="sas-title">{t("ofs.title")}</h1></div>
        <span className="sas-small">{t("ofs.intro")}</span>
        <SetupSteps basePath={base} current="order-form" completed={await setupProgress(appDb, account.id)} />
      </header>
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("ofs.saved")}</span></div> : null}
      {sp.legal ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("ofs.legal_saved", { version: one(sp.legal).split(".")[2] ?? "" })}</span></div> : null}
      {sp.error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{one(sp.error)}</span></div> : null}

      <div className="sas-split">
        <div className="sas-split__main">
          <section className="sas-panel" aria-labelledby="leg-h">
            <div className="sas-panel__body sas-stack-2">
              <h2 id="leg-h" className="sas-heading">{t("ofs.legal")}</h2>
              <span className="sas-small">{t("ofs.legal_intro")}</span>
              {keys.length === 0 ? (
                <div className="sas-stack-2" style={{ paddingTop: 8 }}>
                  <span>{t("ofs.legal_empty")}</span>
                  <form action={starterAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="secondary" size="sm"><Icon name="file-text" />{t("ofs.starter")}</Button></form>
                </div>
              ) : null}
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {keys.map((k) => {
                  const rows = legal.filter((s) => s.sectionKey === k);
                  return (
                    <li key={k} style={{ display: "flex", flexWrap: "wrap", gap: "8px 12px", alignItems: "center", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                      <strong style={{ flex: "1 1 200px" }}>{rows[0].title}</strong>
                      {account.languages.map((l) => {
                        const r = rows.find((x) => x.language === l);
                        return r ? (
                          <a key={l} className="sas-chip" href={`${here}?edit=${k}&lang=${l}#editor`}>{LANG[l] ?? l} v{r.version}</a>
                        ) : (
                          <a key={l} className="sas-pill sas-pill--warning" href={`${here}?edit=${k}&lang=${l}#editor`}><Icon name="alert-triangle" />{t("ofs.missing", { lang: LANG[l] ?? l })}</a>
                        );
                      })}
                      <form action={removeSectionAction}><input type="hidden" name="slug" value={account.slug} /><input type="hidden" name="sectionKey" value={k} /><Button type="submit" variant="ghost" size="sm">{t("ofs.remove")}</Button></form>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="ed-h" id="editor">
            <form action={saveSectionAction} className="sas-panel__body sas-stack-4">
              <h2 id="ed-h" className="sas-heading">{editKey ? t("ofs.edit_section", { title: editingTitle, lang: LANG_NAME[editLang] ?? editLang }) : t("ofs.add_section")}</h2>
              <input type="hidden" name="slug" value={account.slug} />
              <input type="hidden" name="sectionKey" value={editKey} />
              <div className="sas-grid-2" style={{ gap: 12 }}>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="ls-title">{t("ofs.section_title")}</label>
                  <input className="sas-input" id="ls-title" name="title" defaultValue={editing?.title ?? (editKey ? "" : "")} required maxLength={80} key={`t-${editKey}-${editLang}`} />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="ls-lang">{t("ofs.language")}</label>
                  {editKey ? (
                    <><input type="hidden" name="language" value={editLang} /><input className="sas-input" id="ls-lang" value={LANG_NAME[editLang] ?? editLang} readOnly /></>
                  ) : (
                    <select className="sas-select" id="ls-lang" name="language">{account.languages.map((l) => <option key={l} value={l}>{LANG_NAME[l] ?? l}</option>)}</select>
                  )}
                </div>
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="ls-body">{t("ofs.section_body")}</label>
                <textarea className="sas-textarea" id="ls-body" name="body" rows={10} required defaultValue={editing?.body ?? ""} key={`b-${editKey}-${editLang}`} dir={editLang === "he" ? "rtl" : "ltr"} />
                <span className="sas-hint">{t("ofs.section_hint")}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="submit" variant="primary">{editing ? t("ofs.save_version", { version: editing.version + 1 }) : t("ofs.save_section")}</Button>
                {editKey ? <a className="sas-btn sas-btn--ghost" href={here}>{t("ofs.cancel")}</a> : null}
              </div>
            </form>
          </section>

          <form action={saveSettingsAction} className="sas-stack-4">
            <input type="hidden" name="slug" value={account.slug} />
            <section className="sas-panel" aria-labelledby="fld-h">
              <div className="sas-panel__body sas-stack-4">
                <h2 id="fld-h" className="sas-heading">{t("ofs.fields")}</h2>
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
                <span className="sas-small">{t("ofs.fields_hint")}</span>
              </div>
            </section>
            <section className="sas-panel" aria-labelledby="sig-h">
              <div className="sas-panel__body sas-stack-4">
                <h2 id="sig-h" className="sas-heading">{t("ofs.signing")}</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="of-sig">{t("ofs.signature")}</label>
                    <select className="sas-select" id="of-sig" disabled><option>{t("ofs.signature_checkbox")}</option></select>
                  </div>
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="of-days">{t("ofs.link_valid")}</label>
                    <select className="sas-select" id="of-days" name="linkValidDays" defaultValue={String(settings.linkValidDays)}>
                      {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{t("ofs.days", { count: d })}</option>)}
                    </select>
                  </div>
                  <div className="sas-input-group">
                    <label className="sas-input-label" htmlFor="of-color">{t("ofs.brand_color")}</label>
                    <input className="sas-input" id="of-color" name="brandColor" type="color" defaultValue={settings.brandColor} style={{ padding: 2 }} />
                  </div>
                  <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="sas-input-label">{t("ofs.methods")}</legend>
                    <label className="sas-check"><input type="checkbox" name="card" defaultChecked={settings.card} />{t("ofs.method.card")}</label>
                    <label className="sas-check"><input type="checkbox" name="bankTransfer" defaultChecked={settings.bankTransfer} />{t("ofs.method.bank")}</label>
                  </fieldset>
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="of-bank">{t("ofs.bank_details")}</label>
                  <textarea className="sas-textarea" id="of-bank" name="bankDetails" rows={3} defaultValue={settings.bankDetails ?? ""} placeholder="Bank Leumi · branch 800 · account 123456" />
                </div>
                <span className="sas-small">{t("ofs.recorded")}</span>
                <div><Button type="submit" variant="primary">{t("ofs.save")}</Button></div>
              </div>
            </section>
          </form>
        </div>
        <aside className="sas-split__side">
          <BuyerPreview seller={account.tradeName} brand={settings.brandColor} languages={account.languages} sections={sectionsByLang} fields={settings.fields} />
        </aside>
      </div>
    </main>
  );
}
