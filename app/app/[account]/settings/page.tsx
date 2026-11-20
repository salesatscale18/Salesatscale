import { ScrollCurrentIntoView } from "@/components/sas/scroll-current";
import { headers } from "next/headers";
import { Avatar, Button, StatusPill } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listAccountUsers, listPendingInvites, type AccountAccess } from "@/lib/accounts/service";
import { notificationsOrDefault } from "@/lib/accounts/company";
import { contactHoursOrDefault, summarizeContactHours } from "@/lib/accounts/contact-hours";
import { ContactHoursFields } from "@/components/sas/contact-hours-fields";
import { getOrderFormSettings } from "@/lib/orders/settings";
import { listDeliveries, listIntakeKeys } from "@/lib/leads/service";
import { displayName, initials, personName } from "@/lib/auth/display";
import { currencyLabel, formatLocalDateTime, safeTimezone, timeAgo, timezoneLabel, zoneTitle } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { NOTIFICATION_EVENTS, type NotificationEvent, type SellerAccount } from "@/db/schema";
import { removeMemberAction, revokeIntakeKeyAction, saveContactHoursAction, saveNotificationsAction, setIntakeKeyMarketAction } from "./actions";
import { listMarkets } from "@/lib/markets/service";
import { IntakeKeyForm } from "./key-form";
import { InviteUserForm, RenewInvite } from "./users";
import { SampleCheck } from "./sample-check";
import { WhatsAppSection } from "./whatsapp";
import { SimulationSection } from "./simulation";
import { VoiceSection } from "./voice";
import { voiceMode } from "@/lib/voice/settings";
import { spendStateForRequest, spendTexts } from "@/lib/ai/usage";

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
  "business": "Cohen Trading Ltd",
  "source_id": "form-88213",
  "consent": {
    "source": "yoursite.example/contact",
    "text": "I agree to be contacted on WhatsApp…",
    "at": "2026-11-09T09:12:00Z"
  }
}`;

/** The intake fields, in the order the sample shows them (R4 E6). Descriptions: settings.intake.field.<name with _>. */
const INTAKE_REQUIRED = ["full_name", "phone", "consent.source", "consent.text"] as const;
const INTAKE_OPTIONAL = ["language", "business", "source_id", "consent.at", "email", "country", "source", "consent.page_url"] as const;

const SECTIONS = ["whatsapp", "simulation", "voice", "payments", "users", "notifications", "hours", "intake"] as const;
type Section = (typeof SECTIONS)[number];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Settings (canvas: Settings, LeadIntake). One section at a time, chosen with ?section=. */
export default async function SettingsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = (await searchParams) ?? {};
  const access = await requireAccount(slug);
  const { account } = access;
  const asked = one(sp.section);
  // Voice (live voice) only while voice calls are on for the platform; otherwise the settings are as before.
  const sections = SECTIONS.filter((s) => s !== "voice" || voiceMode() !== "off");
  const section: Section = (sections as readonly string[]).includes(asked) ? (asked as Section) : "users";
  const href = (s: Section) => `/app/${account.slug}/settings?section=${s}`;
  const spend = await spendStateForRequest(appDb, account.id);
  const spendText = spend ? spendTexts(spend) : null;
  return (
    <main className="sas-shell__content">
      <h1 className="sas-title">{t("settings.title")}</h1>
      {spend && spendText ? (
        <section aria-label={t("admin.accounts.ai_usage")} className="sas-stack-2" style={{ gap: 2 }}>
          <strong data-spend-state={spend.state}>
            {spend.costMinor === null
              ? t("settings.ai_usage.no_rate", { usd: spendText.usd, cap: spendText.cap, currency: spend.currency })
              : t("settings.ai_usage", { used: spendText.used, cap: spendText.cap })}
          </strong>
          <span className="sas-small">{t("settings.ai_usage.note")}</span>
        </section>
      ) : null}
      <div className="sas-split">
        <nav aria-label={t("settings.sections")} className="sas-subnav">
          {sections.map((s) => (
            <a key={s} className="sas-subnav__item" href={href(s)} aria-current={s === section ? "page" : undefined}>{t(`settings.section.${s}` as MessageKey)}</a>
          ))}
          <ScrollCurrentIntoView selector=".sas-subnav" />
        </nav>
        {section === "intake" ? (
          await IntakeSection({ account, sp })
        ) : (
          <div className="sas-split__main" style={{ flexBasis: 520 }}>
            {section === "whatsapp" ? await WhatsAppSection({ account, sp, baseUrl: await baseUrl() }) : null}
            {section === "simulation" ? <SimulationSection account={account} saved={one(sp.saved) === "simulation"} /> : null}
            {section === "voice" ? await VoiceSection({ account, saved: one(sp.saved) === "voice" }) : null}
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

/** "2 min ago", with the exact local time and its zone on hover. */
const When = ({ at, now, tz }: { at: Date; now: Date; tz: string }) => (
  <time dateTime={at.toISOString()} title={`${formatLocalDateTime(at, tz)} · ${zoneTitle(at, tz)}`}>{timeAgo(at, now, tz)}</time>
);

const Saved = ({ text }: { text: string }) => <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{text}</span></div>;
const Failed = ({ text }: { text: string }) => <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{text}</span></div>;

async function PaymentsSection({ account }: { account: SellerAccount }) {
  const s = await getOrderFormSettings(appDb, account.id);
  const methods = [s.card ? t("golive.method.card") : null, s.bankTransfer ? t("golive.method.bank") : null].filter(Boolean).join(" · ");
  return (
    <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="pay-h">
      <div className="sas-page-head">
        <h2 id="pay-h" className="sas-heading">{t("settings.payments.title")}</h2>
        <span className="sas-pill" data-test-mode=""><Icon name="flask-conical" />{t("settings.payments.test_mode")}</span>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)", gap: "8px 12px", margin: 0 }}>
        <dt className="sas-small">{t("settings.payments.provider")}</dt><dd style={{ margin: 0 }}>{t("settings.payments.provider_value")}</dd>
        <dt className="sas-small">{t("settings.payments.methods")}</dt><dd style={{ margin: 0 }}>{methods || "-"}</dd>
        <dt className="sas-small">{t("settings.payments.currency")}</dt><dd style={{ margin: 0 }} data-currency={account.currency}>{currencyLabel(account.currency)}</dd>
      </dl>
      <span className="sas-small">{t("settings.payments.edit")} <a href={`/app/${account.slug}/setup/order-form`}>{t("settings.payments.edit_link")}</a></span>
    </section>
  );
}

async function UsersSection({ access, sp }: { access: AccountAccess; sp: Record<string, string | string[] | undefined> }) {
  const { account, user: me } = access;
  // Members plus the signed-in platform admin when acting as, each with their last activity here (one grouped audit query).
  const rows = await listAccountUsers(appDb, account.id, { user: me, actingAs: access.actingAs });
  // Every person the table lists (the acting platform admin too) has no pending invite row (R5-16).
  const invites = await listPendingInvites(appDb, account.id, new Date(), rows.map((r) => r.user.email));
  const owners = rows.filter((r) => r.member?.isOwner).length;
  const err = one(sp.error);
  const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: safeTimezone(account.timezone) });
  const now = new Date();
  return (
    <>
      {sp.removed ? <Saved text={t("settings.users.removed")} /> : null}
      {err ? <Failed text={t(err === "self" ? "settings.users.err.self" : err === "last_owner" ? "settings.users.err.last_owner" : err === "owner_only" ? "settings.users.err.owner_only" : "settings.users.err.not_found")} /> : null}
      <section className="sas-panel" aria-labelledby="usr-h" style={{ overflow: "hidden" }}>
        <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
          <h2 id="usr-h" className="sas-heading">{t("settings.users.title")}</h2>
          <span className="sas-small">{t("settings.users.hint")}</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          {/* On a phone each member is a card (name, then email, role and last active). */}
          <table className="sas-table sas-table--stack" style={{ minWidth: 600 }} data-members>
            <thead>
              <tr>
                <th scope="col">{t("settings.users.col.name")}</th>
                <th scope="col">{t("settings.users.col.email")}</th>
                <th scope="col">{t("settings.users.col.role")}</th>
                <th scope="col">{t("settings.users.col.last_active")}</th>
                <th scope="col"><span className="sas-sr">{t("settings.users.remove")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member, user, lastActiveAt }) => {
                const self = user.id === me.id;
                const lastOwner = !!member?.isOwner && owners <= 1;
                return (
                  <tr key={member?.id ?? `viewer-${user.id}`} data-member={user.id}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <Avatar actor="human" initials={initials(user)} />
                        <span style={{ fontWeight: 600, overflowWrap: "anywhere" }} data-member-name="">{personName(user)}{self ? <span className="sas-small" style={{ fontWeight: 400 }}> · {t("settings.users.you")}</span> : null}</span>
                      </span>
                    </td>
                    <td className="sas-small" data-label={t("settings.users.col.email")} style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{user.email ?? "—"}</td>
                    <td data-label={t("settings.users.col.role")}>
                      <span className="sas-chips">
                        {member ? (
                          <>
                            {member.isOwner ? <span className="sas-chip sas-chip--plain">{t("settings.users.role.owner")}</span> : null}
                            <span className="sas-chip sas-chip--plain">{t("settings.users.role.seller_admin")}</span>
                          </>
                        ) : (
                          <span className="sas-chip sas-chip--plain" style={{ whiteSpace: "nowrap" }} data-acting-tag="">{t("settings.users.platform_acting")}</span>
                        )}
                      </span>
                    </td>
                    <td className="sas-small" data-last-active="" data-label={t("settings.users.col.last_active")}>
                      {lastActiveAt
                        ? <time dateTime={lastActiveAt.toISOString()} title={`${formatLocalDateTime(lastActiveAt, account.timezone)} · ${zoneTitle(lastActiveAt, account.timezone)}`}>{timeAgo(lastActiveAt, now, account.timezone)}</time>
                        : "—"}
                    </td>
                    <td style={{ textAlign: "end" }} data-label="">
                      {!member || self || lastOwner ? null : (
                        <form action={removeMemberAction}>
                          <input type="hidden" name="slug" value={account.slug} />
                          <input type="hidden" name="memberId" value={member.id} />
                          <Button type="submit" size="sm" variant="ghost" aria-label={t("settings.users.remove_who", { name: displayName(user) })}>{t("settings.users.remove")}</Button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="inv-h">
        <h2 id="inv-h" className="sas-sr">{t("settings.users.invite_title")}</h2>
        <InviteUserForm slug={account.slug} timezone={account.timezone} />
        {invites.length > 0 ? (
          <div className="sas-stack-2">
            <strong>{t("settings.users.pending")}</strong>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {invites.map(({ invite, state }) => (
                <li key={invite.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                  <span style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>{invite.inviteeName ? `${invite.inviteeName} · ` : ""}{invite.email}</span>
                  <span className="sas-small">{state === "expired" ? t("settings.users.expired") : t("settings.users.expires", { date: dateFmt.format(invite.expiresAt) })}</span>
                  <RenewInvite slug={account.slug} inviteId={invite.id} timezone={account.timezone} />
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
      <section className="sas-panel" aria-labelledby="ntf-h" style={{ overflow: "hidden" }}>
        <form action={saveNotificationsAction}>
          <input type="hidden" name="slug" value={account.slug} />
          <div className="sas-panel__body"><h2 id="ntf-h" className="sas-heading">{t("settings.notifications.title")}</h2></div>
          {/* Rows divide the whole panel width. */}
          <table className="sas-table" data-notifications="">
            <thead><tr><th scope="col">{t("settings.notifications.event")}</th><th scope="col" style={{ width: 80, textAlign: "center" }}>{t("settings.notifications.email")}</th></tr></thead>
            <tbody>
              {NOTIFICATION_EVENTS.map((e) => (
                <tr key={e}>
                  <th scope="row" style={{ background: "none", textTransform: "none", letterSpacing: 0, font: "inherit", color: "var(--ink)", borderBlockStart: "1px solid var(--line)", paddingBlock: "var(--space-3)" }} data-divider="">{t(EVENT_LABEL[e])}</th>
                  <td style={{ textAlign: "center" }}><input type="checkbox" name={`${e}_email`} defaultChecked={prefs[e].email} aria-label={t("settings.notifications.email_for", { event: t(EVENT_LABEL[e]) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sas-panel__body sas-stack-4" style={{ borderBlockStart: "1px solid var(--line)" }}>
            <span className="sas-hint">{t("settings.notifications.hint")}</span>
            <div><Button type="submit" variant="primary" size="sm">{t("settings.save")}</Button></div>
          </div>
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
          <span className="sas-small">{t("settings.hours.body", { tz: timezoneLabel(account.timezone) })}</span>
          <ContactHoursFields hours={hours} />
          <div><Button type="submit" variant="primary" size="sm">{t("settings.save")}</Button></div>
        </form>
      </section>
    </>
  );
}

/** Settings › Lead intake (P2.5, canvas: LeadIntake). */
async function IntakeSection({ account, sp }: { account: SellerAccount; sp: Record<string, string | string[] | undefined> }) {
  const [keys, deliveries, marketList] = await Promise.all([listIntakeKeys(appDb, account.id), listDeliveries(appDb, account.id), listMarkets(appDb, account.id)]);
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
            <div className="sas-stack-2" style={{ gap: 6 }}>
              <span className="sas-small" id="endpoint-label">{t("settings.intake.endpoint")}</span>
              {/* The whole address, wrapped (as the WhatsApp webhook). */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code id="endpoint" className="sas-num" aria-labelledby="endpoint-label" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{endpoint}</code>
                <CopyButton value={endpoint} />
              </div>
            </div>
          </section>

          {sp.key_market ? <Saved text={t("settings.intake.key_market_saved")} /> : null}
          {sp.key_market_error ? <Failed text={t("settings.intake.key_market_error")} /> : null}
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
                {/* Fits the card at 1440 (R5-3): tighter cells, the market control wraps; phones keep the stacked cards. */}
                <table className="sas-table sas-table--stack sas-keys-table" style={{ fontSize: 13 }} data-intake-keys="">
                  <thead><tr><th scope="col">{t("settings.intake.col.name")}</th><th scope="col">{t("settings.intake.col.market")}</th><th scope="col">{t("settings.intake.col.key")}</th><th scope="col">{t("settings.intake.col.created")}</th><th scope="col">{t("settings.intake.col.last_used")}</th><th scope="col"><span className="sas-sr">{t("settings.intake.revoke")}</span></th></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}>
                        <td style={{ whiteSpace: "normal" }}><strong>{k.name}</strong></td>
                        <td data-label={t("settings.intake.col.market")}>
                          <form action={setIntakeKeyMarketAction} className="sas-keys-table__market" data-key-market={k.id}>
                            <input type="hidden" name="slug" value={account.slug} />
                            <input type="hidden" name="keyId" value={k.id} />
                            <select className="sas-select" name="marketId" defaultValue={k.marketId && marketList.some((m) => m.id === k.marketId) ? k.marketId : ""} aria-label={t("settings.intake.market_for", { name: k.name })}>
                              <option value="">{t("settings.intake.market_auto")}</option>
                              {marketList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                            <Button type="submit" size="sm" variant="ghost">{t("settings.intake.market_link")}</Button>
                          </form>
                        </td>
                        <td className="sas-id" data-label={t("settings.intake.col.key")}>{k.keyPrefix}…{k.keyLast4 ?? ""}</td>
                        <td className="sas-small" data-label={t("settings.intake.col.created")}><When at={k.createdAt} now={now} tz={account.timezone} /></td>
                        <td className="sas-small" data-label={t("settings.intake.col.last_used")}>{k.lastUsedAt ? <When at={k.lastUsedAt} now={now} tz={account.timezone} /> : t("settings.intake.never")}</td>
                        <td style={{ textAlign: "end" }} data-label="">
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
                        <td className="sas-num sas-small"><When at={delivery.createdAt} now={now} tz={account.timezone} /></td>
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
          {/* Wraps long values instead of cutting them off. */}
          <pre className="sas-code" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-intake-sample="">{EXAMPLE}</pre>
          {/* Required and Optional together under the sample (R4 E6): every field the sample shows, the two "source" fields told apart. */}
          {([["required", INTAKE_REQUIRED], ["optional", INTAKE_OPTIONAL]] as const).map(([kind, fields]) => (
            <div key={kind} className="sas-stack-2" style={{ gap: 4 }} data-intake-fields={kind}>
              <strong style={{ fontSize: 13 }}>{t(kind === "required" ? "settings.intake.fields_required" : "settings.intake.fields_optional")}</strong>
              <dl className="st-fields">
                {fields.map((f) => (
                  <div key={f} data-intake-field={f}>
                    <dt><code className="st-mono">{f}</code></dt>
                    <dd className="sas-small">{t(`settings.intake.field.${f.replace(".", "_")}` as MessageKey)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <span className="sas-small" id="intake-optional">{t("settings.intake.rules_note")}</span>
          <SampleCheck slug={account.slug} example={EXAMPLE} />
        </aside>
    </>
  );
}
