import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth/account";
import { t } from "@/lib/i18n";
import { AdminShell } from "../../admin-shell";
import { CreateAccountForm } from "./create-account-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New account — Sales at Scale", robots: { index: false, follow: false } };

/** Canvas: AdminCreateAccount. Platform admin only (server-side check here and in the action). */
export default async function NewAccountPage() {
  const me = await requireSuperAdmin();
  const timezones = Intl.supportedValuesOf("timeZone");
  return (
    <AdminShell me={me}>
      <main className="sas-shell__content" style={{ maxWidth: 960 }}>
        <header className="sas-stack-2">
          <h1 className="sas-title">{t("admin.create.title")}</h1>
          <p className="sas-small">{t("admin.create.intro")}</p>
        </header>
        <CreateAccountForm timezones={timezones} />
      </main>
    </AdminShell>
  );
}
