import { Chip, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { requireAccount } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { t } from "@/lib/i18n";
import { ImportForm } from "./import-form";

/** CSV import (P2.4, canvas: ImportCsv). */
export default async function ImportLeadsPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account, user } = await requireAccount(slug);
  const leadsHref = `/app/${account.slug}/leads`;
  return (
    <main className="sas-shell__content">
      <header className="sas-page-head">
        <div className="sas-stack-2" style={{ gap: 2 }}>
          <nav aria-label="Breadcrumb" className="sas-small"><a href={leadsHref}>{t("leads.title")}</a> / {t("import.breadcrumb")}</nav>
          <h1 className="sas-title">{t("import.title")}</h1>
        </div>
        <div className="sas-page-head__actions"><a className={buttonClass("primary")} href={leadsHref}>{t("import.go_to_leads")}</a></div>
      </header>
      <div className="sas-split">
        <div className="sas-split__main"><ImportForm slug={account.slug} who={displayName(user)} /></div>
        <aside className="sas-panel sas-panel__body sas-stack-4 sas-split__side" aria-labelledby="fmt-h">
          <h2 id="fmt-h" className="sas-heading">{t("import.format")}</h2>
          <a className={buttonClass("secondary", "sm")} href="/leads-template.csv" download style={{ alignSelf: "flex-start" }}><Icon name="download" />{t("import.download_template")}</a>
          <div className="sas-stack-2"><strong>{t("import.required")}</strong><span className="sas-chips"><Chip>full_name</Chip><Chip>phone</Chip><Chip>language</Chip></span></div>
          <div className="sas-stack-2"><strong>{t("import.consent_cols")}</strong><span className="sas-chips"><Chip>consent_source</Chip><Chip>consent_text</Chip><Chip>consent_at</Chip></span></div>
          <div className="sas-stack-2"><strong>{t("import.optional")}</strong><span className="sas-chips"><Chip>business</Chip><Chip>email</Chip><Chip>source_id</Chip></span></div>
          <span className="sas-small">{t("import.rules")}</span>
        </aside>
      </div>
    </main>
  );
}
