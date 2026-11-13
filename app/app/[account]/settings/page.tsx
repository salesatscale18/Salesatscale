import { headers } from "next/headers";
import { Avatar, Button, Chip, StatusPill } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listMembers, listPendingInvites, type AccountAccess } from "@/lib/accounts/service";
import { notificationsOrDefault } from "@/lib/accounts/company";
import { contactHoursOrDefault, summarizeContactHours, WEEKDAYS } from "@/lib/accounts/contact-hours";
import { getOrderFormSettings } from "@/lib/orders/settings";
import { listDeliveries, listIntakeKeys } from "@/lib/leads/service";
import { displayName, initials } from "@/lib/auth/display";
import { relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { NOTIFICATION_EVENTS, type NotificationEvent, type SellerAccount } from "@/db/schema";
import { removeMemberAction, revokeIntakeKeyAction, saveContactHoursAction, saveNotificationsAction } from "./actions";
import { IntakeKeyForm } from "./key-form";
import { InviteUserForm, RenewInvite } from "./users";
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

const SECTIONS = ["whatsapp", "payments", "users", "notifications", "hours", "intake"] as const;
type Section = (typeof SECTIONS)[number];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Settings (canvas: Settings, LeadIntake). One section at a time, chosen with ?section=. */
export default async function SettingsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = (await searchParams) ?? {};
  const access = await requireAccount(slug);
  const { account } = access;
  const asked = one(sp.section);
  const section: Section = (SECTIONS as readonly string[]).includes(asked) ? (asked as Section) : "users";
  const href = (s: Section) => `/app/${account.slug}/settings?section=${s}`;
  return (
    <main className="sas-shell__content">
      <h1 className="sas-title">{t("settings.title")}</h1>
      <div className="sas-split">
        <nav aria-label={t("settings.sections")} className="sas-subnav">
          {SECTIONS.map((s) => (
            <a key={s} className="sas-subnav__item" href={href(s)} aria-current={s === section ? "page" : undefined}>{t(`settings.section.${s}` as MessageKey)}</a>
          ))}
        </nav>
        {section === "intake" ? (
          await IntakeSection({ account })
        ) : (
          <div className="sas-split__main" style={{ flexBasis: 520 }}>
            {section === "whatsapp" ? <WhatsAppSection /> : null}
            {section === "payments" ? await PaymentsSection({ account }) : null}
            {section === "users" ? await UsersSection({ access, sp }) : null}
            {section === "notifications" ? <NotificationsSection account={account} saved={!!sp.saved} /> : null}
            {section === "hours" ? <HoursSection account={account} saved={!!sp.saved} error={one(sp.error)} /> : null}
          </div>
        )}
      </div>
    </main>
  );
}

const Saved = ({ text }: { text: string }) => <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{text}</span></div>;
const Failed = ({ text }: { text: string }) => <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{text}</span></div>;

function WhatsAppSection() {
  return (
    <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="wa-h">
      <div className="sas-page-head">
        <h2 id="wa-h" className="sas-heading">{t("settings.whatsapp.title")}</h2>
        <span className="sas-pill">{t("settings.later_badge")}</span>
      </div>
      <span className="sas-small">{t("settings.whatsapp.later")}</span>
    </section>
  );
}

async function PaymentsSection({ account }: { account: SellerAccount }) {
  const s = await getOrderFormSettings(appDb, account.id);
  const methods = [s.card ? t("golive.method.card") : null, s.bankTransfer ? t("golive.method.bank") : null].filter(Boolean).join(" · ");
  return (
    <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="pay-h">
      <div className="sas-page-head">
        <h2 id="pay-h" className="sas-heading">{t("settings.payments.title")}</h2>
        <span className="sas-pill sas-pill--warning">{t("settings.payments.test_mode")}</span>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)", gap: "8px 12px", margin: 0 }}>
        <dt className="sas-small">{t("settings.payments.provider")}</dt><dd style={{ margin: 0 }}>{t("settings.payments.provider_value")}</dd>
        <dt className="sas-small">{t("settings.payments.methods")}</dt><dd style={{ margin: 0 }}>{methods || "-"}</dd>
        <dt className="sas-small">{t("settings.payments.currency")}</dt><dd style={{ margin: 0 }} className="sas-num">{account.currency}</dd>
      </dl>
      <span className="sas-small">{t("settings.payments.edit")} <a href={`/app/${account.slug}/setup/order-form`}>{t("settings.payments.edit_link")}</a></span>
    </section>
  );
}

async function UsersSection({ access, sp }: { access: AccountAccess; sp: Record<string, string | string[] | undefined> }) {
  const { account, user: me } = access;
  const [members, invites] = await Promise.all([listMembers(appDb, account.id), listPendingInvites(appDb, account.id)]);
  const owners = members.filter((m) => m.member.isOwner).length;
  const err = one(sp.error);
  const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: account.timezone });
  return (
    <>
      {sp.removed ? <Saved text={t("settings.users.removed")} /> : null}
      {err ? <Failed text={t(err === "self" ? "settings.users.err.self" : err === "last_owner" ? "settings.users.err.last_owner" : "settings.users.err.not_found")} /> : null}
      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="usr-h">
        <h2 id="usr-h" className="sas-heading">{t("settings.users.title")}</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="sas-stack-2">
          {members.map(({ member, user }) => {
            const self = user.id === me.id;
            const lastOwner = member.isOwner && owners <= 1;
            return (
              <li key={member.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                <Avatar actor="human" initials={initials(user)} />
                <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600 }}>{displayName(user)}{self ? <span className="sas-small"> · {t("settings.users.you")}</span> : null}</span>
                  <span className="sas-small" style={{ overflowWrap: "anywhere" }}>{user.email}</span>
                </span>
                <span className="sas-chips">
                  {member.isOwner ? <Chip>{t("settings.users.role.owner")}</Chip> : null}
                  <Chip>{t("settings.users.role.seller_admin")}</Chip>
                </span>
                {self || lastOwner ? null : (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="slug" value={account.slug} />
                    <input type="hidden" name="memberId" value={member.id} />
                    <Button type="submit" size="sm" variant="ghost" aria-label={t("settings.users.remove_who", { name: displayName(user) })}>{t("settings.users.remove")}</Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        <span className="sas-small">{t("settings.users.hint")}</span>
      </section>
      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="inv-h">
        <h2 id="inv-h" className="sas-sr">{t("settings.users.invite_title")}</h2>
        <InviteUserForm slug={account.slug} />
        {invites.length > 0 ? (
          <div className="sas-stack-2">
            <strong>{t("settings.users.pending")}</strong>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {invites.map(({ invite, state }) => (
                <li key={invite.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                  <span style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>{invite.inviteeName ? `${invite.inviteeName} · ` : ""}{invite.email}</span>
                  <span className="sas-small">{state === "expired" ? t("settings.users.expired") : t("settings.users.expires", { date: dateFmt.format(invite.expiresAt) })}</span>
                  <RenewInvite slug={account.slug} inviteId={invite.id} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </>
  );
}

const EVENT_LABEL: Record<NotificationEvent, MessageKey> = {
  handoff: "settings.notifications.event.handoff",
  approval: "settings.notifications.event.approval",
  payment_failed: "settings.notifications.event.payment_failed",
  order_paid: "settings.notifications.event.order_paid",
};

function NotificationsSection({ account, saved }: { account: SellerAccount; saved: boolean }) {
  const prefs = notificationsOrDefault(account.notifications);
  return (
    <>
      {saved ? <Saved text={t("settings.notifications.saved")} /> : null}
      <section className="sas-panel" aria-labelledby="ntf-h">
        <form action={saveNotificationsAction} className="sas-panel__body sas-stack-4">
          <input type="hidden" name="slug" value={account.slug} />
          <h2 id="ntf-h" className="sas-heading">{t("settings.notifications.title")}</h2>
          <table className="sas-table">
            <thead><tr><th scope="col">{t("settings.notifications.event")}</th><th scope="col" style={{ width: 80, textAlign: "center" }}>{t("settings.notifications.email")}</th></tr></thead>
            <tbody>
              {NOTIFICATION_EVENTS.map((e) => (
                <tr key={e}>
                  <th scope="row" style={{ background: "none", textTransform: "none", letterSpacing: 0, font: "inherit", color: "var(--ink)" }}>{t(EVENT_LABEL[e])}</th>
                  <td style={{ textAlign: "center" }}><input type="checkbox" name={`${e}_email`} defaultChecked={prefs[e].email} aria-label={t("settings.notifications.email_for", { event: t(EVENT_LABEL[e]) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="sas-hint">{t("settings.notifications.hint")}</span>
          <div><Button type="submit" variant="primary" size="sm">{t("settings.save")}</Button></div>
        </form>
      </section>
    </>
  );
}

function HoursSection({ account, saved, error }: { account: SellerAccount; saved: boolean; error: string }) {
  const hours = contactHoursOrDefault(account.contactHours);
  return (
    <>
      {saved ? <Saved text={t("settings.hours.saved")} /> : null}
      {error ? <Failed text={error} /> : null}
      <section className="sas-panel" aria-labelledby="hrs-h">
        <form action={saveContactHoursAction} className="sas-panel__body sas-stack-4">
          <input type="hidden" name="slug" value={account.slug} />
          <div className="sas-stack-2" style={{ gap: 2 }}>
            <h2 id="hrs-h" className="sas-heading">{t("settings.hours.title")}</h2>
            <span>{summarizeContactHours(hours)}</span>
          </div>
          <span className="sas-small">{t("settings.hours.body", { tz: account.timezone })}</span>
          <div className="sas-stack-2">
            {WEEKDAYS.map((d, i) => (
              <fieldset key={d} style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
                <legend className="sas-sr">{t(`settings.hours.day.${d}` as MessageKey)}</legend>
                <label className="sas-check" style={{ width: 130 }}><input type="checkbox" name={`${d}_on`} defaultChecked={hours[i].on} />{t(`settings.hours.day.${d}` as MessageKey)}</label>
                <label className="sas-small" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{t("settings.hours.from")}<input className="sas-input sas-num" type="time" name={`${d}_from`} defaultValue={hours[i].from} required style={{ width: 120 }} /></label>
                <label className="sas-small" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{t("settings.hours.to")}<input className="sas-input sas-num" type="time" name={`${d}_to`} defaultValue={hours[i].to} required style={{ width: 120 }} /></label>
              </fieldset>
            ))}
          </div>
          <div><Button type="submit" variant="primary" size="sm">{t("settings.save")}</Button></div>
        </form>
      </section>
    </>
  );
}

/** Settings › Lead intake (P2.5, canvas: LeadIntake). */
async function IntakeSection({ account }: { account: SellerAccount }) {
  const [keys, deliveries] = await Promise.all([listIntakeKeys(appDb, account.id), listDeliveries(appDb, account.id)]);
  const endpoint = `${await baseUrl()}/api/leads/${account.slug}`;
  const now = new Date();
  return (
    <>
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
    </>
  );
}
