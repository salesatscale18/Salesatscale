import { notFound } from "next/navigation";
import { Avatar, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { DealStateFields, Timeline, type TimelineItem } from "@/components/sas/record";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { verifyFieldAction } from "../actions";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName, nameInitials } from "@/lib/auth/display";
import { getLead, latestConsent, listLeadEvents } from "@/lib/leads/service";
import { maskPhone } from "@/lib/leads/rules";
import { exactTime, relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { OptOutButton } from "./opt-out";
import { displayQuoteStatus, quotesForLead } from "@/lib/quotes/service";
import { formatMoney } from "@/lib/domain/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_ICON: Record<string, IconName> = {
  "lead.created": "user-plus",
  "lead.updated": "file-text",
  "consent.recorded": "shield-check",
  "lead.opted_out": "x-circle",
  "quote.created": "file-text",
  "quote.versioned": "file-text",
  "quote.approved": "check-circle",
  "quote.cancelled": "archive",
  "handoff.requested": "user",
  "deal.verified": "shield-check",
};

/** Lead card (canvas: Main, LeadEmpty). Conversation, deal state and quotes arrive in P4–P6. */
export default async function LeadCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; leadId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account: slug, leadId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  if (!UUID.test(leadId)) notFound();
  const row = await getLead(appDb, account.id, leadId);
  if (!row) notFound();
  const { lead, owner, creator } = row;
  const [events, consent, leadQuotes, playbook, deal] = await Promise.all([
    listLeadEvents(appDb, account.id, lead.id),
    latestConsent(appDb, account.id, lead.id),
    quotesForLead(appDb, account.id, lead.id),
    currentPlaybook(appDb, account.id),
    getDealState(appDb, account.id, lead.id),
  ]);
  const now = new Date();
  const source = lead.sourceLabel ?? t(`lead.origin.${lead.origin}`);

  const timeline: TimelineItem[] = events.map(({ event, user }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: EVENT_ICON[event.type] ?? "cog",
    title: t(`lead.event.${event.type}` as MessageKey),
    detail:
      event.type.startsWith("quote.")
        ? `Q-${String((event.data as { number?: number } | null)?.number ?? "")}${(event.data as { version?: number } | null)?.version ? ` v${(event.data as { version?: number }).version}` : ""}${user ? ` · ${displayName(user)}` : event.actor === "agent" ? " · Agent" : ""}`
        : event.type === "consent.recorded"
        ? String((event.data as { source?: string } | null)?.source ?? "")
        : user
          ? displayName(user)
          : event.type === "lead.created" || event.type === "lead.updated"
            ? t(`lead.origin.${String((event.data as { origin?: string } | null)?.origin ?? "manual")}` as MessageKey)
            : undefined,
    time: relativeTime(event.createdAt, now),
  }));

  let chatNote: string;
  if (lead.status === "opted_out") chatNote = t("lead.card.opted_out");
  else if (owner) chatNote = t("lead.card.human_owner", { name: displayName(owner) });
  else chatNote = t("lead.card.wait_live");

  return (
    <main className="sas-shell__content">
      {sp.existing === "1" ? (
        <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lead.card.existing")}</span></div>
      ) : null}
      <section className="sas-panel sas-lead">
        <header className="sas-lead__head">
          <Avatar actor="buyer" initials={nameInitials(lead.fullName)} />
          <div className="sas-stack-2" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <div className="sas-page-head" style={{ gap: 8 }}>
              <h1 className="sas-title">{lead.fullName}{lead.company ? ` · ${lead.company}` : ""}</h1>
              <StatusPill object="lead" state={lead.status} />
            </div>
            <span className="sas-small">
              {t(`lang.${lead.language as "en" | "he"}`)} · <span className="sas-num" dir="ltr">{maskPhone(lead.phone)}</span> ·{" "}
              {creator
                ? t("lead.card.added", { source, who: displayName(creator), when: relativeTime(lead.createdAt, now) })
                : t("lead.card.added_system", { source, when: relativeTime(lead.createdAt, now) })}
            </span>
          </div>
        </header>
        <div className="sas-lead__body">
          <div className="sas-lead__main">
            <div className="sas-empty sas-lead__chat">
              <span className="sas-empty__icon sas-empty__icon--agent"><Icon name="message-circle" /></span>
              <strong>{t("lead.card.no_messages")}</strong>
              <span className="sas-small">{chatNote}</span>
            </div>
            <section aria-labelledby="lq-h" style={{ borderBlockEnd: "1px solid var(--line)" }}>
              <div className="sas-page-head" style={{ padding: "16px 16px 4px" }}>
                <h2 id="lq-h" className="sas-label" style={{ margin: 0 }}>{t("lead.card.quotes")}</h2>
                {lead.status !== "opted_out" ? <a className={`${buttonClass("secondary", "sm")} sas-page-head__actions`} href={`/app/${account.slug}/leads/${lead.id}/quote`}><Icon name="file-text" />{t("lead.card.create_quote")}</a> : null}
              </div>
              {leadQuotes.length === 0 ? <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("lead.card.no_quotes")}</p> : (
                <ul className="sas-list">
                  {leadQuotes.map(({ quote, version }) => (
                    <li key={quote.id}>
                      <a className="sas-list__row" href={`/app/${account.slug}/orders?quote=${quote.id}`}>
                        <span className="sas-num">Q-{quote.number} v{quote.currentVersion}</span>
                        <span className="sas-list__main sas-num sas-small">{version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId ? t("quote.to_price") : `${formatMoney(version.oneTimeTotalMinor, version.currency)}${version.recurringTotalMinor ? ` + ${formatMoney(version.recurringTotalMinor, version.currency, { period: "month" })}` : ""}`}</span>
                        <StatusPill object="quote" state={displayQuoteStatus(quote.status, version.validUntil, now)} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div>
              <h2 className="sas-group-label">{t("lead.card.timeline")}</h2>
              <Timeline label={t("lead.card.timeline")} items={timeline} />
            </div>
          </div>
          <aside className="sas-lead__side">
            <h2 className="sas-group-label">{t("lead.card.learn")}</h2>
            {sp.verified ? <div className="sas-alert sas-alert--success" role="status" style={{ margin: "0 16px 12px" }}><Icon name="check-circle" /><span>{t("lead.card.verified_saved")}</span></div> : null}
            {!playbook || playbook.fields.length === 0 ? (
              <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t(playbook ? "lead.card.learn_none" : "lead.card.learn_pending")}</p>
            ) : (
              <div className="sas-stack-4" style={{ padding: "0 16px 16px" }}>
                <DealStateFields fields={playbook.fields.map((f) => ({ key: f.key, label: f.label, value: deal?.fields[f.key]?.value, provenance: deal?.fields[f.key]?.provenance }))} />
                {deal?.objections.length ? (
                  <div className="sas-stack-2">
                    <span className="sas-group-label">{t("lead.card.objections")}</span>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>{deal.objections.map((o, i) => <li key={i}>{o.text}{o.handled ? " ✓" : ""}</li>)}</ul>
                  </div>
                ) : null}
                {deal?.nextStep ? <div className="sas-stack-2"><span className="sas-group-label">{t("lead.card.next_step")}</span><span>{deal.nextStep}</span></div> : null}
                <details>
                  <summary className="sas-small">{t("lead.card.verify")}</summary>
                  <form action={verifyFieldAction} className="sas-stack-2" style={{ paddingBlockStart: 8 }}>
                    <input type="hidden" name="slug" value={account.slug} />
                    <input type="hidden" name="leadId" value={lead.id} />
                    <select className="sas-select" name="key" aria-label={t("lead.card.verify")}>
                      {playbook.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <input className="sas-input" name="value" required maxLength={300} aria-label={t("lead.card.verify_value")} />
                    <div><button type="submit" className={buttonClass("secondary", "sm")}><Icon name="shield-check" />{t("lead.card.verify")}</button></div>
                  </form>
                </details>
              </div>
            )}
            <div className="sas-lead__consent">
              <Icon name="shield-check" />
              <div className="sas-stack-2" style={{ flex: 1 }}>
              <span>
                {consent
                  ? t("lead.card.consent", {
                      source: consent.consent.source,
                      date: exactTime(consent.consent.capturedAt),
                      who: consent.recordedBy ? displayName(consent.recordedBy) : t("lead.origin.webhook"),
                    })
                  : t("lead.card.consent_none")}
              </span>
              {lead.status !== "opted_out" ? <OptOutButton slug={account.slug} leadId={lead.id} /> : null}
              </div>
            </div>
          </aside>
        </div>
      </section>
      <a className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/leads`} style={{ alignSelf: "flex-start" }}>{t("import.back")}</a>
    </main>
  );
}
