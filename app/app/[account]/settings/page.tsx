import { headers } from "next/headers";
import { Button, StatusPill } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listDeliveries, listIntakeKeys } from "@/lib/leads/service";
import { relativeTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { revokeIntakeKeyAction } from "./actions";
import { IntakeKeyForm } from "./key-form";
import { SampleCheck } from "./sample-check";

async function baseUrl() {
  const configured = process.env.APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
}

const EXAMPLE = `{
  "full_name": "Rina Cohen",
  "phone": "+972545551842",
  "language": "he",
  "business": "Rina's Kitchen",
  "source_id": "form-88213",
  "consent": {
    "source": "yoursite.example/contact",
    "text": "I agree to be contacted on WhatsApp…",
    "at": "2026-11-09T09:12:00Z"
  }
}`;

/** Settings › Lead intake (P2.5, canvas: LeadIntake). Other sections arrive in later phases. */
export default async function SettingsPage({ params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  const [keys, deliveries] = await Promise.all([listIntakeKeys(appDb, account.id), listDeliveries(appDb, account.id)]);
  const endpoint = `${await baseUrl()}/api/leads/${account.slug}`;
  const now = new Date();
  return (
    <main className="sas-shell__content">
      <h1 className="sas-title">{t("settings.title")}</h1>
      <div className="sas-split">
        <nav aria-label={t("settings.sections")} className="sas-subnav">
          <a className="sas-subnav__item" href={`/app/${account.slug}/settings`} aria-current="page">{t("settings.section.intake")}</a>
          <span className="sas-subnav__soon">{t("settings.section.later")}</span>
        </nav>
        <div className="sas-split__main" style={{ flexBasis: 520 }}>
          <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="ep-h">
            <div className="sas-stack-2" style={{ gap: 2 }}>
              <h2 id="ep-h" className="sas-heading">{t("settings.intake.title")}</h2>
              <span className="sas-small">{t("settings.intake.body")}</span>
            </div>
            <label className="sas-small" htmlFor="endpoint">{t("settings.intake.endpoint")}</label>
            <div className="sas-well">
              <input id="endpoint" className="sas-input" readOnly value={endpoint} />
              <CopyButton value={endpoint} />
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="k-h" style={{ overflow: "hidden" }}>
            <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
              <h2 id="k-h" className="sas-heading">{t("settings.intake.keys")}</h2>
              <span className="sas-small">{t("settings.intake.keys_hint")}</span>
            </div>
            <IntakeKeyForm slug={account.slug} />
            {keys.length === 0 ? (
              <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("settings.intake.none")}</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table" style={{ minWidth: 560 }}>
                  <thead><tr><th scope="col">{t("settings.intake.col.name")}</th><th scope="col">{t("settings.intake.col.key")}</th><th scope="col">{t("settings.intake.col.created")}</th><th scope="col">{t("settings.intake.col.last_used")}</th><th scope="col"><span className="sas-sr">{t("settings.intake.revoke")}</span></th></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}>
                        <td><strong>{k.name}</strong></td>
                        <td className="sas-num">{k.keyPrefix}…{k.keyLast4 ?? ""}</td>
                        <td className="sas-small">{relativeTime(k.createdAt, now)}</td>
                        <td className="sas-small">{k.lastUsedAt ? relativeTime(k.lastUsedAt, now) : t("settings.intake.never")}</td>
                        <td style={{ textAlign: "end" }}>
                          <form action={revokeIntakeKeyAction}>
                            <input type="hidden" name="slug" value={account.slug} />
                            <input type="hidden" name="keyId" value={k.id} />
                            <Button type="submit" size="sm" variant="danger">{t("settings.intake.revoke")}</Button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="sas-panel" aria-labelledby="d-h" style={{ overflow: "hidden" }}>
            <div className="sas-panel__body"><h2 id="d-h" className="sas-heading">{t("settings.intake.deliveries")}</h2></div>
            {deliveries.length === 0 ? (
              <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("settings.intake.deliveries_none")}</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sas-table" style={{ minWidth: 560 }}>
                  <thead><tr><th scope="col">{t("settings.intake.col.received")}</th><th scope="col">{t("settings.intake.col.lead")}</th><th scope="col">{t("settings.intake.col.result")}</th><th scope="col">{t("settings.intake.col.key")}</th></tr></thead>
                  <tbody>
                    {deliveries.map(({ delivery, key }) => (
                      <tr key={delivery.id}>
                        <td className="sas-num sas-small" title={delivery.createdAt.toISOString()}>{relativeTime(delivery.createdAt, now)}</td>
                        <td>{delivery.leadId ? <a href={`/app/${account.slug}/leads/${delivery.leadId}`}>{delivery.leadName ?? t("settings.intake.no_name")}</a> : delivery.leadName ?? t("settings.intake.no_name")}</td>
                        <td style={{ whiteSpace: "normal" }}><StatusPill object="intake_result" state={delivery.result} />{delivery.reason ? <span className="sas-small"> {delivery.reason}</span> : null}</td>
                        <td className="sas-small">{key ? (key.revokedAt ? t("settings.intake.revoked_key") : key.name) : t("settings.intake.revoked_key")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <aside className="sas-panel sas-panel__body sas-stack-4 sas-split__side" aria-labelledby="s-h">
          <h2 id="s-h" className="sas-heading">{t("settings.intake.sends")}</h2>
          <span className="sas-small">{t("settings.intake.sends_body")}</span>
          <pre className="sas-code">{EXAMPLE}</pre>
          <span className="sas-small">{t("settings.intake.required")}</span>
          <SampleCheck slug={account.slug} example={EXAMPLE} />
          <span className="sas-hint">{t("settings.intake.docs")}</span>
        </aside>
      </div>
    </main>
  );
}
