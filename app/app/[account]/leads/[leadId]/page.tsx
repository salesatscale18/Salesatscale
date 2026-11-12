import { notFound } from "next/navigation";
import { Avatar, Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { Timeline, type TimelineItem } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName, nameInitials } from "@/lib/auth/display";
import { getLead, latestConsent, listLeadEvents } from "@/lib/leads/service";
import { maskPhone } from "@/lib/leads/rules";
import { exactTime, relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { optOutLeadAction } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_ICON: Record<string, IconName> = {
  "lead.created": "user-plus",
  "lead.updated": "file-text",
  "consent.recorded": "shield-check",
  "lead.opted_out": "x-circle",
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
  const [events, consent] = await Promise.all([listLeadEvents(appDb, account.id, lead.id), latestConsent(appDb, account.id, lead.id)]);
  const now = new Date();
  const source = lead.sourceLabel ?? t(`lead.origin.${lead.origin}`);

  const timeline: TimelineItem[] = events.map(({ event, user }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: EVENT_ICON[event.type] ?? "cog",
    title: t(`lead.event.${event.type}` as MessageKey),
    detail:
      event.type === "consent.recorded"
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
            <div>
              <h2 className="sas-group-label">{t("lead.card.timeline")}</h2>
              <Timeline label={t("lead.card.timeline")} items={timeline} />
            </div>
          </div>
          <aside className="sas-lead__side">
            <h2 className="sas-group-label">{t("lead.card.learn")}</h2>
            <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("lead.card.learn_pending")}</p>
            <div className="sas-lead__consent">
              <Icon name="shield-check" />
              <span>
                {consent
                  ? t("lead.card.consent", {
                      source: consent.consent.source,
                      date: exactTime(consent.consent.capturedAt),
                      who: consent.recordedBy ? displayName(consent.recordedBy) : t("lead.origin.webhook"),
                    })
                  : t("lead.card.consent_none")}
              </span>
            </div>
            {lead.status !== "opted_out" ? (
              <form action={optOutLeadAction} className="sas-stack-2" style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="leadId" value={lead.id} />
                <Button type="submit" variant="danger" size="sm" icon="x-circle">{t("lead.card.opt_out")}</Button>
                <span className="sas-hint">{t("lead.card.opt_out_hint")}</span>
              </form>
            ) : null}
          </aside>
        </div>
      </section>
      <a className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/leads`} style={{ alignSelf: "flex-start" }}>{t("import.back")}</a>
    </main>
  );
}
