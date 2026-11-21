import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { quoteRef } from "@/components/sas/id-text";
import { Avatar, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { Timeline, type TimelineItem } from "@/components/sas/record";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { setLeadMarketAction, takeOverAction, verifyFieldAction } from "../actions";
import { listMarkets } from "@/lib/markets/service";
import { appDb, requireAccount } from "@/lib/auth/account";
import { nameInitials, personName } from "@/lib/auth/display";
import { getLead, latestConsent, listLeadEvents } from "@/lib/leads/service";
import { maskPhone } from "@/lib/leads/rules";
import { formatDateTimeIn, formatDayMonthIn, formatShortDateTimeIn } from "@/lib/format";
import { TIMELINE_COOKIE, timelineOpen } from "@/lib/leads/timeline-fold";
import { TimelineFold } from "./timeline-fold";
import { t, type MessageKey } from "@/lib/i18n";
import { OptOutButton } from "./opt-out";
import { ConversationPanel, dealEnded, formNotes, FormNotesOnly } from "./conversation";
import { latestConversationForLead } from "@/lib/agent/conversation";
import { WhatsAppStart } from "./whatsapp-start";
import { conversationWindow, openerFacts } from "@/lib/channels/whatsapp";
import { defaultTransport } from "@/lib/channels/twilio";
import { displayQuoteStatus, furthestQuoteState, quotesForLead, quoteTimezones } from "@/lib/quotes/service";
import { docStatusByQuote, leadOrdersWithSignature, linkFor, orderLabel, payLinkOpen, personSentForms } from "@/lib/orders/service";
import { SignedFormLinks } from "../../orders/signed-form-links";
import { ScrollLeadToHash, ScrollLeadToLatest } from "./scroll-latest";
import { isolate } from "@/lib/leads/bidi";
import { seesPlatformDetails } from "@/lib/auth/display";
import { agentStepsFor } from "@/lib/conversations/agent-steps-server";
import { dealPaneView } from "@/lib/leads/deal-pane";
import { DealStatePane } from "./deal-pane";
import { formatMoney } from "@/lib/domain/money";
import { chatLinkStatus, simulatorOpenerFacts } from "@/lib/simulator/service";
import { isSimulatedLead, isWebChat, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { chatPath } from "@/lib/simulator/token";
import { publicUrl } from "@/lib/orders/token";
import { leadEventIcon, leadEventTitle } from "@/lib/leads/event-icons";
import { contactHoursFixHref } from "@/lib/markets/lead-settings";
import { SimulatorPanel } from "./simulator-panel";
import { SimulatedChip } from "../simulated-chip";
import { leadStage } from "@/lib/leads/stage";
import { handoffReasonsByLead } from "@/lib/leads/handoff-reason";
import { StageStepper, type PaidOrder } from "./stage";
import { FollowUpPanel } from "./follow-up";
import { followUpBuyerNamed, leadFollowUp, mayCancelFollowUps } from "@/lib/follow-ups/schedule";
import { formatDueLocal } from "@/lib/follow-ups/rules";
import { AfterCallPrompt, CallbackPanel } from "./callback";
import { callbackAfterCall, leadCallback, mayManageCallbacks } from "@/lib/callbacks/service";

const quoteTotals = (v: { oneTimeTotalMinor: number; recurringTotalMinor: number; currency: string }) =>
  `${formatMoney(v.oneTimeTotalMinor, v.currency)}${v.recurringTotalMinor ? ` + ${formatMoney(v.recurringTotalMinor, v.currency, { period: "month" })}` : ""}`;

/** The remembered timeline choice (W3). Outside a request (render tests) there is none: folded. */
async function timelineCookieValue(): Promise<string | undefined> {
  try { return (await cookies()).get(TIMELINE_COOKIE)?.value; } catch { return undefined; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event icons: one map with Overview's Recent activity (lib/leads/event-icons.ts, W6). */

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
  const [row, events, consent, leadQuotes, playbook, deal, conversation, marketList, opener, chatLink, simFacts, stage, followUp, leadOrders, sentForms, callback, afterCall] = await Promise.all([
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
    leadOrdersWithSignature(appDb, account.id, leadId),
    personSentForms(appDb, account.id, leadId),
    leadCallback(appDb, account.id, leadId),
    callbackAfterCall(appDb, account.id, leadId),
  ]);
  // UX: an agent-chosen follow-up goes inside contact hours; one the buyer named goes at that time.
  const followUpByBuyer = followUp && followUp.status === "scheduled" ? (await followUpBuyerNamed(appDb, followUp)).buyerNamedTime : false;
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
  // "Fix hours" on an outside-contact-hours refusal: the lead's own market's hours when it sets them (the gates use the account's for a lead with no market).
  const hoursHref = contactHoursFixHref(account.slug, row.market ? marketList.find((m) => m.id === row.market!.id) : null);
  const now = new Date();
  // O35: why the lead needs a person, shown in the stage banner while a person handles it: the one line
  // (as in Needs you and the Conversations row) and the whole stored reason, shown only when the line is cut.
  const handoffWhyLine = stage?.human ? (await handoffReasonsByLead(appDb, account.id, [leadId])).get(leadId) ?? null : null;
  const source = lead.sourceLabel ?? t(`lead.origin.${lead.origin}`);
  // Quote dates in the quote's market time zone, as the buyer's card shows them.
  const [tzOf, docs] = await Promise.all([
    quoteTimezones(appDb, account.id, leadQuotes.map((q) => q.quote)),
    // The quote row shows the furthest state (form opened, paid), as the timeline does (round-4 review F2).
    docStatusByQuote(appDb, account.id, leadQuotes.map((q) => q.quote.id)),
  ]);
  // Orders: label and amounts, one source for the Orders block, the stage banner and the timeline.
  const orderView = (o: (typeof leadOrders)[number]["order"]) => ({
    label: orderLabel(account.tradeName, o.number),
    amount: `${formatMoney(o.amountDueMinor, o.currency)}${o.recurringMinor ? ` + ${formatMoney(o.recurringMinor, o.currency, { period: "month" })}` : ""}`,
  });
  const orderById = new Map(leadOrders.map(({ order }) => [order.id, orderView(order)]));
  const latestOrder = leadOrders[0] ?? null;
  const paidOrder: PaidOrder | null = latestOrder && latestOrder.order.paymentStatus === "paid" ? orderView(latestOrder.order) : null;
  // The deal pane, one source with Conversations (lib/leads/deal-pane.ts): a signed form fills the company and
  // signer details (verified); after the sale the order's state is the next step; once the quote or the form is
  // with the buyer the stage says what happens next (the agent's free text only before that).
  const pane = dealPaneView({ playbook, deal: deal ?? null, latestOrder, stage, tradeName: account.tradeName, buyerName: lead.fullName, timezone: account.timezone });
  const nextStep = pane.nextStep;
  // Quotes an order came from show "Ordered".
  const orderedQuotes = new Set(leadOrders.map(({ order }) => order.quoteId));

  const tz = account.timezone;
  /** People by name, or "You" for the viewer (never the email); isolated so a Hebrew name never pulls in the date next to it (round-4 review F1). */
  const who = (u: Parameters<typeof personName>[0]) => isolate(personName(u, me.id, t("people.you")));
  /** The same inside a sentence ("added by you"). */
  const whoIn = (u: Parameters<typeof personName>[0]) => isolate(personName(u, me.id, t("people.you_lower")));
  /** An event's title as text (the folded timeline's "last:" line). */
  const eventTitle = (type: string, data: unknown) => leadEventTitle(type, data, t);
  const timeline: TimelineItem[] = events.map(({ event, user }) => {
    // Signed and paid: success-toned, with the order and its amount.
    const won = event.type === "order_form.signed" || event.type === "order.paid";
    const ord = won ? orderById.get(String((event.data as { orderId?: string } | null)?.orderId ?? "")) : undefined;
    // A conversation started in the web chat (real or simulated) is not a WhatsApp start (leadEventKey).
    const title = eventTitle(event.type, event.data);
    return {
    id: event.id,
    actor: event.actor === "human" ? "human" : event.actor === "agent" ? "agent" : event.actor === "buyer" ? "buyer" : "system",
    icon: leadEventIcon(event.type, { data: event.data }),
    // Wins get the filled green circle (round-4 review E7).
    tone: won ? ("success" as const) : undefined,
    title: won ? <span style={{ color: "var(--success)" }} data-tone="success">{title}</span> : title,
    detail:
      won && ord
        ? <><span className="sas-id">{ord.label}</span> · <span className="sas-num">{ord.amount}</span>{event.type === "order_form.signed" ? <> · <span className="sas-id">{quoteRef(String((event.data as { number?: number } | null)?.number ?? ""), String((event.data as { version?: number } | null)?.version ?? ""))}</span></> : null}</>
        : event.type.startsWith("quote.") || event.type.startsWith("order_form.")
        // The quote reference is one ID in the code font (R5-6).
        ? <><span className="sas-id">{quoteRef(String((event.data as { number?: number } | null)?.number ?? ""), (event.data as { version?: number } | null)?.version)}</span>{`${user ? ` · ${who(user)}` : event.actor === "agent" ? " · Agent" : ""}${(event.data as { reasons?: string[] } | null)?.reasons?.length ? `: ${(event.data as { reasons: string[] }).reasons.join("; ")}` : ""}`}</>
        : event.type.startsWith("team_question.")
        // O4: the question as the team reads it (and how the answer reached the buyer).
        ? `${String((event.data as { question?: string } | null)?.question ?? "")}${user ? ` · ${who(user)}` : ""}`
        : event.type.startsWith("callback.")
        // O6: the call time, in the zone it was set in, and who acted.
        ? `${formatDueLocal(new Date(String((event.data as { at?: string } | null)?.at ?? event.createdAt.toISOString())), String((event.data as { timezone?: string } | null)?.timezone ?? tz))}${user ? ` · ${who(user)}` : event.actor === "agent" ? " · Agent" : ""}`
        : event.type === "consent.recorded"
        ? String((event.data as { source?: string } | null)?.source ?? "")
        : event.type === "lead.market_changed"
        ? `${(event.data as { from?: string | null } | null)?.from ?? "-"} → ${(event.data as { to?: string } | null)?.to ?? ""}${user ? ` · ${who(user)}` : ""}`
        : user
          ? who(user)
          : event.type === "lead.created" || event.type === "lead.updated"
            ? t(`lead.origin.${String((event.data as { origin?: string } | null)?.origin ?? "manual")}` as MessageKey)
            : undefined,
    // A record: the exact date and time in the account's zone (zone named on hover).
    time: formatShortDateTimeIn(event.createdAt, tz),
    timeTitle: formatDateTimeIn(event.createdAt, tz),
    };
  });

  // The timeline, folded into one row by default; the URL (no JS) wins over the remembered choice (W3).
  const tlOpen = timelineOpen(sp.timeline, await timelineCookieValue());
  const tlHref = (state: "open" | "closed") => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (k !== "timeline" && typeof v === "string") q.set(k, v);
    q.set("timeline", state);
    return `/app/${account.slug}/leads/${lead.id}?${q.toString()}#lead-timeline`;
  };
  const lastEvent = events[0];
  const tlSummary = !lastEvent
    ? t("lead.card.timeline_none")
    : t(events.length === 1 ? "lead.card.timeline_summary_one" : "lead.card.timeline_summary", {
        count: events.length,
        event: eventTitle(lastEvent.event.type, lastEvent.event.data),
        time: formatShortDateTimeIn(lastEvent.event.createdAt, tz),
      });

  // Deal fields not known yet (phone summary above the tabs).
  const missingCount = pane.missingCount;

  // An open conversation is taken over from the header (not under the chat).
  const takeOverHere = !!conversation && conversation.conversation.status === "open" && lead.status !== "opted_out";
  // A won or lost deal: the agent still answers, so Take over stays, as a secondary button (round-4 review E2).
  const ended = dealEnded(lead.status);
  // A simulated lead whose chat can be started: the empty chat says how.
  const canStartSim = !!chatLink && !chatLink.expired && simFacts?.refusal === null;

  let chatNote: string;
  if (lead.status === "opted_out") chatNote = t("lead.card.opted_out");
  else if (owner) chatNote = t("lead.card.human_owner", { name: who(owner) });
  else if (simulated && canStartSim) chatNote = t("lead.card.sim_start_hint");
  else chatNote = t("lead.card.wait_live");
  // Order forms a person sent show in the thread where they happened (round-4 review F2).
  const notes = formNotes(sentForms, me.id, (id) => linkFor({ id }).url, now);

  return (
    <main className="sas-shell__content">
      {sp.existing === "1" ? (
        <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lead.card.existing")}</span></div>
      ) : null}
      {/* The deal column sticks under the header (sas.css); the market line makes the header taller. */}
      <section className="sas-panel sas-lead" style={marketList.length > 1 ? ({ "--lead-head-h": "106px" } as React.CSSProperties) : undefined}>
        <header className="sas-lead__head">
          <Avatar actor="buyer" initials={nameInitials(lead.fullName)} />
          <div className="sas-stack-2" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <div className="sas-page-head" style={{ gap: 8 }}>
              <h1 className="sas-title" data-lead-title="">{/* Each part one unit, breaking only at " · " (R5-6). */}<bdi className="sas-title-part">{lead.fullName}</bdi>{lead.company ? <> · <bdi className="sas-title-part">{lead.company}</bdi></> : null}</h1>
              {simulated ? <SimulatedChip /> : null}
              <StatusPill object="lead" state={lead.status} />
            </div>
            <span className="sas-small">
              {/* A simulated buyer has a buyer ID, not a phone (the placeholder is never shown or formatted as one). */}
              {simulated
                ? <span data-testid="buyer-ref">{t("sim.header", { id: "" })}<span className="sas-id" dir="ltr">{lead.buyerRef ?? lead.phone.replace(/^sim:/, "")}</span> · {t(`lang.${lead.language as "en" | "he"}`)} ·{" "}</span>
                : <>{t(`lang.${lead.language as "en" | "he"}`)} · <span className="sas-num" dir="ltr">{maskPhone(lead.phone)}</span> ·{" "}</>}
              {leadMarket ? <span data-testid="lead-market">{t("lead.card.market_line", { market: leadMarket.name })} · </span> : null}
              {creator
                ? t("lead.card.added", { source: isolate(source), who: whoIn(creator), when: formatDateTimeIn(lead.createdAt, tz) })
                : t("lead.card.added_system", { source: isolate(source), when: formatDateTimeIn(lead.createdAt, tz) })}
            </span>
            {/* The market can be changed here (the side panel that repeated it is gone). */}
            {marketList.length > 1 ? (
              <details className="sas-lead__market" data-testid="lead-market-change" open={!!(sp.market || sp.market_error) || undefined}>
                <summary className="sas-small">{t("lead.card.market_change_open")}</summary>
                <form action={setLeadMarketAction} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingBlockStart: 8 }}>
                  <input type="hidden" name="slug" value={account.slug} />
                  <input type="hidden" name="leadId" value={lead.id} />
                  <select className="sas-select" name="marketId" defaultValue={leadMarket?.id} aria-label={t("lead.card.market")} style={{ flex: "1 1 160px", minWidth: 0, maxWidth: 280 }}>
                    {marketList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button type="submit" className={buttonClass("secondary", "sm")}>{t("lead.card.market_change")}</button>
                </form>
                <span className="sas-small">{t("lead.card.market_hint")}</span>
              </details>
            ) : null}
            {sp.market ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lead.card.market_saved")}</span></div> : null}
            {sp.market_error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lead.card.market_error")}</span></div> : null}
          </div>
          {/* Take over sits top right, as on the board; it stays in view while the page scrolls. Book meeting comes with meetings. */}
          {takeOverHere && conversation ? (
            <form action={takeOverAction} className="sas-lead__head-actions">
              <input type="hidden" name="slug" value={account.slug} />
              <input type="hidden" name="conversationId" value={conversation.conversation.id} />
              <input type="hidden" name="from" value="lead" />
              <button type="submit" className={buttonClass(ended ? "secondary" : "takeover", "sm")} data-testid="header-take-over" data-take-over={ended ? "secondary" : "primary"}><Icon name="user" />{t("conv.take_over")}</button>
            </form>
          ) : null}
        </header>
        <StageStepper v={stage} name={lead.fullName.trim().split(/\s+/)[0] || lead.fullName} paidOrder={paidOrder} handoffWhy={handoffWhyLine?.whole ?? null} />
        {/* Phone only (sas.css): a compact deal summary, then tabs Chat · Deal · Timeline. Radio inputs, so they work without JS. */}
        {/* `?tab=deal` (Needs you's call items, O7) opens on the Deal tab, so the call card is in view. */}
        <input type="radio" name="lead-tab" id="lt-chat" className="sas-lead__tab-radio" defaultChecked={sp.tab !== "deal"} aria-label={t("lead.tabs.chat")} />
        <input type="radio" name="lead-tab" id="lt-deal" className="sas-lead__tab-radio" defaultChecked={sp.tab === "deal"} aria-label={t("lead.tabs.deal")} />
        <input type="radio" name="lead-tab" id="lt-timeline" className="sas-lead__tab-radio" aria-label={t("lead.tabs.timeline")} />
        <div className="sas-lead__summary" data-testid="lead-summary">
          {nextStep ? <span><strong>{t("lead.card.next_step")}:</strong> {nextStep}</span> : null}
          {playbook && playbook.fields.length ? (
            <span className="sas-small">{missingCount === 0 ? t("lead.summary.all_known") : missingCount === 1 ? t("lead.summary.missing_one") : t("lead.summary.missing", { count: missingCount })}</span>
          ) : null}
        </div>
        <div className="sas-lead-tabs" aria-hidden="true">
          <label htmlFor="lt-chat">{t("lead.tabs.chat")}</label>
          <label htmlFor="lt-deal">{t("lead.tabs.deal")}</label>
          <label htmlFor="lt-timeline">{t("lead.tabs.timeline")}</label>
        </div>
        {/* A #hash (Needs you's call links) opens at that card once the streamed page is in place; the browser's own jump comes too early. */}
        <ScrollLeadToHash />
        <div className="sas-lead__body">
          <div className="sas-lead__main">
            <div data-tab="chat">
            {opener ? (
              <WhatsAppStart
                slug={account.slug} leadId={lead.id} refusal={opener.refusal} templateName={opener.template?.name ?? null}
                buyerName={lead.fullName} error={typeof sp.wa_error === "string" ? sp.wa_error : undefined} hoursHref={hoursHref}
              />
            ) : null}
            {lead.status !== "opted_out" || chatLink ? (
              <SimulatorPanel
                slug={account.slug} leadId={lead.id} simulated={simulated}
                url={chatLink ? publicUrl(chatPath(chatLink.token)) : null}
                expired={chatLink?.expired ?? false} expiresAt={chatLink && !chatLink.expired ? formatDueLocal(chatLink.expiresAt, account.timezone) : null} refusal={simFacts?.refusal ?? null} rules={simulated && account.simulateWhatsappRules}
                started={isWebChat(conversation?.conversation.channel) || simFacts?.refusal === "already_started"}
                notice={typeof sp.sim === "string" ? sp.sim : undefined} error={typeof sp.sim_error === "string" ? sp.sim_error : undefined} hoursHref={hoursHref}
                why={typeof sp.why === "string" ? sp.why : undefined}
              />
            ) : null}
            {conversation ? (
              <ConversationPanel
                chatWindow={waWindow}
                slug={account.slug} view={conversation} me={me} buyerName={lead.fullName} timezone={tz} takeOverInHeader={takeOverHere}
                leadOptedOut={lead.status === "opted_out"} notice={typeof sp.notice === "string" ? sp.notice : undefined}
                leadStatus={lead.status} notes={notes} rawToolNames={seesPlatformDetails(access)}
                steps={{ show: await agentStepsFor("workspace", me.id, sp.steps), back: `/app/${account.slug}/leads/${lead.id}#conversation` }}
              />
            ) : null}
            {conversation ? (
              <ScrollLeadToLatest />
            ) : notes.length ? (
              <FormNotesOnly notes={notes} timezone={tz} hint={chatNote} />
            ) : (
              <div className="sas-empty sas-lead__chat">
                <span className="sas-empty__icon sas-empty__icon--agent"><Icon name="message-circle" /></span>
                <strong>{t("lead.card.no_messages")}</strong>
                <span className="sas-small">{chatNote}</span>
              </div>
            )}
            </div>
            {/* Quotes and Orders: two cards side by side, stacked on a phone (W3). */}
            <div className="sas-lead-docs" data-tab="deal">
            <section id="lead-quotes" className="sas-lead-doc" aria-labelledby="lq-h" data-testid="quotes-card">
              <div className="sas-lead-doc__head">
                <h2 id="lq-h" className="sas-lead-doc__title">{t("lead.card.quotes")} <span className="sas-lead-doc__count sas-num">{leadQuotes.length}</span></h2>
                {lead.status !== "opted_out" ? <a className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/leads/${lead.id}/quote`}><Icon name="file-text" />{t("lead.card.create_quote")}</a> : null}
              </div>
              {leadQuotes.length === 0 ? <p className="sas-small sas-lead-doc__empty">{t("lead.card.no_quotes")}</p> : (
                <ul className="sas-list">
                  {leadQuotes.map(({ quote, version, older }) => (
                    <li key={quote.id}>
                      {/* Two lines, as the order rows (W6): ID and status, then amounts and date. */}
                      <a className="sas-list__row sas-lead-doc__row" href={`/app/${account.slug}/orders?quote=${quote.id}`} data-quote-row={quote.id}>
                        <span className="sas-lead-doc__line">
                          <span className="sas-id">Q-{quote.number} v{quote.currentVersion}</span>
                          {(() => {
                            const f = furthestQuoteState(displayQuoteStatus(quote.status, version.validUntil, now, tzOf.get(quote.id), orderedQuotes.has(quote.id)), docs.get(quote.id));
                            return f.object === "payment" ? <StatusPill object="payment" state={f.state} /> : f.object === "order_form" ? <StatusPill object="order_form" state={f.state} /> : <StatusPill object="quote" state={f.state} />;
                          })()}
                        </span>
                        <span className="sas-lead-doc__line">
                          <span className="sas-num sas-lead-doc__amount">{version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId ? t("quote.to_price") : quoteTotals(version)}</span>
                          <span className="sas-small sas-lead-doc__date" title={formatDateTimeIn(version.createdAt, tz)}>{formatDayMonthIn(version.createdAt, tz)}</span>
                        </span>
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
            <section id="lead-orders" className="sas-lead-doc" aria-labelledby="lo-h" data-testid="orders-card">
              <div className="sas-lead-doc__head">
                <h2 id="lo-h" className="sas-lead-doc__title">{t("lead.card.orders")} <span className="sas-lead-doc__count sas-num">{leadOrders.length}</span></h2>
              </div>
              {leadOrders.length === 0 ? <p className="sas-small sas-lead-doc__empty">{t("lead.card.no_orders")}</p> : (
                <ul className="sas-list">
                  {leadOrders.map(({ order }) => (
                    <li key={order.id}>
                      {/* Line 1: ID and status; line 2: amounts (one line) and date; line 3: the links (W6). */}
                      <a className="sas-list__row sas-lead-doc__row" href={`/app/${account.slug}/orders?tab=orders&quote=${order.quoteId}`} data-order-row={order.id}>
                        <span className="sas-lead-doc__line">
                          <span className="sas-id">{orderById.get(order.id)!.label}</span>
                          <StatusPill object="payment" state={order.paymentStatus} />
                        </span>
                        <span className="sas-lead-doc__line">
                          <span className="sas-num sas-lead-doc__amount">{orderById.get(order.id)!.amount}</span>
                          <span className="sas-small sas-lead-doc__date" title={formatDateTimeIn(order.createdAt, tz)}>{formatDayMonthIn(order.createdAt, tz)}</span>
                        </span>
                      </a>
                      {/* The signed form, and its pay page while the order waits for payment (R5 item 8). */}
                      <div className="sas-lead-doc__links">
                        {/* A transfer to confirm or a failed payment: straight to the order's panel on Quotes and orders (Leads V2, UX). */}
                        {order.paymentStatus === "bank_transfer_expected" || order.paymentStatus === "failed" ? (
                          <a
                            className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/orders?tab=orders&quote=${order.quoteId}`}
                            data-order-action={order.paymentStatus === "failed" ? "payment_failed" : "review_transfer"}
                          >
                            <Icon name={order.paymentStatus === "failed" ? "x-circle" : "credit-card"} />
                            {t(order.paymentStatus === "failed" ? "lead.card.order_payment_failed" : "lead.card.order_review_transfer")}
                          </a>
                        ) : null}
                        <SignedFormLinks url={linkFor({ id: order.orderFormId }).url} pay={payLinkOpen(order.paymentStatus, leadQuotes.find((q) => q.quote.id === order.quoteId)?.quote.status ?? "")} payVariant="ghost" />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            </div>
            <div data-tab="timeline" id="lead-timeline">
              <TimelineFold
                initialOpen={tlOpen} label={t("lead.card.timeline")} summary={tlSummary}
                showLabel={t("lead.card.timeline_show")} hideLabel={t("lead.card.timeline_hide")}
                openHref={tlHref("open")} closeHref={tlHref("closed")}
              >
                <Timeline label={t("lead.card.timeline")} items={timeline} />
              </TimelineFold>
            </div>
          </div>
          <aside className="sas-lead__side">
            {/* O6: the call the agent arranged; Confirm / Change time tell the buyer in the chat. */}
            <CallbackPanel
              slug={account.slug} leadId={lead.id} request={callback} canManage={mayManageCallbacks(access)}
              notice={typeof sp.callback === "string" ? sp.callback : undefined} error={typeof sp.callback_error === "string" ? sp.callback_error : undefined}
              notTold={typeof sp.callback_not_told === "string" ? sp.callback_not_told : undefined}
            />
            {/* After the call: hand back to the agent, or the seller handles the deal (Take over). */}
            <AfterCallPrompt
              slug={account.slug} leadId={lead.id} call={afterCall} canManage={mayManageCallbacks(access)}
              notice={typeof sp.after_call === "string" ? sp.after_call : undefined} error={typeof sp.after_call_error === "string" ? sp.after_call_error : undefined}
            />
            <FollowUpPanel
              slug={account.slug} followUp={followUp} timezone={account.timezone}
              canCancel={mayCancelFollowUps(access)} cancelled={sp.follow_up === "cancelled"} buyerNamed={followUpByBuyer}
            />
            <h2 className="sas-group-label">{t("lead.card.learn")}</h2>
            {sp.verified ? <div className="sas-alert sas-alert--success" role="status" style={{ margin: "0 16px 12px" }}><Icon name="check-circle" /><span>{t("lead.card.verified_saved")}</span></div> : null}
            <div className="sas-stack-4" style={{ padding: "0 16px 16px" }}>
              {/* The consent line sits right under Next step (round-3 review B3). */}
              <DealStatePane
                pane={pane}
                afterNextStep={
                  <div className="sas-lead__consent sas-lead__consent--inline" data-testid="consent">
                    <Icon name="shield-check" />
                    <div className="sas-stack-2" style={{ flex: 1 }}>
                    <span>
                      {consent
                        ? t("lead.card.consent", {
                            date: formatDateTimeIn(consent.consent.capturedAt, tz),
                            source: isolate(consent.consent.source),
                            who: consent.recordedBy ? whoIn(consent.recordedBy) : t("lead.origin.webhook"),
                          })
                        : t("lead.card.consent_none")}
                    </span>
                    {lead.status !== "opted_out" ? <OptOutButton slug={account.slug} leadId={lead.id} /> : null}
                    </div>
                  </div>
                }
              />
              {playbook && playbook.fields.length ? (
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
              ) : null}
            </div>
          </aside>
        </div>
      </section>
      <a className={buttonClass("ghost", "sm")} href={`/app/${account.slug}/leads`} style={{ alignSelf: "flex-start" }}>{t("import.back")}</a>
    </main>
  );
}
