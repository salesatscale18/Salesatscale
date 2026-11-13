import { Button, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listMembers } from "@/lib/accounts/service";
import { whiteContrast } from "@/lib/accounts/company";
import { listVersions } from "@/lib/agent/service";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { getOrderFormSettings } from "@/lib/orders/settings";
import { displayName } from "@/lib/auth/display";
import { t } from "@/lib/i18n";
import { saveCompanyAction } from "./actions";

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
  const [members, settings, versions] = await Promise.all([listMembers(appDb, account.id), getOrderFormSettings(appDb, account.id), listVersions(appDb, account.id)]);
  const base = `/app/${account.slug}`;
  // The agent name lives in the playbook draft (or the live version); read it, never create a draft here.
  const playbook = (versions.find((v) => v.status === "draft") ?? versions.find((v) => v.status === "live"))?.playbook ?? defaultPlaybook(account.tradeName, account.maxDiscountBp);
  const lowContrast = whiteContrast(settings.brandColor) < 4.5;

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
        <SetupSteps basePath={base} current="company" completed={new Set()} />
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
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="co-tn">{t("company.trade_name")}</label>
                  <input className="sas-input" id="co-tn" name="tradeName" defaultValue={account.tradeName} required maxLength={120} />
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
                  <dd style={{ margin: 0 }}>{account.timezone}</dd>
                </div>
                <div className="sas-stack-2">
                  <dt className="sas-input-label">{t("company.currency")}</dt>
                  <dd style={{ margin: 0 }} className="sas-num">{account.currency}</dd>
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
                  <a href={`${base}/setup/playbook`}>{t("company.agent_edit")}</a>
                </span>
              </div>
              <div style={{ background: "var(--agent-soft)", borderRadius: "var(--radius-md)", padding: "12px 14px" }}>{t("company.agent_preview", { name: playbook.agentName })}</div>
              <span className="sas-small">{t("company.agent_disclosure")}</span>
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
