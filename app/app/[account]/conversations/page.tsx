import { Avatar, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { Banner, WindowTimer } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { nameInitials } from "@/lib/auth/display";
import { conversationView } from "@/lib/agent/conversation";
import { approvedTemplates, conversationWindow } from "@/lib/channels/whatsapp";
import { renderTemplate } from "@/lib/channels/rules";
import { handoffWhyByLead } from "@/lib/leads/handoff-reason";
import { INBOX_FILTERS, inboxConversation, latestHandoff, listInbox, parseInboxFilter, type InboxGroup, type InboxList, type InboxRow } from "@/lib/conversations/inbox";
import { relativeTime } from "@/lib/format";
import { MarketSwitcher } from "@/components/sas/market-switcher";
import { MARKET_PARAM, marketSelection, switcherReturnTo } from "@/lib/markets/selection";
import { messages as i18n, t, type MessageKey } from "@/lib/i18n";
import { ConversationPanel, formNotes, windowTimerProps } from "../leads/[leadId]/conversation";
import { linkFor, personSentForms } from "@/lib/orders/service";
import { seesPlatformDetails } from "@/lib/auth/display";
import { sendTemplateAction } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { ScrollThreadToEnd } from "./scroll-end";
import { SimulatedChip, TestLabChip, WhatsAppChip } from "../leads/simulated-chip";
import { loadDealPane, objectionLine } from "@/lib/leads/deal-pane";
import { DealStatePane, ObjectionList } from "../leads/[leadId]/deal-pane";
import { activeChatToken } from "@/lib/simulator/service";
import { chatPath } from "@/lib/simulator/token";
import { publicUrl } from "@/lib/orders/token";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { agentStepsFor } from "@/lib/conversations/agent-steps-server";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maybe = (key: string) => i18n.en[key as MessageKey] ?? null;

const GROUP_ORDER: InboxGroup[] = ["needs_you", "human", "agent", "closed"];

/**
 * "Buyer: …", "Agent: …", "You: …" before the last message. The message is a
 * separate part: it gets its own direction and is cut at its own end, so a
 * Hebrew preview shows the start of the sentence (round-4 review F1).
 */
function preview(r: Pick<InboxRow, "lastBody" | "lastActor" | "lastUserId">, meId: string): { who: string | null; text: string } {
  if (!r.lastBody) return { who: null, text: t("inbox.no_messages") };
  const who = r.lastActor === "buyer" ? t("inbox.from.buyer")
    : r.lastActor === "agent" ? t("inbox.from.agent")
    : r.lastActor === "human" ? (r.lastUserId && r.lastUserId === meId ? t("inbox.from.you") : t("inbox.from.team"))
    : t("inbox.from.system");
  return { who, text: r.lastBody.replace(/\s+/g, " ").slice(0, 120) };
}

/** Conversations inbox (canvas: Inbox, P6.6). Filters, search and the selected chat live in the URL. */
export default async function ConversationsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account, user: me } = access;
  const base = `/app/${account.slug}/conversations`;
  const filter = parseInboxFilter(one(sp.filter));
  const q = one(sp.q).trim().slice(0, 100) || undefined;
  const page = Math.max(1, Math.floor(Number(one(sp.page)) || 1));
  const selectedId = UUID.test(one(sp.c)) ? one(sp.c) : null;
  const now = new Date();
  // The market switcher's choice (URL, then the stored preference; null = all markets): it filters
  // the list, its groups and the filter counts by the lead's market. An open thread stays open.
  const selection = await marketSelection(appDb, account.id, sp);
  const market = selection.selected;
  // `market` stays on this page's links only when the URL has it (the stored choice covers the rest).
  const urlMarket = selection.showSwitcher ? one(sp[MARKET_PARAM]) || undefined : undefined;
  // Leads without a market belong to the home market.
  const homeMarket = (selection.markets.find((m) => m.isHome) ?? selection.markets[0])?.name ?? "";

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = { filter: filter === "all" ? undefined : filter, q, page: page > 1 ? String(page) : undefined, c: selectedId ?? undefined, [MARKET_PARAM]: urlMarket };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  // One parallel batch: the list (with counts) and the selected conversation.
  let list: InboxList | null = null;
  let selected: Awaited<ReturnType<typeof inboxConversation>> | null = null;
  try {
    [list, selected] = await Promise.all([
      listInbox(appDb, account.id, { filter, q, page, now, simulateRules: account.simulateWhatsappRules, market }),
      selectedId ? inboxConversation(appDb, account.id, selectedId) : Promise.resolve(null),
    ]);
  } catch (e) {
    console.error("[inbox] list failed", e);
  }

  // O35: why each conversation a person handles needs one (one line, as in Needs you and on the lead page):
  // a waiting hand-off, one a person took over (also while the buyer waits), and a lead in "Human handling".
  const showsWhy = (r: InboxRow) => r.group !== "closed" && (r.status === "human" || r.lead.status === "human_handling");
  const whys = list ? await handoffWhyByLead(appDb, account.id, list.rows.filter(showsWhy).map((r) => r.lead.id)) : new Map<string, string>();

  // The selected thread's data, in a second parallel batch.
  const thread = selected
    ? await (async () => {
      const { conv, lead } = selected!;
      // WhatsApp, and simulated chats with "Simulate WhatsApp rules" on: the 24-hour window and template-only composer.
      const whatsapp = conv.channel === "whatsapp" || (conv.channel === SIMULATOR_CHANNEL && account.simulateWhatsappRules);
      const [view, pane, chatWindow, templates, handoff, chatToken, sentForms] = await Promise.all([
        conversationView(appDb, account.id, conv),
        // The lead page's deal pane (lib/leads/deal-pane.ts): verified order details, grouped unknowns, the stage-aware next step.
        loadDealPane(appDb, account.id, lead, account.tradeName),
        whatsapp && conv.status !== "closed" ? conversationWindow(appDb, account.id, conv.id, now) : Promise.resolve(null),
        whatsapp ? approvedTemplates(appDb, account.id) : Promise.resolve([]),
        conv.status === "human" ? latestHandoff(appDb, account.id, lead.id) : Promise.resolve(null),
        conv.channel === SIMULATOR_CHANNEL ? activeChatToken(appDb, account.id, lead.id) : Promise.resolve(null),
        // Order forms a person sent: shown in the thread where they happened (round-4 review F2).
        conv.isTest ? Promise.resolve([]) : personSentForms(appDb, account.id, lead.id),
      ]);
      const notes = formNotes(sentForms, me.id, (id) => linkFor({ id }).url, now);
      return { view, pane, chatWindow, templates, handoff, notes, chatUrl: chatToken ? publicUrl(chatPath(chatToken)) : null };
    })()
    : null;

  const notice = one(sp.notice) || undefined;
  // "Show agent steps" in the thread header: the URL wins, else this person's workspace choice (off by default).
  const showSteps = await agentStepsFor("workspace", me.id, sp.steps);
  const templateError = one(sp.template_error) || undefined;
  const rows = list?.rows ?? [];
  const groups = filter === "all"
    ? GROUP_ORDER.map((g) => ({ g, items: rows.filter((r) => r.group === g) })).filter((x) => x.items.length)
    : [{ g: null, items: rows }];

  return (
    <main className="sas-shell__content sas-inbox-page">
      <AutoRefresh />
      <header className="sas-page-head">
        <h1 className="sas-title">{t("inbox.title")}</h1>
        <div className="sas-page-head__actions">
          <MarketSwitcher slug={account.slug} selection={selection} returnTo={switcherReturnTo(base, sp, ["page", "c", "notice", "template_error"])} />
        </div>
      </header>

      {!list ? (
        <section className="sas-panel sas-empty" role="alert">
          <span className="sas-empty__icon sas-empty__icon--danger"><Icon name="x-circle" /></span>
          <strong>{t("inbox.error.title")}</strong>
          <a className={buttonClass("secondary", "sm")} href={qs({})}>{t("leads.error.retry")}</a>
        </section>
      ) : (
        <div className={`sas-inbox${selected ? " sas-inbox--thread" : ""}`}>
          <section className="sas-panel sas-inbox__list" aria-labelledby="inbox-list-h">
            <h2 id="inbox-list-h" className="sas-sr">{t("inbox.list")}</h2>
            <div className="sas-inbox__tools">
              <nav aria-label={t("inbox.filters")} className="sas-views">
                {INBOX_FILTERS.map((f) => (
                  <a key={f} className="sas-view" href={qs({ filter: f === "all" ? undefined : f, page: undefined, c: undefined })} aria-current={f === filter ? "page" : undefined}>
                    {t(`inbox.filter.${f}`)} <span className="sas-num">{list!.counts[f]}</span>
                  </a>
                ))}
              </nav>
              <form method="get" action={base} className="sas-filters">
                {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
                {urlMarket ? <input type="hidden" name={MARKET_PARAM} value={urlMarket} /> : null}
                <label className="sas-search">
                  <Icon name="search" />
                  <span className="sas-sr">{t("inbox.search")}</span>
                  <input type="search" name="q" defaultValue={q ?? ""} placeholder={t("inbox.search")} />
                </label>
              </form>
            </div>
            {rows.length === 0 ? (
              <div className="sas-empty" style={{ border: 0 }}>
                <span className="sas-empty__icon sas-empty__icon--agent"><Icon name="message-circle" /></span>
                {/* "All" with nothing: a title, a muted body, and the test chats if there are any. */}
                {!q && filter === "all" ? (
                  <>
                    <strong>{market ? t("inbox.empty.market_title", { market: market.name }) : t("inbox.empty.all_title")}</strong>
                    <span className="sas-small">{t("inbox.empty.all")}</span>
                    {list.counts.test > 0 ? (
                      <span className="sas-small" data-testid="empty-tests">
                        {list.counts.test === 1 ? t("inbox.empty.tests_one") : t("inbox.empty.tests", { count: list.counts.test })} · <a href={qs({ filter: "test", page: undefined, c: undefined })}>{t("inbox.empty.see_tests")}</a>
                      </span>
                    ) : null}
                  </>
                ) : (
                <strong>{q ? t("inbox.empty.search") : t(`inbox.empty.${filter}`)}</strong>
                )}
                {q ? <a className={buttonClass("secondary", "sm")} href={qs({ q: undefined, page: undefined, c: undefined })}>{t("leads.filter.clear")}</a> : null}
              </div>
            ) : (
              groups.map(({ g, items }) => (
                <div key={g ?? "list"}>
                  {g ? <h3 className="sas-label sas-inbox__group">{t(`inbox.group.${g}`)} · <span className="sas-num">{list!.counts[g]}</span></h3> : null}
                  <ul className="sas-list">
                    {items.map((r) => {
                      const holding = r.group === "needs_you" || r.group === "human";
                      const ended = r.group === "closed";
                      return (
                        <li key={r.conversationId}>
                          <a
                            className={`sas-inbox__row${r.lastActor === "buyer" && !ended ? " sas-inbox__row--unread" : ""}`}
                            href={`${qs({ c: r.conversationId })}#thread`}
                            aria-current={r.conversationId === selectedId ? "page" : undefined}
                          >
                            <Avatar actor={ended ? "buyer" : holding ? "human" : "agent"} initials={nameInitials(r.lead.fullName)} />
                            <span className="sas-inbox__row-main">
                              <span className="sas-inbox__row-top">
                                <span className="sas-inbox__name"><bdi>{r.lead.fullName}</bdi>{r.lead.company ? <span className="sas-small"> · <bdi>{r.lead.company}</bdi></span> : null}</span>
                                <span className="sas-small sas-when" title={r.lastAt.toISOString()}>{relativeTime(r.lastAt, now)}</span>
                              </span>
                              {(() => {
                                const p = preview(r, me.id);
                                return (
                                  <span className="sas-small sas-inbox__preview" data-preview="">
                                    {p.who ? <span className="sas-inbox__preview-who">{p.who}:</span> : null}
                                    <span className="sas-inbox__preview-text" dir="auto">{p.text}</span>
                                  </span>
                                );
                              })()}
                              <span className="sas-inbox__meta">
                                {r.group === "needs_you" ? <span className="sas-inbox__badge"><Icon name="user" />{r.takenOverByUserId ? t("inbox.badge.buyer_waiting") : t("inbox.badge.handoff")}</span> : null}
                                {/* O35: why it needs a person, the same line as Needs you and the lead page. */}
                                {showsWhy(r) && whys.get(r.lead.id) ? <span className="sas-small sas-oneline" data-handoff-why="" dir="auto" title={whys.get(r.lead.id)}>{whys.get(r.lead.id)}</span> : null}
                                <StatusPill object="lead" state={r.lead.status} />
                                {r.isTest ? <TestLabChip /> : r.channel === SIMULATOR_CHANNEL ? <SimulatedChip /> : r.channel === "whatsapp" ? <WhatsAppChip /> : <span className="sas-chip sas-chip--plain">{maybe(`conv.channel.${r.channel}`) ?? r.channel}</span>}
                                {r.marketName || homeMarket ? <span className="sas-small" data-market="">{r.marketName || homeMarket}</span> : null}
                                {r.window ? <WindowTimer {...windowTimerProps(r.window, now)} /> : null}
                              </span>
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
            {list.pages > 1 ? (
              <nav className="sas-table-foot" aria-label={t("inbox.pages")}>
                <span>{t("inbox.showing", { from: (list.page - 1) * 50 + 1, to: (list.page - 1) * 50 + rows.length, total: list.total })}</span>
                <span style={{ display: "flex", gap: 12 }}>
                  {list.page > 1 ? <a href={qs({ page: list.page - 1 > 1 ? String(list.page - 1) : undefined, c: undefined })}>{t("inbox.newer")}</a> : null}
                  {list.page < list.pages ? <a href={qs({ page: String(list.page + 1), c: undefined })}>{t("inbox.older")}</a> : null}
                </span>
              </nav>
            ) : null}
          </section>

          <section className="sas-panel sas-inbox__thread" id="thread" aria-label={selected ? t("inbox.thread_with", { name: selected.lead.fullName }) : t("inbox.thread")}>
            {!selected || !thread ? (
              <div className="sas-empty" style={{ border: 0, minHeight: 280 }}>
                <span className="sas-empty__icon sas-empty__icon--agent"><Icon name="message-circle" /></span>
                <strong>{selectedId ? t("inbox.not_found") : t("inbox.pick")}</strong>
                <span className="sas-small">{t("inbox.pick_hint")}</span>
              </div>
            ) : (
              <>
                <header className="sas-inbox__thread-head">
                  <a className={`${buttonClass("ghost", "sm")} sas-inbox__back`} href={qs({ c: undefined })}><Icon name="chevron-left" />{t("inbox.back")}</a>
                  <span className="sas-stack-2" style={{ gap: 2, minWidth: 0, flex: "1 1 220px" }}>
                    <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {/* As on the lead page (R5-6): each part one isolated unit, breaking only at " · ". */}
                      <strong data-thread-title="" style={{ minWidth: 0, maxWidth: "100%" }}><bdi className="sas-title-part">{selected.lead.fullName}</bdi>{selected.lead.company ? <> · <bdi className="sas-title-part">{selected.lead.company}</bdi></> : null}</strong>
                      {selected.conv.channel === SIMULATOR_CHANNEL ? <SimulatedChip /> : selected.conv.isTest ? <TestLabChip /> : null}
                    </span>
                    <span className="sas-small">
                      {[selected.lead.buyerRef, selected.marketName || homeMarket, t(`lang.${selected.lead.language as "en" | "he"}`)].filter(Boolean).join(" · ")}
                      {selected.conv.isTest ? null : <> · <a href={`/app/${account.slug}/leads/${selected.lead.id}`}>{t("inbox.open_lead")}</a> · <a href={`/app/${account.slug}/leads/${selected.lead.id}/quote`} data-create-quote="">{t("inbox.create_quote")}</a></>}
                    </span>
                  </span>
                  {thread.chatUrl ? <a className={buttonClass("secondary", "sm")} href={thread.chatUrl} target="_blank" rel="noopener noreferrer" data-chat-link="">{t("inbox.open_buyer_chat")}</a> : null}
                  <StatusPill object="lead" state={selected.lead.status} />
                </header>
                {selected.conv.isTest ? <Banner kind="test">{t("inbox.test_banner")}</Banner> : null}
                {selected.conv.channel === SIMULATOR_CHANNEL ? <Banner kind="test">{t("sim.inbox_banner")}</Banner> : null}
                {selected.conv.status === "human" ? (
                  <Banner kind="takeover">
                    {thread.view.takenOverBy ? t("inbox.banner.held") : t("inbox.banner.handoff")}
                  </Banner>
                ) : null}
                {templateError ? (
                  <div className="sas-alert sas-alert--danger" role="alert" style={{ margin: 16 }}>
                    <Icon name="alert-triangle" /><span>{maybe(`inbox.template_error.${templateError}`) ?? t("inbox.template_error.provider_error")}</span>
                  </div>
                ) : null}
                {notice === "template_sent" ? (
                  <div className="sas-alert sas-alert--success" role="status" style={{ margin: 16 }}><Icon name="check-circle" /><span>{t("inbox.template_sent")}</span></div>
                ) : null}
                <div className="sas-inbox__thread-body">
                  <div className="sas-inbox__chat">
                    <ScrollThreadToEnd />
                    <ConversationPanel
                      from="inbox" chatWindow={thread.chatWindow} slug={account.slug} view={thread.view} me={me} buyerName={selected.lead.fullName} timezone={account.timezone}
                      leadOptedOut={selected.lead.status === "opted_out"} notice={notice === "template_sent" ? undefined : notice}
                      leadStatus={selected.lead.status} notes={thread.notes} rawToolNames={seesPlatformDetails(access)}
                      steps={{ show: showSteps, back: `${qs({})}#thread` }}
                    />
                    {thread.chatWindow && !thread.chatWindow.open && selected.lead.status !== "opted_out" ? (
                      <section className="sas-stack-2 sas-inbox__templates" aria-labelledby="tpl-h">
                        <h3 id="tpl-h" className="sas-label" style={{ margin: 0 }}>{t("inbox.template.title")}</h3>
                        <p className="sas-small" style={{ margin: 0 }}>{t("inbox.template.hint")}</p>
                        {thread.templates.length === 0 ? (
                          <div className="sas-alert sas-alert--warning" role="status">
                            <Icon name="info" />
                            <span>{t("inbox.template.none")} <a href={`/app/${account.slug}/settings?section=whatsapp`}>{t("inbox.template.settings")}</a></span>
                          </div>
                        ) : (
                          <form action={sendTemplateAction} className="sas-stack-2">
                            <input type="hidden" name="slug" value={account.slug} />
                            <input type="hidden" name="conversationId" value={selected.conv.id} />
                            <fieldset className="sas-stack-2" style={{ border: 0, margin: 0, padding: 0 }}>
                              <legend className="sas-sr">{t("inbox.template.title")}</legend>
                              {thread.templates.map((tpl, i) => (
                                <label key={tpl.id} className="sas-inbox__template">
                                  <input type="radio" name="templateId" value={tpl.id} defaultChecked={i === 0} required />
                                  <span className="sas-stack-2" style={{ gap: 2, minWidth: 0 }}>
                                    <strong>{tpl.name} <span className="sas-small">· {t(`inbox.template.purpose.${tpl.purpose}`)} · {tpl.language.toUpperCase()}</span></strong>
                                    <span className="sas-small" dir="auto">{renderTemplate(tpl.body, { "1": selected.lead.fullName.trim().split(/\s+/)[0] ?? "", "2": account.tradeName })}</span>
                                  </span>
                                </label>
                              ))}
                            </fieldset>
                            <div><button type="submit" className={buttonClass("primary", "sm")}><Icon name="send" />{t("inbox.template.send")}</button></div>
                          </form>
                        )}
                      </section>
                    ) : null}
                  </div>
                  <aside className="sas-inbox__side" aria-label={t("inbox.side")}>
                    {thread.handoff ? (
                      <section className="sas-stack-2 sas-inbox__brief" aria-labelledby="brief-h">
                        <h3 id="brief-h" className="sas-label" style={{ margin: 0, display: "flex", gap: 6, alignItems: "center" }}><Icon name="sparkles" />{t("inbox.brief.title")}</h3>
                        {thread.handoff.reason ? <div><div className="sas-small">{t("inbox.brief.why")}</div><div>{thread.handoff.reason}</div></div> : null}
                        {thread.handoff.summary ? <div><div className="sas-small">{t("inbox.brief.known")}</div><div>{thread.handoff.summary}</div></div> : null}
                        {thread.handoff.objections.length ? <div data-testid="brief-objections"><div className="sas-small">{t("inbox.brief.objections")}</div><ObjectionList objections={thread.handoff.objections.map((o) => ({ line: objectionLine(o), status: o.status, words: o.words }))} /></div> : null}
                      </section>
                    ) : null}
                    <section className="sas-stack-2" aria-labelledby="deal-h">
                      <h3 id="deal-h" className="sas-group-label" style={{ margin: 0, padding: 0 }}>{t("inbox.deal")}</h3>
                      <DealStatePane pane={thread.pane} />
                      {selected.conv.isTest ? null : <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads/${selected.lead.id}`} style={{ alignSelf: "flex-start" }}><Icon name="arrow-up-right" />{t("inbox.open_lead")}</a>}
                    </section>
                  </aside>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
