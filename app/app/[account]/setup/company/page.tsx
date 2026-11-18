import { Button, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listMembers } from "@/lib/accounts/service";
import { TRADE_NAME_MAX, whiteContrast } from "@/lib/accounts/company";
import { marketLanguages } from "@/lib/agent/names-auto";
import { nameLanguages, tradeNameRows, typedLanguage } from "@/lib/agent/core/names";
import { LocalNames } from "../local-names";
import { PlatformFixed } from "../playbook/parts";
import { listVersions } from "@/lib/agent/service";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { getOrderFormSettings } from "@/lib/orders/settings";
import { displayName } from "@/lib/auth/display";
import { currencyLabel, timezoneLabel } from "@/lib/format";
import { t } from "@/lib/i18n";
import { setupProgress } from "@/lib/overview/setup";
import { saveCompanyAction } from "./actions";
import { estimateDelivery, formatDeliveryShort, leadTimeOrNull, MAX_LEAD_DAYS } from "@/lib/delivery/eta";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { leadAfterSigning } from "@/lib/delivery/text";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "עברית Hebrew" };

function brandInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

/** Setup 1 · Company (P8.2, canvas: Company). */
export default async function CompanyPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [members, settings, versions, progress] = await Promise.all([listMembers(appDb, account.id), getOrderFormSettings(appDb, account.id), listVersions(appDb, account.id), setupProgress(appDb, account)]);
  const base = `/app/${account.slug}`;
  // The agent name lives in the playbook draft (or the live version); read it, never create a draft here.
  const playbook = (versions.find((v) => v.status === "draft") ?? versions.find((v) => v.status === "live"))?.playbook ?? defaultPlaybook(account.tradeName, account.maxDiscountBp);
  const lowContrast = whiteContrast(settings.brandColor) < 4.5;
  // A version of the trade name per language of the account's markets (C2); without one, buyers see it as written.
  const nameLangs = await marketLanguages(appDb, account.id);
  const tradeRows = tradeNameRows(account, nameLanguages(nameLangs.markets, nameLangs.account, typedLanguage(account.tradeName)));
  const heAgent = playbook.agentNameLocal?.he?.trim();
  const NAME_MARK = "\u0000name\u0000";
  const [introBefore, introAfter = ""] = t("company.agent_preview", { name: NAME_MARK }).split(NAME_MARK);
  const lead = leadTimeOrNull(account.deliveryLeadTime);
  // The example uses the account's own time zone and weekend (a market may differ).
  const plan = deliveryPlanFor(account, { overrides: {}, countries: [] });
  const example = plan ? `${formatDeliveryShort(estimateDelivery({ ...plan, from: new Date() }))} (${leadAfterSigning(plan.leadTime)})` : null;

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("company.title")}</h1>
          <div className="sas-page-head__actions">
            <Button type="submit" form="company-form" variant="primary">{t("company.save")}</Button>
          </div>
        </div>
        <span className="sas-small">{t("company.intro")}</span>
        <SetupSteps basePath={base} current="company" completed={progress} />
      </header>
      {sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("company.saved")}</span></div> : null}
      {sp.error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{one(sp.error)}</span></div> : null}

      <form id="company-form" action={saveCompanyAction} className="sas-split">
        <input type="hidden" name="slug" value={account.slug} />
        <div className="sas-split__main">
          <section className="sas-panel" aria-labelledby="id-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="id-h" className="sas-heading">{t("company.details")}</h2>
              <div className="sas-grid-2" style={{ gap: 16 }}>
                <div className="sas-input-group" style={{ gridColumn: "1 / -1" }}>
                  <label className="sas-input-label" htmlFor="co-tn">{t("company.trade_name")}</label>
                  <input className="sas-input" id="co-tn" name="tradeName" defaultValue={account.tradeName} required maxLength={TRADE_NAME_MAX} aria-describedby="co-tn-hint" />
                  <span className="sas-hint" id="co-tn-hint">{t("company.trade_name_hint")}</span>
                </div>
                <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
                  <LocalNames
                    id="co-names" inputPrefix="tradeNameLocal" rows={tradeRows} what={t("names.col_trade")} column={t("names.col_trade")} maxLength={TRADE_NAME_MAX}
                    hint={t("names.trade_hint")}
                  />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="co-lg">{t("company.legal_name")}</label>
                  <input className="sas-input" id="co-lg" name="legalName" defaultValue={account.legalName ?? ""} maxLength={160} />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="co-id">{t("company.company_id")}</label>
                  <input className="sas-input sas-num" id="co-id" name="companyId" defaultValue={account.companyId ?? ""} maxLength={40} />
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="co-ad">{t("company.address")}</label>
                  <input className="sas-input" id="co-ad" name="address" defaultValue={account.address ?? ""} maxLength={300} />
                </div>
              </div>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="dlv-h" id="delivery" data-delivery-section="">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="dlv-h" className="sas-heading">{t("company.delivery")}</h2>
              <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px" }} aria-describedby="dlv-hint">
                <legend className="sas-sr">{t("company.delivery.lead_time")}</legend>
                <span className="sas-input-label" aria-hidden="true">{t("company.delivery.lead_time")}:</span>
                <span>{t("company.delivery.from")}</span>
                <input className="sas-input sas-num" type="number" name="minDays" min={0} max={MAX_LEAD_DAYS} step={1} inputMode="numeric" defaultValue={lead ? lead.minDays : ""} aria-label={t("company.delivery.min_label")} style={{ width: 88 }} />
                <span>{t("company.delivery.to")}</span>
                <input className="sas-input sas-num" type="number" name="maxDays" min={0} max={MAX_LEAD_DAYS} step={1} inputMode="numeric" defaultValue={lead ? lead.maxDays : ""} aria-label={t("company.delivery.max_label")} style={{ width: 88 }} />
                <span>{t("company.delivery.days")}</span>
              </fieldset>
              <span className="sas-hint" id="dlv-hint">{t("company.delivery.hint")}</span>
              <div className="sas-stack-2" style={{ gap: 2 }}>
                <label className="sas-check"><input type="checkbox" name="businessDays" defaultChecked={lead ? lead.businessDays : true} aria-describedby="dlv-bd-hint" />{t("company.delivery.business")}</label>
                <span className="sas-hint" id="dlv-bd-hint">{t("company.delivery.business_hint")}</span>
              </div>
              {example ? <span className="sas-small" data-delivery-example="">{t("company.delivery.example", { range: example })}</span> : null}
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="mk-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="mk-h" className="sas-heading">{t("company.markets")}</h2>
              <dl className="sas-grid-2" style={{ gap: 16, margin: 0 }}>
                <div className="sas-stack-2">
                  <dt className="sas-input-label">{t("company.languages")}</dt>
                  <dd style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {account.languages.map((l) => <span key={l} className="sas-pill sas-pill--agent">{LANG_NAME[l] ?? l}</span>)}
                  </dd>
                </div>
                <div className="sas-stack-2">
                  <dt className="sas-input-label">{t("company.timezone")}</dt>
                  <dd style={{ margin: 0 }} data-timezone={account.timezone}>{timezoneLabel(account.timezone)}</dd>
                </div>
                <div className="sas-stack-2">
                  <dt className="sas-input-label">{t("company.currency")}</dt>
                  <dd style={{ margin: 0 }} data-currency={account.currency}>{currencyLabel(account.currency)}</dd>
                </div>
              </dl>
              <span className="sas-small">{t("company.markets_note")}</span>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="ag-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="ag-h" className="sas-heading">{t("company.agent")}</h2>
              <div className="sas-stack-2">
                <span className="sas-input-label">{t("company.agent_name")}</span>
                <span style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                  <strong>{playbook.agentName}</strong>
                  {heAgent ? <bdi lang="he" dir="rtl">{heAgent}</bdi> : null}
                  <a href={`${base}/setup/playbook`}>{t("company.agent_edit")}</a>
                </span>
              </div>
              {/* Set by the platform: the fixed words muted, the seller's agent name tinted (as in the Opening preview). */}
              <PlatformFixed>
                <span data-agent-intro="">
                  {introBefore}<span data-part="seller" style={{ background: "var(--primary-soft)", color: "var(--primary)", borderRadius: 4, paddingInline: 3 }}><bdi>{playbook.agentName}</bdi></span>{introAfter}
                </span>
                <span style={{ display: "block", marginTop: 4 }}>{t("company.agent_disclosure")}</span>
              </PlatformFixed>
            </div>
          </section>
        </div>

        <div className="sas-split__side sas-stack-4" style={{ gap: 24, display: "flex", flexDirection: "column" }}>
          <section className="sas-panel" aria-labelledby="br-h">
            <div className="sas-panel__body sas-stack-4">
              <div className="sas-stack-2" style={{ gap: 2 }}>
                <h2 id="br-h" className="sas-heading">{t("company.brand")}</h2>
                <span className="sas-small">{t("company.brand_body")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span aria-hidden="true" style={{ width: 56, height: 56, borderRadius: 12, background: settings.brandColor, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 18, flex: "none" }}>{brandInitials(account.tradeName)}</span>
                <span className="sas-small">{t("company.logo_later")}</span>
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="co-bc">{t("company.brand_color")}</label>
                <input className="sas-input" id="co-bc" name="brandColor" type="color" defaultValue={settings.brandColor} style={{ padding: 2, maxWidth: 140 }} />
                <span className="sas-hint">{t("company.brand_hint")}</span>
                {lowContrast ? <span className="sas-error">{t("company.brand_low_contrast")}</span> : null}
              </div>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="pp-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="pp-h" className="sas-heading">{t("company.people")}</h2>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="co-rep">{t("company.rep")}</label>
                <select className="sas-select" id="co-rep" name="salesRepUserId" defaultValue={account.salesRepUserId ?? ""}>
                  <option value="">{t("company.rep_none")}</option>
                  {members.map(({ user }) => <option key={user.id} value={user.id}>{displayName(user)}</option>)}
                </select>
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="co-sup">{t("company.support")}</label>
                <input className="sas-input" id="co-sup" name="supportContact" defaultValue={account.supportContact ?? ""} maxLength={200} placeholder={t("company.support_placeholder")} />
                <span className="sas-hint">{t("company.support_hint")}</span>
              </div>
            </div>
          </section>
          <div><button type="submit" className={buttonClass("primary")}>{t("company.save")}</button></div>
        </div>
      </form>
    </main>
  );
}
