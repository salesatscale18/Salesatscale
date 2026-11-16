import { Avatar, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { Banner, DealStateFields, WindowTimer } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { nameInitials } from "@/lib/auth/display";
import { conversationView } from "@/lib/agent/conversation";
import { currentPlaybook, getDealState } from "@/lib/agent/service";
import { approvedTemplates, conversationWindow } from "@/lib/channels/whatsapp";
import { renderTemplate } from "@/lib/channels/rules";
import { INBOX_FILTERS, inboxConversation, latestHandoff, listInbox, parseInboxFilter, type InboxGroup, type InboxList, type InboxRow } from "@/lib/conversations/inbox";
import { relativeTime } from "@/lib/format";
import { listMarkets } from "@/lib/markets/service";
import { messages as i18n, t, type MessageKey } from "@/lib/i18n";
import { ConversationPanel, windowTimerProps } from "../leads/[leadId]/conversation";
import { sendTemplateAction } from "./actions";
import { AutoRefresh } from "./auto-refresh";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maybe = (key: string) => i18n.en[key as MessageKey] ?? null;

const GROUP_ORDER: InboxGroup[] = ["needs_you", "human", "agent", "closed"];

/** "Buyer: …", "Agent: …", "You: …" before the last message. */
function preview(r: InboxRow, meId: string) {
  if (!r.lastBody) return t("inbox.no_messages");
  const who = r.lastActor === "buyer" ? t("inbox.from.buyer")
    : r.lastActor === "agent" ? t("inbox.from.agent")
    : r.lastActor === "human" ? (r.lastUserId && r.lastUserId === meId ? t("inbox.from.you") : t("inbox.from.team"))
    : t("inbox.from.system");
  return `${who}: ${r.lastBody.replace(/\s+/g, " ").slice(0, 120)}`;
}

/** Conversations inbox (canvas: Inbox, P6.6). Filters, search and the selected chat live in the URL. */
export default async function ConversationsPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Search> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user: me } = await requireAccount(slug);
  const base = `/app/${account.slug}/conversations`;
  const filter = parseInboxFilter(one(sp.filter));
  const q = one(sp.q).trim().slice(0, 100) || undefined;
  const page = Math.max(1, Math.floor(Number(one(sp.page)) || 1));
  const selectedId = UUID.test(one(sp.c)) ? one(sp.c) : null;
  const now = new Date();

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | undefined> = { filter: filter === "all" ? undefined : filter, q, page: page > 1 ? String(page) : undefined, c: selectedId ?? undefined };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  // One parallel batch: the list (with counts) and the selected conversation.
  let list: InboxList | null = null;
  let selected: Awaited<ReturnType<typeof inboxConversation>> | null = null;
  let homeMarket = "";
  try {
    let marketList: { name: string }[];
    [list, selected, marketList] = await Promise.all([
      listInbox(appDb, account.id, { filter, q, page, now }),
      selectedId ? inboxConversation(appDb, account.id, selectedId) : Promise.resolve(null),
      listMarkets(appDb, account.id),
    ]);
    // Leads without a market belong to the home market (listMarkets puts it first).
    homeMarket = marketList[0]?.name ?? "";
  } catch (e) {
    console.error("[inbox] list failed", e);
  }

  // The selected thread's data, in a second parallel batch.
  const thread = selected
    ? await (async () => {
      const { conv, lead } = selected!;
      const whatsapp = conv.channel === "whatsapp";
      const [view, deal, playbook, chatWindow, templates, handoff] = await Promise.all([
        conversationView(appDb, account.id, conv),
        getDealState(appDb, account.id, lead.id),
        currentPlaybook(appDb, account.id),
        whatsapp && conv.status !== "closed" ? conversationWindow(appDb, account.id, conv.id, now) : Promise.resolve(null),
        whatsapp ? approvedTemplates(appDb, account.id) : Promise.resolve([]),
        conv.status === "human" ? latestHandoff(appDb, account.id, lead.id) : Promise.resolve(null),
      ]);
      return { view, deal, playbook, chatWindow, templates, handoff };
    })()
    : null;

  const notice = one(sp.notice) || undefined;
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
                <strong>{q ? t("inbox.empty.search") : t(`inbox.empty.${filter}`)}</strong>
                {q ? <a className={buttonClass("secondary", "sm")} href={qs({ q: undefined, page: undefined, c: undefined })}>{t("leads.filter.clear")}</a> : null}
              </div>
            ) : (
              groups.map(({ g, items }) => (
                <div key={g ?? "list"}>
                  {g ? <h3 className="sas-label sas-inbox__group">{t(`inbox.group.${g}`)} · <span className="sas-num">{list!.counts[g]}</span></h3> : null}
                  <ul className="sas-list">
                    {items.map((r) => {
                      const holding = r.group === "needs_you" || r.group === "human";
                      return (
                        <li key={r.conversationId}>
                          <a
                            className={`sas-inbox__row${r.lastActor === "buyer" && r.status !== "closed" ? " sas-inbox__row--unread" : ""}`}
                            href={`${qs({ c: r.conversationId })}#thread`}
                            aria-current={r.conversationId === selectedId ? "page" : undefined}
                          >
                            <Avatar actor={r.status === "closed" ? "buyer" : holding ? "human" : "agent"} initials={nameInitials(r.lead.fullName)} />
                            <span className="sas-inbox__row-main">
                              <span className="sas-inbox__row-top">
                                <span className="sas-inbox__name">{r.lead.fullName}{r.lead.company ? <span className="sas-small"> · {r.lead.company}</span> : null}</span>
                                <span className="sas-num sas-small" title={r.lastAt.toISOString()}>{relativeTime(r.lastAt, now)}</span>
                              </span>
                              <span className="sas-small sas-inbox__preview" dir="auto">{preview(r, me.id)}</span>
                              <span className="sas-inbox__meta">
                                {r.group === "needs_you" ? <span className="sas-inbox__badge"><Icon name="user" />{r.takenOverByUserId ? t("inbox.badge.buyer_waiting") : t("inbox.badge.handoff")}</span> : null}
                                <StatusPill object="lead" state={r.lead.status} />
                                <span className="sas-chip">{r.isTest ? t("inbox.channel.test") : maybe(`conv.channel.${r.channel}`) ?? r.channel}</span>
                                {r.marketName || homeMarket ? <span className="sas-chip">{r.marketName || homeMarket}</span> : null}
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
                  <a className={`${buttonClass("ghost", "sm")} sas-inbox__back`} href={qs({ c: undefined })}>{t("inbox.back")}</a>
                  <span className="sas-stack-2" style={{ gap: 2, minWidth: 0, flex: "1 1 220px" }}>
                    <strong>{selected.lead.fullName}{selected.lead.company ? ` · ${selected.lead.company}` : ""}</strong>
                    <span className="sas-small">
                      {[selected.marketName || homeMarket, t(`lang.${selected.lead.language as "en" | "he"}`)].filter(Boolean).join(" · ")}
                      {selected.conv.isTest ? null : <> · <a href={`/app/${account.slug}/leads/${selected.lead.id}`}>{t("inbox.open_lead")}</a></>}
                    </span>
                  </span>
                  <StatusPill object="lead" state={selected.lead.status} />
                </header>
                {selected.conv.isTest ? <Banner kind="test">{t("inbox.test_banner")}</Banner> : null}
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
                    <ConversationPanel
                      from="inbox" chatWindow={thread.chatWindow} slug={account.slug} view={thread.view} me={me} buyerName={selected.lead.fullName}
                      leadOptedOut={selected.lead.status === "opted_out"} notice={notice === "template_sent" ? undefined : notice}
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
                      </section>
                    ) : null}
                    <section className="sas-stack-2" aria-labelledby="deal-h">
                      <h3 id="deal-h" className="sas-group-label" style={{ margin: 0, padding: 0 }}>{t("inbox.deal")}</h3>
                      {!thread.playbook || thread.playbook.fields.length === 0 ? (
                        <p className="sas-small" style={{ margin: 0 }}>{t(thread.playbook ? "lead.card.learn_none" : "lead.card.learn_pending")}</p>
                      ) : (
                        <DealStateFields fields={thread.playbook.fields.map((f) => ({ key: f.key, label: f.label, value: thread.deal?.fields[f.key]?.value, provenance: thread.deal?.fields[f.key]?.provenance }))} />
                      )}
                      {thread.deal?.nextStep ? <div className="sas-stack-2"><span className="sas-group-label" style={{ padding: 0 }}>{t("lead.card.next_step")}</span><span>{thread.deal.nextStep}</span></div> : null}
                      {selected.conv.isTest ? null : <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads/${selected.lead.id}`} style={{ alignSelf: "flex-start" }}><Icon name="user" />{t("inbox.open_lead")}</a>}
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
