import { buttonClass } from "@/components/sas/primitives";
import { requireAccount } from "@/lib/auth/account";
import { CSV_TEMPLATE_HEADER } from "@/lib/leads/rules";
import { t } from "@/lib/i18n";
import { ImportForm } from "./import-form";

/** CSV import (P2.4). Rows without consent are rejected with the reason. */
export default async function ImportLeadsPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  return (
    <main className="sas-shell__content" style={{ maxWidth: 880 }}>
      <header className="sas-stack-2">
        <h1 className="sas-title">{t("import.title")}</h1>
        <p className="sas-small" style={{ margin: 0 }}>{t("import.intro")}</p>
        <code className="sas-copy">{t("import.template", { columns: CSV_TEMPLATE_HEADER })}</code>
      </header>
      <ImportForm slug={account.slug} />
      <a className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/leads`} style={{ alignSelf: "flex-start" }}>{t("import.back")}</a>
    </main>
  );
}
