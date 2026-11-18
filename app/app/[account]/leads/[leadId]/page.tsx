import { notFound } from "next/navigation";
import { Avatar, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { DealStateFields, Timeline, type TimelineItem } from "@/components/sas/record";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { setLeadMarketAction, verifyFieldAction } from "../actions";
import { listMarkets } from "@/lib/markets/service";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName, nameInitials } from "@/lib/auth/display";
import { getLead, latestConsent, listLeadEvents } from "@/lib/leads/service";
import { maskPhone } from "@/lib/leads/rules";
import { exactTime, relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { OptOutButton } from "./opt-out";
import { ConversationPanel } from "./conversation";
import { latestConversationForLead } from "@/lib/agent/conversation";
import { WhatsAppStart } from "./whatsapp-start";
import { conversationWindow, openerFacts } from "@/lib/channels/whatsapp";
import { defaultTransport } from "@/lib/channels/twilio";
import { displayQuoteStatus, quotesForLead } from "@/lib/quotes/service";
import { formatMoney } from "@/lib/domain/money";
import { chatLinkStatus, simulatorOpenerFacts } from "@/lib/simulator/service";
import { isSimulatedLead, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { chatPath } from "@/lib/simulator/token";
import { publicUrl } from "@/lib/orders/token";
import { SimulatorPanel } from "./simulator-panel";
import { SimulatedChip } from "../simulated-chip";
import { leadStage } from "@/lib/leads/stage";
import { StageStepper } from "./stage";
import { FollowUpPanel } from "./follow-up";
import { leadFollowUp, mayCancelFollowUps } from "@/lib/follow-ups/schedule";
import { formatDueLocal } from "@/lib/follow-ups/rules";

const quoteTotals = (v: { oneTimeTotalMinor: number; recurringTotalMinor: number; currency: string }) =>
  `${formatMoney(v.oneTimeTotalMinor, v.currency)}${v.recurringTotalMinor ? ` + ${formatMoney(v.recurringTotalMinor, v.currency, { period: "month" })}` : ""}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_ICON: Record<string, IconName> = {
  "lead.created": "user-plus",
  "lead.updated": "file-text",
  "consent.recorded": "shield-check",
  "lead.opted_out": "x-circle",
  "lead.market_changed": "layers",
  "quote.created": "file-text",
  "quote.versioned": "file-text",
  "quote.approved": "check-circle",
  "quote.cancelled": "file-x",
  "handoff.requested": "user",
  "deal.verified": "shield-check",
  "order_form.sent": "send",
  "order_form.opened": "eye",
  "order_form.signed": "pen",
  "payment.bank_transfer": "clock",
  "payment.failed": "x-circle",
  "order.paid": "credit-card",
  "conversation.taken_over": "user",
  "conversation.handed_back": "sparkles",
  "conversation.human_reply": "message-square",
  "conversation.started": "send",
  "follow_up.scheduled": "clock",
  "follow_up.sent": "send",
  "follow_up.cancelled": "x-circle",
  "follow_up.failed": "alert-triangle",
};

/** Lead card (canvas: Main, LeadEmpty): the latest conversation with take over / hand back, deal state, quotes and timeline. */
export default async function LeadCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; leadId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { account: slug, leadId } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account, user: me } = access;
  if (!UUID.test(leadId)) notFound();
  // One parallel batch: every loader is scoped by account, so a lead id from
  // another account just yields empty results before notFound() below.
  const [row, events, consent, leadQuotes, playbook, deal, conversation, marketList, opener, chatLink, simFacts, stage, followUp] = await Promise.all([
    getLead(appDb, account.id, leadId),
    listLeadEvents(appDb, account.id, leadId),
    latestConsent(appDb, account.id, leadId),
    quotesForLead(appDb, account.id, leadId),
    currentPlaybook(appDb, account.id),
    getDealState(appDb, account.id, leadId),
    latestConversationForLead(appDb, account.id, leadId),
    listMarkets(appDb, account.id),
    openerFacts(appDb, defaultTransport(), account.id, leadId),
    chatLinkStatus(appDb, account.id, leadId),
    simulatorOpenerFacts(appDb, account.id, leadId),
    leadStage(appDb, account.id, leadId),
    leadFollowUp(appDb, account.id, leadId),
  ]);
  if (!row) notFound();
  // WhatsApp, and simulated chats with "Simulate WhatsApp rules" on, show the 24-hour window.
  const windowed = conversation?.conversation.channel === "whatsapp" || (conversation?.conversation.channel === SIMULATOR_CHANNEL && account.simulateWhatsappRules);
  const waWindow = conversation && windowed && conversation.conversation.status !== "closed"
    ? await conversationWindow(appDb, account.id, conversation.conversation.id)
    : null;
  const { lead, owner, creator } = row;
  const simulated = isSimulatedLead(lead);
  // A lead without a market belongs to the home market (listMarkets puts it first).
  const leadMarket = (row.market ? marketList.find((m) => m.id === row.market!.id) : null) ?? marketList[0];
  const now = new Date();
  const source = lead.sourceLabel ?? t(`lead.origin.${lead.origin}`);

  const timeline: TimelineItem[] = events.map(({ event, user }) => ({
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: EVENT_ICON[event.type] ?? "cog",
    // A conversation started on the buyer simulator is not a WhatsApp start.
    title: t(event.type === "conversation.started" && (event.data as { channel?: string } | null)?.channel === "simulator" ? "lead.event.conversation.started_sim" : `lead.event.${event.type}` as MessageKey),
    detail:
      event.type.startsWith("quote.") || event.type.startsWith("order_form.")
        ? `Q-${String((event.data as { number?: number } | null)?.number ?? "")}${(event.data as { version?: number } | null)?.version ? ` v${(event.data as { version?: number }).version}` : ""}${user ? ` · ${displayName(user)}` : event.actor === "agent" ? " · Agent" : ""}${(event.data as { reasons?: string[] } | null)?.reasons?.length ? `: ${(event.data as { reasons: string[] }).reasons.join("; ")}` : ""}`
        : event.type === "consent.recorded"
        ? String((event.data as { source?: string } | null)?.source ?? "")
        : event.type === "lead.market_changed"
        ? `${(event.data as { from?: string | null } | null)?.from ?? "-"} → ${(event.data as { to?: string } | null)?.to ?? ""}${user ? ` · ${displayName(user)}` : ""}`
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
              {simulated ? <SimulatedChip /> : null}
              <StatusPill object="lead" state={lead.status} />
            </div>
            <span className="sas-small">
              {/* A simulated buyer has a buyer ID, not a phone (the placeholder is never shown or formatted as one). */}
              {simulated
                ? <span data-testid="buyer-ref">{t("sim.header", { id: "" })}<span className="sas-num" dir="ltr">{lead.buyerRef ?? lead.phone.replace(/^sim:/, "")}</span> · {t(`lang.${lead.language as "en" | "he"}`)} ·{" "}</span>
                : <>{t(`lang.${lead.language as "en" | "he"}`)} · <span className="sas-num" dir="ltr">{maskPhone(lead.phone)}</span> ·{" "}</>}
              {leadMarket ? <span data-testid="lead-market">{t("lead.card.market_line", { market: leadMarket.name })} · </span> : null}
              {creator
                ? t("lead.card.added", { source, who: displayName(creator), when: relativeTime(lead.createdAt, now) })
                : t("lead.card.added_system", { source, when: relativeTime(lead.createdAt, now) })}
            </span>
          </div>
        </header>
        <StageStepper v={stage} name={lead.fullName.trim().split(/\s+/)[0] || lead.fullName} />
        <div className="sas-lead__body">
          <div className="sas-lead__main">
            {opener ? (
              <WhatsAppStart
                slug={account.slug} leadId={lead.id} refusal={opener.refusal} templateName={opener.template?.name ?? null}
                buyerName={lead.fullName} error={typeof sp.wa_error === "string" ? sp.wa_error : undefined}
              />
            ) : null}
            {lead.status !== "opted_out" || chatLink ? (
              <SimulatorPanel
                slug={account.slug} leadId={lead.id} simulated={simulated}
                url={chatLink ? publicUrl(chatPath(chatLink.token)) : null}
                expired={chatLink?.expired ?? false} expiresAt={chatLink && !chatLink.expired ? formatDueLocal(chatLink.expiresAt, account.timezone) : null} refusal={simFacts?.refusal ?? null} rules={account.simulateWhatsappRules}
                notice={typeof sp.sim === "string" ? sp.sim : undefined} error={typeof sp.sim_error === "string" ? sp.sim_error : undefined}
              />
            ) : null}
            {conversation ? (
              <ConversationPanel
                chatWindow={waWindow}
                slug={account.slug} view={conversation} me={me} buyerName={lead.fullName}
                leadOptedOut={lead.status === "opted_out"} notice={typeof sp.notice === "string" ? sp.notice : undefined}
              />
            ) : (
              <div className="sas-empty sas-lead__chat">
                <span className="sas-empty__icon sas-empty__icon--agent"><Icon name="message-circle" /></span>
                <strong>{t("lead.card.no_messages")}</strong>
                <span className="sas-small">{chatNote}</span>
              </div>
            )}
            <section aria-labelledby="lq-h" style={{ borderBlockEnd: "1px solid var(--line)" }}>
              <div className="sas-page-head" style={{ padding: "16px 16px 4px" }}>
                <h2 id="lq-h" className="sas-label" style={{ margin: 0 }}>{t("lead.card.quotes")}</h2>
                {lead.status !== "opted_out" ? <a className={`${buttonClass("secondary", "sm")} sas-page-head__actions`} href={`/app/${account.slug}/leads/${lead.id}/quote`}><Icon name="file-text" />{t("lead.card.create_quote")}</a> : null}
              </div>
              {leadQuotes.length === 0 ? <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("lead.card.no_quotes")}</p> : (
                <ul className="sas-list">
                  {leadQuotes.map(({ quote, version, older }) => (
                    <li key={quote.id}>
                      <a className="sas-list__row" href={`/app/${account.slug}/orders?quote=${quote.id}`}>
                        <span className="sas-num">Q-{quote.number} v{quote.currentVersion}</span>
                        <span className="sas-list__main sas-num sas-small">{version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId ? t("quote.to_price") : quoteTotals(version)}</span>
                        <StatusPill object="quote" state={displayQuoteStatus(quote.status, version.validUntil, now)} />
                      </a>
                      {older.length ? (
                        <details style={{ padding: "0 16px 8px" }}>
                          <summary className="sas-small">{older.length === 1 ? t("lead.card.show_version", { version: older[0].version }) : t("lead.card.show_versions", { count: older.length })}</summary>
                          <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: "8px 0 0" }}>
                            {older.map((v) => (
                              <li key={v.id} className="sas-small sas-num" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <span>v{v.version}</span><span>{quoteTotals(v)}</span>{v.changeNote ? <span>· {v.changeNote}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
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
            <FollowUpPanel
              slug={account.slug} followUp={followUp} timezone={account.timezone}
              canCancel={mayCancelFollowUps(access)} cancelled={sp.follow_up === "cancelled"}
            />
            <section aria-labelledby="lm-h" className="sas-stack-2" style={{ padding: "0 16px 16px", borderBlockEnd: "1px solid var(--line)" }}>
              <h2 id="lm-h" className="sas-group-label" style={{ padding: "16px 0 0" }}>{t("lead.card.market")}</h2>
              {sp.market ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lead.card.market_saved")}</span></div> : null}
              {sp.market_error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lead.card.market_error")}</span></div> : null}
              {marketList.length > 1 ? (
                <form action={setLeadMarketAction} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="leadId" value={lead.id} />
                  <select className="sas-select" name="marketId" defaultValue={leadMarket?.id} aria-label={t("lead.card.market")} style={{ flex: "1 1 160px", minWidth: 0 }}>
                    {marketList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button type="submit" className={buttonClass("secondary", "sm")}>{t("lead.card.market_change")}</button>
                </form>
              ) : (
                <span>{leadMarket?.name}</span>
              )}
              <span className="sas-small">{t("lead.card.market_hint")}</span>
            </section>
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
