import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth/account";
import { t } from "@/lib/i18n";
import { AdminShell } from "../admin-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Operations — Sales at Scale", robots: { index: false, follow: false } };

export default async function OperationsPage() {
  const me = await requireSuperAdmin();
  return (
    <AdminShell me={me}>
      <main className="sas-shell__content">
        <section className="sas-panel">
          <div className="sas-panel__body sas-stack-4">
            <h1 className="sas-title">{t("placeholder.title", { section: t("admin.ops.title") })}</h1>
            <p className="sas-small">{t("placeholder.body", { phase: "P9" })}</p>
          </div>
        </section>
      </main>
    </AdminShell>
  );
}
