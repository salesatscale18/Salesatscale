import { appDb, requireAccount } from "@/lib/auth/account";
import { t } from "@/lib/i18n";
import { formData } from "../form-data";
import { LeadPageFormView } from "../page-form";
import "../lead-pages.css";

/** Lead pages › Add a page (board: LeadPageConnect; phase 1: Button or link only). */
export default async function NewLeadPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  const d = await formData(appDb, account);
  const base = `/app/${account.slug}/lead-pages`;
  return (
    <main className="sas-shell__content lpg-page">
      <header className="sas-stack-2">
        <nav aria-label={t("lead_pages.breadcrumb")} className="sas-small"><a href={base}>{t("nav.lead_pages")}</a></nav>
        <h1 className="sas-title">{t("lead_pages.new.title")}</h1>
        <span className="sas-small">{t("lead_pages.new.intro")}</span>
      </header>
      <LeadPageFormView
        slug={account.slug} page={null} markets={d.markets} languages={account.languages} topics={d.topics} defaultTopic={d.defaultTopic}
        consentDefault={d.consentDefault} bannerUploads={d.bannerUploads} hostedUrl={null}
      />
    </main>
  );
}
