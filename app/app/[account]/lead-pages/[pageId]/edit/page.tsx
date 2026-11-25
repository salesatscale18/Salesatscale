import { notFound } from "next/navigation";
import { Icon } from "@/components/sas/icon";
import { StatusPill } from "@/components/sas/primitives";
import { appDb, requireAccount } from "@/lib/auth/account";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/list-kit";
import { publicUrl } from "@/lib/orders/token";
import { getLeadPage } from "@/lib/lead-pages/service";
import { BANNER_ERROR } from "@/lib/lead-pages/view";
import { formData } from "../../form-data";
import { LeadPageFormView } from "../../page-form";
import "../../lead-pages.css";

/** Lead pages › one page › Edit (the same form as Add a page). */
export default async function EditLeadPage({ params, searchParams }: {
  params: Promise<{ account: string; pageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account: slug, pageId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const page = await getLeadPage(appDb, account.id, pageId);
  if (!page) notFound();
  const d = await formData(appDb, account);
  const base = `/app/${account.slug}/lead-pages`;
  const bannerError = BANNER_ERROR[firstParam(sp, "banner_error") ?? ""];
  return (
    <main className="sas-shell__content lpg-page">
      <header className="sas-stack-2">
        <nav aria-label={t("lead_pages.breadcrumb")} className="sas-small">
          <a href={base}>{t("nav.lead_pages")}</a> / <a href={`${base}/${page.id}`}><bdi>{page.name}</bdi></a>
        </nav>
        <div className="lpg-title">
          <h1 className="sas-title">{t("lead_pages.edit.title")}</h1>
          <StatusPill object="lead_page" state={page.status} />
        </div>
      </header>
      {bannerError ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-banner-error="">
          <Icon name="alert-triangle" />
          <span>{t("lead_pages.banner.not_saved", { reason: t(bannerError) })}</span>
        </div>
      ) : null}
      {firstParam(sp, "saved") === "banner_removed" ? (
        <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lead_pages.saved.banner_removed")}</span></div>
      ) : null}
      <LeadPageFormView
        slug={account.slug} page={page} markets={d.markets} languages={account.languages} topics={d.topics} defaultTopic={d.defaultTopic}
        consentDefault={d.consentDefault} bannerUploads={d.bannerUploads} hostedUrl={publicUrl(`/p/${page.publicKey}`)} appBase={publicUrl("/")}
      />
    </main>
  );
}
