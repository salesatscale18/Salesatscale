import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { isUuid } from "@/lib/security/ids";
import { Fragment } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import { MessageBody } from "@/components/sas/message-body";
import { QuoteCardMessage } from "../../leads/[leadId]/quote-card-message";
import { APP_MESSAGE_CALL, appMessageKinds, isAppText } from "@/lib/agent/app-message";
import { DealStateFields } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { seesPlatformDetails } from "@/lib/auth/display";
import { llmConfigured } from "@/lib/agent/llm";
import { getConversation, getDealState, listTestConversations, listVersions } from "@/lib/agent/service";
import { conversationView } from "@/lib/agent/conversation";
import { SCENARIOS, scenarioById, type ScenarioResult } from "@/lib/agent/scenarios";
import { conversationScenarioCheck, latestScenarioResults, scenarioTable } from "@/lib/agent/scenario-results";
import { getLead } from "@/lib/leads/service";
import { type IconName } from "@/components/sas/icon";
import { formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { dir, isLocale, t, type MessageKey } from "@/lib/i18n";
import { describeCall } from "@/lib/agent/trace";
import { toolLabel } from "../../leads/[leadId]/conversation";
import { publishAction, rollbackAction, startChatAction } from "./actions";
import { Composer } from "./composer";
import { AutoSubmit } from "@/components/sas/list-kit-client";
import { ListTable } from "@/components/sas/list-kit";
import { ConversationControls, deliveryLabel, windowTimerProps } from "../../leads/[leadId]/conversation";
import { WindowTimer } from "@/components/sas/record";
import { conversationWindow } from "@/lib/channels/whatsapp";
import { listConnections } from "@/lib/channels/connections";
import { twilioConfig } from "@/lib/channels/twilio";

// A turn can take several model rounds.
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Setup · Versions and test lab (P4.4; board: TestLabNew). New test chat in
 * one row on top, the open chat with its tool trace, and the scenarios table
 * for the version picked under "Results for" (applies on change): what each
 * scenario checks, whether it has a test chat on that version, the last one
 * the automatic result of the last one (Passed / Not yet / Failed / Not run)
 * and Run. Run starts one test chat (the opening is put in the composer; nothing is
 * sent until the seller clicks Send), so there is no run-all. Versions,
 * Recent test chats and Test on WhatsApp sit on the side.
 */
/**
 * Scenario results have no status word in the design system, so they are
 * plain pill-styled chips with an icon (neutral / success / danger).
 */
const RESULT_LOOK: Record<ScenarioResult | "not_run", { cls: string; icon: IconName }> = {
  passed: { cls: "sas-pill sas-pill--success", icon: "check-circle" },
  not_yet: { cls: "sas-pill", icon: "clock" },
  failed: { cls: "sas-pill sas-pill--danger", icon: "x-circle" },
  not_run: { cls: "sas-pill", icon: "circle-dot" },
};
function ResultChip({ result }: { result: ScenarioResult | "not_run" }) {
  const look = RESULT_LOOK[result];
  return <span className={look.cls} data-scenario-result={result}><Icon name={look.icon} />{t(`lab.scenario_result.${result}`)}</span>;
}

export default async function TestLabPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account, user } = access;
  // Model and effort are platform details: sellers do not see them (live review 7.1.3).
  const showModel = seesPlatformDetails(access);
  // Records in the account's time zone, the zone on hover (not "13:42 UTC").
  const tz = account.timezone;
  const local = (at: Date) => formatLocalDateTime(at, tz);
  const isAdmin = user.role === "super_admin";
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  const [versions, chats, conv, waNumbers] = await Promise.all([
    listVersions(appDb, account.id),
    listTestConversations(appDb, account.id),
    isUuid(one(sp.c)) ? getConversation(appDb, account.id, one(sp.c)) : Promise.resolve(null),
    listConnections(appDb, account.id),
  ]);
  const testerNumbers = waNumbers.filter((c) => c.status === "active" && c.testerNumbers.length > 0);
  const onWhatsapp = conv?.channel === "whatsapp";
  const waWindow = onWhatsapp && conv && conv.status !== "closed" ? await conversationWindow(appDb, account.id, conv.id) : null;
  const draft = versions.find((v) => v.status === "draft");
  const scenario = conv?.isTest ? scenarioById(conv.scenario) : null;
  const scenarios = SCENARIOS.filter((s) => account.languages.includes(s.language));
  // Scenario results for the version picked in the panel, else the open chat's, else the draft (or newest).
  const resultsVersion = versions.find((v) => v.id === one(sp.v)) ?? versions.find((v) => v.id === conv?.agentVersionId) ?? draft ?? versions[0];
  const [view, convLead, scenarioCheck, results, deal] = await Promise.all([
    conv?.isTest ? conversationView(appDb, account.id, conv) : null,
    conv?.isTest ? getLead(appDb, account.id, conv.leadId) : null,
    conv?.isTest ? conversationScenarioCheck(appDb, account.id, conv) : null,
    resultsVersion ? latestScenarioResults(appDb, account.id, resultsVersion.id) : [],
    conv ? getDealState(appDb, account.id, conv.leadId) : null,
  ]);
  const thread = view?.thread ?? [];
  // R5-14: the chat started with its first message (a seeded or imported chat can be older than its row).
  const chatStarted = conv ? new Date(Math.min(conv.createdAt.getTime(), ...thread.map((x) => x.message.createdAt.getTime()))) : new Date();
  // Messages the app wrote (the quote message) are known from the tool call that wrote them.
  const kinds = appMessageKinds(thread.flatMap((x) => x.calls));
  const notice = one(sp.notice) || undefined;
  const convVersion = conv ? versions.find((v) => v.id === conv.agentVersionId) : undefined;
  const error = one(sp.error);
  const locale = conv && isLocale(conv.language) ? conv.language : "en";
  const table = scenarioTable(scenarios, results);
  const versionLabel = (v: (typeof versions)[number]) => `${t("lab.version", { version: v.version })} · ${t(`status.agent_version.${v.status}` as MessageKey)}`;
  // The language is named only when the title does not already say it ("Hebrew buyer", not "Hebrew buyer (Hebrew)").
  const scenarioLabel = (s: (typeof scenarios)[number]) => {
    const lang = LANG_NAME[s.language] ?? s.language;
    return s.language === "en" || s.title.toLowerCase().includes(lang.toLowerCase()) ? s.title : `${s.title} (${lang})`;
  };
  const now = new Date();
  // The open chat's Deal state (R4 D4): directly under the chat on a phone, in the side column on a wide screen.
  const dealCard = (at: "main" | "side") => (conv && convVersion ? (
            <section className={`sas-panel lab-deal lab-deal--${at}`} aria-labelledby={`lab-deal-h-${at}`} data-deal-card={at}>
              <div className="sas-panel__body sas-stack-4">
                <h2 id={`lab-deal-h-${at}`} className="sas-heading">{t("lab.deal_state")}</h2>
                <DealStateFields fields={convVersion.playbook.fields.map((f) => ({ key: f.key, label: f.label, value: deal?.fields[f.key]?.value, provenance: deal?.fields[f.key]?.provenance }))} />
                {deal?.objections.length ? (
                  <div className="sas-stack-2">
                    <span className="sas-group-label">{t("lead.card.objections")}</span>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>{deal.objections.map((o, i) => <li key={i}>{o.text}{o.handled ? " ✓" : ""}</li>)}</ul>
                  </div>
                ) : null}
                {deal?.nextStep ? <div className="sas-stack-2"><span className="sas-group-label">{t("lead.card.next_step")}</span><span>{deal.nextStep}</span></div> : null}
              </div>
            </section>
  ) : null);

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("lab.title")}</h1>
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}/setup/playbook`}><Icon name="scroll-text" />{t("lab.edit_playbook")}</a>
            {draft ? (
              <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="primary">{t("lab.publish", { version: draft.version })}</Button></form>
            ) : null}
          </div>
        </div>
        <span className="sas-small">{t("lab.intro")}</span>
        <SetupSteps basePath={`/app/${account.slug}`} current="" completed={await setupProgress(appDb, account)} />
      </header>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.published", { version: one(sp.published) })}</span></div> : null}
      {sp.rolledback ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.rolled_back", { version: one(sp.rolledback) })}</span></div> : null}
      {!llmConfigured() || error === "no_key" ? <div className="sas-alert sas-alert--warning" role="alert"><Icon name="alert-triangle" /><span>{t("lab.no_key")}</span></div> : null}
      {error === "model" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.error")}</span></div> : null}
      {error === "spend_cap" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.spend_cap")}</span></div> : null}
      {error === "rate_limited" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.rate_limited")}</span></div> : null}
      {account.status === "paused" || error === "paused" ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="pause" /><span>{t("lab.paused")}</span></div> : null}

      <div className="sas-split lab-split">
        <div className="sas-split__main">
          <section className="sas-panel" aria-labelledby="lab-new-h">
            <form action={startChatAction} className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} data-new-chat="">
              <h2 id="lab-new-h" className="sas-heading" style={{ flex: "0 0 auto", alignSelf: "center", marginInlineEnd: 4 }}>{t("lab.new_chat")}</h2>
              <input type="hidden" name="slug" value={account.slug} />
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="lab-scenario">{t("lab.scenario")}</label>
                <select className="sas-select" id="lab-scenario" name="scenario" defaultValue="">
                  <option value="">{t("lab.scenario_none")}</option>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{scenarioLabel(s)}</option>)}
                </select>
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="lab-lang">{t("lab.language")}</label>
                <select className="sas-select" id="lab-lang" name="language" defaultValue={account.languages[0]}>
                  {account.languages.map((l) => <option key={l} value={l}>{LANG_NAME[l] ?? l}</option>)}
                </select>
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="lab-ver">{t("lab.version_label")}</label>
                <select className="sas-select" id="lab-ver" name="versionId" defaultValue={draft?.id ?? ""}>
                  {draft ? null : <option value="">{t("lab.new_draft")}</option>}
                  {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                </select>
              </div>
              <Button type="submit" variant="primary"><Icon name="plus" />{t("lab.start")}</Button>
            </form>
          </section>

          {conv && convVersion ? (
            <section className="sas-panel" aria-labelledby="lab-chat-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <h2 id="lab-chat-h" className="sas-heading">{t("lab.chat_with", { version: convVersion.version })}</h2>
                <StatusPill object="agent_version" state={convVersion.status} />
                {/* R5-14: when the chat started (its first message), not when the conversation row was made. */}
                <span className="sas-small">{LANG_NAME[conv.language] ?? conv.language} · <time dateTime={chatStarted.toISOString()} title={zoneTitle(chatStarted, tz)} data-chat-started="">{local(chatStarted)}</time></span>
                {onWhatsapp ? <span className="sas-chip"><Icon name="message-circle" />{t("lab.wa.chip", { phone: conv.channelAddress ?? "" })}</span> : null}
                {waWindow ? <WindowTimer {...windowTimerProps(waWindow, new Date())} /> : null}
              </div>
              <ChatThread label={t("lab.chat_with", { version: convVersion.version })}>
                {thread.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("lab.chat_empty")}</p> : null}
                {thread.map(({ message: m, calls: allCalls }) => {
                  // The app's own messages (after a seller approval) are linked by an app_message row: not a tool call.
                  const calls = allCalls.filter((c) => c.name !== APP_MESSAGE_CALL);
                  const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? "agent" : m.actor === "human" ? "human" : "system";
                  const trace: TraceItem[] = [];
                  const usage = m.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
                  return (
                    <Fragment key={m.id}>
                      {calls.length ? (
                        <ol className="sas-stack-2" aria-label={t("lab.trace")} style={{ margin: 0, paddingInlineStart: 0, listStyle: "none", alignSelf: "flex-end", maxWidth: "78%", width: "100%" }}>
                          {calls.map((c) => {
                            const d = describeCall(c.name, c.input, c.result, c.outcome);
                            return (
                              <li key={c.id} className="sas-stack-2" style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
                                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                  <strong className="sas-num sas-small" title={showModel ? d.label : undefined}>{c.sequence}. {toolLabel(c.name)}</strong>
                                  {c.outcome === "refused" || c.outcome === "failed" ? <StatusPill object="tool_call" state={c.outcome} /> : null}
                                </div>
                                {d.sent ? <span className="sas-small">{t("lab.trace_sent")}: {d.sent}</span> : null}
                                {d.got ? <span className="sas-small">{t("lab.trace_got")}: {d.got}{d.missing.length ? ` — ${t("lab.trace_missing")}: ${d.missing.join(", ")}` : ""}</span> : null}
                                <details>
                                  <summary className="sas-small">{t("lab.show_raw")}</summary>
                                  <pre className="sas-code" dir="ltr">{json({ input: c.input, result: c.result })}</pre>
                                </details>
                              </li>
                            );
                          })}
                        </ol>
                      ) : null}
                      {view?.quoteCards[m.id] ? (
                        <QuoteCardMessage card={view.quoteCards[m.id]} time={local(m.createdAt)} slug={null} approve={null} />
                      ) : (
                      <ChatMessage
                        actor={actor} who={actor === "agent" && isAppText(kinds.get(m.id)) ? t("conv.qcard.sent_by_app") : t(`lab.who.${actor}` as MessageKey)}
                        time={(actor === "agent" || actor === "human") && deliveryLabel(m) ? `${local(m.createdAt)} · ${deliveryLabel(m)}` : local(m.createdAt)} timeTitle={zoneTitle(m.createdAt, tz)} locale={m.language && isLocale(m.language) ? m.language : "en"} trace={trace}>
                        {/* R5-2: each message finds its own direction (an English reply in a Hebrew chat reads left to right). */}
                        <div dir="auto" data-msg-dir="">
                          <MessageBody body={m.body} kind={kinds.get(m.id)} />
                        </div>
                      </ChatMessage>
                      )}
                      {isAdmin && usage?.inputTokens !== undefined ? (
                        <span className="sas-small sas-num" style={{ alignSelf: "flex-end" }}>{t("lab.tokens", { input: usage.inputTokens, output: usage.outputTokens ?? 0, cached: usage.cacheReadTokens ?? 0 })}</span>
                      ) : null}
                    </Fragment>
                  );
                })}
                <span id="end" />
              </ChatThread>
              {scenario && scenarioCheck ? (
                <div className="sas-stack-2" role="status" aria-label={t("lab.scenario_check", { title: scenario.title })} style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong className="sas-small">{t("lab.scenario_check", { title: scenario.title })}</strong>
                    <ResultChip result={scenarioCheck.result} />
                  </div>
                  <span className="sas-small">{scenarioCheck.reason} {t("lab.scenario_expected", { text: scenario.expected })}</span>
                </div>
              ) : null}
              {conv.status === "closed" ? (
                <div className="sas-alert" role="status" style={{ margin: 16 }}><Icon name="pause" /><span>{t("lab.closed")}</span></div>
              ) : (
                <>
                  {onWhatsapp ? (
                    <p className="sas-small" role="status" style={{ margin: 0, padding: 16, borderBlockStart: "1px solid var(--line)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <Icon name="message-circle" />{t("lab.wa.reply_from_phone", { phone: conv.channelAddress ?? "" })}
                      <a href={`${lab}?c=${conv.id}#end`}>{t("lab.wa.refresh")}</a>
                    </p>
                  ) : (
                    <Composer
                      slug={account.slug} conversationId={conv.id} dir={dir(locale)}
                      initialText={scenario && thread.length === 0 ? scenario.opening : undefined}
                    />
                  )}
                  {view ? (
                    <ConversationControls
                      slug={account.slug} from="lab" view={view} me={user} buyerName={t("lab.who.buyer")}
                      leadOptedOut={convLead?.lead.status === "opted_out"} notice={notice}
                    />
                  ) : null}
                </>
              )}
            </section>
          ) : null}
          {dealCard("main")}

          <section className="sas-stack-4" aria-labelledby="lab-sc-h" data-scenarios="">
            <div className="sas-listbar__head">
              <div className="sas-stack-2" style={{ gap: 2, flex: "1 1 240px", minWidth: 0 }}>
                <h2 id="lab-sc-h" className="sas-heading">{t("lab.scenarios")}</h2>
                {resultsVersion ? (
                  <span className="sas-small" style={{ fontVariantNumeric: "tabular-nums" }} data-scenarios-passed="">{t("lab.scenarios_passed", { n: table.passed, total: table.total, version: resultsVersion.version })}</span>
                ) : null}
              </div>
              {resultsVersion && versions.length > 1 ? (
                <form method="get" action={lab} className="sas-listbar__form" role="search" aria-label={t("lab.results_for")}>
                  {conv ? <input type="hidden" name="c" value={conv.id} /> : null}
                  <label className="sas-listbar__select" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="sas-small">{t("lab.results_for")}</span>
                    <select className="sas-select" name="v" defaultValue={resultsVersion.id} data-results-for="">
                      {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                    </select>
                  </label>
                  <button type="submit" className={`${buttonClass("secondary", "sm")} sas-listbar__apply`}>{t("lab.scenarios_show")}</button>
                  <AutoSubmit />
                </form>
              ) : resultsVersion ? (
                <span className="sas-small">{t("lab.results_for")}: {versionLabel(resultsVersion)}</span>
              ) : null}
            </div>
            <ListTable caption={t("lab.scenarios")} foot={<span className="sas-small">{t("lab.scenarios_note")}</span>}>
              <thead>
                <tr>
                  <th scope="col">{t("lab.col.scenario")}</th>
                  <th scope="col">{t("lab.col.result")}</th>
                  <th scope="col">{t("lab.col.last_chat")}</th>
                  <th scope="col"><span className="sas-sr">{t("lab.run")}</span></th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.scenario.id} data-scenario={r.scenario.id} data-current={conv?.id && conv.id === r.conversationId ? "" : undefined}>
                    <td style={{ minWidth: 220, whiteSpace: "normal" }}>
                      <strong style={{ display: "block" }}>{scenarioLabel(r.scenario)}</strong>
                      <span className="sas-small" style={{ display: "block" }}>{r.scenario.expected}</span>
                    </td>
                    <td data-label={t("lab.col.result")} style={{ whiteSpace: "normal" }}>
                      <ResultChip result={r.result} />
                      {r.reason && r.result !== "passed" ? <span className="sas-small" style={{ display: "block", marginBlockStart: 4 }} data-scenario-reason="">{r.reason}</span> : null}
                    </td>
                    <td data-label={t("lab.col.last_chat")} className="sas-when">
                      {r.conversationId && r.lastAt ? (
                        <a href={`${lab}?c=${r.conversationId}${resultsVersion ? `&v=${resultsVersion.id}` : ""}`} data-last-chat="">
                          <time dateTime={r.lastAt.toISOString()} title={`${local(r.lastAt)} · ${zoneTitle(r.lastAt, tz)}`}>{timeAgo(r.lastAt, now, tz)}</time>
                        </a>
                      ) : <span className="sas-small">—</span>}
                    </td>
                    <td data-label="" className="sas-td-actions">
                      <form action={startChatAction}>
                        <input type="hidden" name="slug" value={account.slug} />
                        <input type="hidden" name="scenario" value={r.scenario.id} />
                        <input type="hidden" name="language" value={r.scenario.language} />
                        {resultsVersion ? <input type="hidden" name="versionId" value={resultsVersion.id} /> : null}
                        <button type="submit" className={buttonClass("secondary", "sm")} aria-label={t("lab.run_label", { title: r.scenario.title })} data-run="">{t("lab.run")}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ListTable>
          </section>
        </div>

        <aside className="sas-split__side sas-stack-4">
          {dealCard("side")}

          <section className="sas-panel" aria-labelledby="lab-ver-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="lab-ver-h" className="sas-heading">{t("lab.versions")}</h2>
              {versions.length === 0 ? <span className="sas-small">{t("lab.no_draft")}</span> : null}
              <ul className="sas-stack-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {versions.map((v) => (
                  <li key={v.id} className="sas-stack-2">
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong className="sas-id">{t("lab.version", { version: v.version })}</strong>
                      <StatusPill object="agent_version" state={v.status} />
                      {v.status === "retired" ? (
                        <form action={rollbackAction} style={{ marginInlineStart: "auto" }}>
                          <input type="hidden" name="slug" value={account.slug} />
                          <input type="hidden" name="versionId" value={v.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("lab.rollback")}</Button>
                        </form>
                      ) : null}
                    </div>
                    <span className="sas-small">{showModel ? <span data-version-model="">{t("lab.version_model", { model: v.model, effort: v.effort })}</span> : null}{showModel && v.publishedAt ? " · " : null}{v.publishedAt ? <><time dateTime={v.publishedAt.toISOString()} title={zoneTitle(v.publishedAt, tz)}>{t("lab.published_at", { date: local(v.publishedAt) })}</time></> : null}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="lab-chats-h">
            <div className="sas-panel__body sas-stack-2">
              <h2 id="lab-chats-h" className="sas-heading">{t("lab.chats")}</h2>
              {chats.length === 0 ? <span className="sas-small">{t("lab.chats_empty")}</span> : null}
              <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {chats.map((c) => {
                  const v = versions.find((x) => x.id === c.agentVersionId);
                  return (
                    <li key={c.id}>
                      <a href={`${lab}?c=${c.id}`} aria-current={c.id === conv?.id ? "page" : undefined} style={{ display: "block", fontWeight: c.id === conv?.id ? 600 : undefined }} data-chat-name="">
                        {scenarioById(c.scenario)?.title ?? t("lab.free_chat")}
                      </a>
                      <span className="sas-small" style={{ display: "block" }}>
                        {t("lab.version", { version: v?.version ?? "?" })} · {LANG_NAME[c.language] ?? c.language}{c.channel === "whatsapp" ? ` · ${t("conv.channel.whatsapp")}` : ""} ·{" "}
                        <time dateTime={c.updatedAt.toISOString()} title={`${local(c.updatedAt)} · ${zoneTitle(c.updatedAt, tz)}`}>{timeAgo(c.updatedAt, now, tz)}</time>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
          <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="lab-wa-h">
            <h2 id="lab-wa-h" className="sas-heading">{t("lab.wa.title")}</h2>
            {testerNumbers.length === 0 ? (
              <span className="sas-small">{t("lab.wa.none")} <a href={`${base}/settings?section=whatsapp`}>{t("lab.wa.setup")}</a></span>
            ) : (
              <>
                <span className="sas-small">{t(twilioConfig() ? "lab.wa.how" : "lab.wa.not_configured")}</span>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {testerNumbers.map((c) => (
                    <li key={c.id} className="sas-small">
                      {t("lab.wa.pair", { testers: c.testerNumbers.join(", "), number: c.senderNumber })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
