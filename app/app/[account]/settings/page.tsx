import { headers } from "next/headers";
import { Button } from "@/components/sas/primitives";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listIntakeKeys } from "@/lib/leads/service";
import { exactTime, relativeTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { revokeIntakeKeyAction } from "./actions";
import { IntakeKeyForm } from "./key-form";

async function baseUrl() {
  const configured = process.env.APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
}

/** Settings. For now only lead intake keys (P2.5); the rest arrives in P6. */
export default async function SettingsPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  const keys = await listIntakeKeys(appDb, account.id);
  const endpoint = `${await baseUrl()}/api/leads/${account.slug}`;
  const now = new Date();
  return (
    <main className="sas-shell__content" style={{ maxWidth: 880 }}>
      <header className="sas-stack-2">
        <h1 className="sas-title">{t("settings.title")}</h1>
        <p className="sas-small" style={{ margin: 0 }}>{t("settings.more")}</p>
      </header>
      <section className="sas-panel" aria-labelledby="intake-h">
        <div className="sas-panel__head"><h2 id="intake-h" className="sas-heading">{t("settings.intake.title")}</h2></div>
        <div className="sas-panel__body sas-stack-4">
          <p style={{ margin: 0 }}>{t("settings.intake.body")}</p>
          <div className="sas-stack-2">
            <strong>{t("settings.intake.endpoint")}</strong>
            <code className="sas-copy">POST {endpoint}</code>
            <span className="sas-hint">{t("settings.intake.docs")}</span>
          </div>
          <div className="sas-stack-2">
            <strong>{t("settings.intake.keys")}</strong>
            {keys.length === 0 ? <span className="sas-small">{t("settings.intake.none")}</span> : null}
            <ul className="sas-list">
              {keys.map((k) => (
                <li key={k.id} className="sas-list__row">
                  <span className="sas-list__main">
                    <strong>{k.name}</strong>
                    <span className="sas-small"><span className="sas-num">{k.keyPrefix}…</span> · {t("settings.intake.created", { date: exactTime(k.createdAt) })} · {k.lastUsedAt ? t("settings.intake.last_used", { when: relativeTime(k.lastUsedAt, now) }) : t("settings.intake.never_used")}</span>
                  </span>
                  <form action={revokeIntakeKeyAction}>
                    <input type="hidden" name="slug" value={account.slug} />
                    <input type="hidden" name="keyId" value={k.id} />
                    <Button type="submit" size="sm" variant="danger">{t("settings.intake.revoke")}</Button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
          <IntakeKeyForm slug={account.slug} />
        </div>
      </section>
    </main>
  );
}
