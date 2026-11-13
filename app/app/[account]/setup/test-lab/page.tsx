import { Fragment } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import { DealStateFields } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { llmConfigured } from "@/lib/agent/llm";
import { getConversation, getDealState, listTestConversations, listVersions } from "@/lib/agent/service";
import { conversationView } from "@/lib/agent/conversation";
import { SCENARIOS, scenarioById, type ScenarioResult } from "@/lib/agent/scenarios";
import { conversationScenarioCheck, latestScenarioResults } from "@/lib/agent/scenario-results";
import { getLead } from "@/lib/leads/service";
import { type IconName } from "@/components/sas/icon";
import { exactTime, relativeTime } from "@/lib/format";
import { dir, isLocale, t, type MessageKey } from "@/lib/i18n";
import { describeCall } from "@/lib/agent/trace";
import { publishAction, rollbackAction, startChatAction } from "./actions";
import { Composer } from "./composer";
import { ConversationControls } from "../../leads/[leadId]/conversation";

// A turn can take several model rounds.
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const json = (v: unknown) => JSON.stringify(v, null, 2);

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

/** Setup · Versions and test lab (P4.4): versions with publish/rollback, a test chat with the draft and its tool trace. */
export default async function TestLabPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account, user } = await requireAccount(slug);
  const isAdmin = user.role === "super_admin";
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  const versions = await listVersions(appDb, account.id);
  const draft = versions.find((v) => v.status === "draft");
  const chats = await listTestConversations(appDb, account.id);
  const conv = sp.c ? await getConversation(appDb, account.id, one(sp.c)) : null;
  const view = conv?.isTest ? await conversationView(appDb, account.id, conv) : null;
  const thread = view?.thread ?? [];
  const convLead = conv?.isTest ? await getLead(appDb, account.id, conv.leadId) : null;
  const scenario = conv?.isTest ? scenarioById(conv.scenario) : null;
  const scenarioCheck = conv?.isTest ? await conversationScenarioCheck(appDb, account.id, conv) : null;
  const scenarios = SCENARIOS.filter((s) => account.languages.includes(s.language));
  // Scenario results for the version picked in the panel, else the open chat's, else the draft (or newest).
  const resultsVersion = versions.find((v) => v.id === one(sp.v)) ?? versions.find((v) => v.id === conv?.agentVersionId) ?? draft ?? versions[0];
  const results = resultsVersion ? await latestScenarioResults(appDb, account.id, resultsVersion.id) : [];
  const notice = one(sp.notice) || undefined;
  const convVersion = conv ? versions.find((v) => v.id === conv.agentVersionId) : undefined;
  const deal = conv ? await getDealState(appDb, account.id, conv.leadId) : null;
  const error = one(sp.error);
  const locale = conv && isLocale(conv.language) ? conv.language : "en";

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("lab.title")}</h1>
          <div className="sas-page-head__actions">
            <a className={buttonClass("secondary")} href={`${base}/setup/playbook`}><Icon name="sparkles" />{t("lab.edit_playbook")}</a>
            {draft ? (
              <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="primary">{t("lab.publish", { version: draft.version })}</Button></form>
            ) : null}
          </div>
        </div>
        <span className="sas-small">{t("lab.intro")}</span>
      </header>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.published", { version: one(sp.published) })}</span></div> : null}
      {sp.rolledback ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.rolled_back", { version: one(sp.rolledback) })}</span></div> : null}
      {!llmConfigured() || error === "no_key" ? <div className="sas-alert sas-alert--warning" role="alert"><Icon name="alert-triangle" /><span>{t("lab.no_key")}</span></div> : null}
      {error === "model" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.error")}</span></div> : null}

      <div className="sas-split">
        <div className="sas-split__main">
          {conv && convVersion ? (
            <section className="sas-panel" aria-labelledby="lab-chat-h" style={{ overflow: "hidden" }}>
              <div className="sas-panel__body" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <h2 id="lab-chat-h" className="sas-heading">{t("lab.chat_with", { version: convVersion.version })}</h2>
                <StatusPill object="agent_version" state={convVersion.status} />
                <span className="sas-small">{LANG_NAME[conv.language] ?? conv.language} · {exactTime(conv.createdAt)}</span>
              </div>
              <ChatThread label={t("lab.chat_with", { version: convVersion.version })}>
                {thread.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("lab.chat_empty")}</p> : null}
                {thread.map(({ message: m, calls }) => {
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
                                  <strong className="sas-num sas-small">{c.sequence}. {d.label}</strong>
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
                      <ChatMessage actor={actor} who={t(`lab.who.${actor}` as MessageKey)} time={exactTime(m.createdAt)} locale={m.language && isLocale(m.language) ? m.language : "en"} trace={trace}>
                        {m.body}
                      </ChatMessage>
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
                  <Composer
                    slug={account.slug} conversationId={conv.id} dir={dir(locale)}
                    initialText={scenario && thread.length === 0 ? scenario.opening : undefined}
                  />
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

          <section className="sas-panel" aria-labelledby="lab-new-h">
            <form action={startChatAction} className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <h2 id="lab-new-h" className="sas-heading" style={{ flexBasis: "100%" }}>{t("lab.new_chat")}</h2>
              <input type="hidden" name="slug" value={account.slug} />
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="lab-scenario">{t("lab.scenario")}</label>
                <select className="sas-select" id="lab-scenario" name="scenario" defaultValue="">
                  <option value="">{t("lab.scenario_none")}</option>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}{s.language !== "en" ? ` (${LANG_NAME[s.language] ?? s.language})` : ""}</option>)}
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
                  {versions.map((v) => <option key={v.id} value={v.id}>{t("lab.version", { version: v.version })} · {t(`status.agent_version.${v.status}` as MessageKey)}</option>)}
                </select>
              </div>
              <Button type="submit" variant="primary"><Icon name="plus" />{t("lab.start")}</Button>
            </form>
          </section>
        </div>

        <aside className="sas-split__side sas-stack-4">
          {conv && convVersion ? (
            <section className="sas-panel" aria-labelledby="lab-deal-h">
              <div className="sas-panel__body sas-stack-4">
                <h2 id="lab-deal-h" className="sas-heading">{t("lab.deal_state")}</h2>
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
          ) : null}

          {resultsVersion ? (
            <section className="sas-panel" aria-labelledby="lab-sc-h">
              <div className="sas-panel__body sas-stack-4">
                <div className="sas-page-head" style={{ gap: 8 }}>
                  <h2 id="lab-sc-h" className="sas-heading">{t("lab.scenarios")}</h2>
                  <span className="sas-num sas-small sas-page-head__actions">
                    {results.filter((r) => r.check?.result === "passed" && scenarios.some((s) => s.id === r.scenarioId)).length} / {scenarios.length}
                  </span>
                </div>
                <span className="sas-small">{t("lab.scenarios_for", { version: resultsVersion.version })}</span>
                {versions.length > 1 ? (
                  <form method="get" action={lab} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    {conv ? <input type="hidden" name="c" value={conv.id} /> : null}
                    <div className="sas-input-group">
                      <label className="sas-input-label" htmlFor="lab-sc-v">{t("lab.scenarios_version")}</label>
                      <select className="sas-select" id="lab-sc-v" name="v" defaultValue={resultsVersion.id}>
                        {versions.map((v) => <option key={v.id} value={v.id}>{t("lab.version", { version: v.version })} · {t(`status.agent_version.${v.status}` as MessageKey)}</option>)}
                      </select>
                    </div>
                    <Button type="submit" variant="ghost" size="sm">{t("lab.scenarios_show")}</Button>
                  </form>
                ) : null}
                <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {scenarios.map((s) => {
                    const r = results.find((x) => x.scenarioId === s.id);
                    return (
                      <li key={s.id} className="sas-stack-2" style={{ gap: 2 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <ResultChip result={r?.check?.result ?? "not_run"} />
                          <span style={{ flex: "1 1 0", minWidth: 0 }}>{r?.conversationId ? <a href={`${lab}?c=${r.conversationId}`}>{s.title}</a> : s.title}</span>
                        </div>
                        {r?.check && r.check.result !== "passed" ? <span className="sas-small">{r.check.reason}</span> : null}
                      </li>
                    );
                  })}
                </ul>
                <span className="sas-small">{t("lab.scenarios_manual")}</span>
              </div>
            </section>
          ) : null}

          <section className="sas-panel" aria-labelledby="lab-ver-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="lab-ver-h" className="sas-heading">{t("lab.versions")}</h2>
              {versions.length === 0 ? <span className="sas-small">{t("lab.no_draft")}</span> : null}
              <ul className="sas-stack-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {versions.map((v) => (
                  <li key={v.id} className="sas-stack-2">
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong className="sas-num">{t("lab.version", { version: v.version })}</strong>
                      <StatusPill object="agent_version" state={v.status} />
                      {v.status === "retired" ? (
                        <form action={rollbackAction} style={{ marginInlineStart: "auto" }}>
                          <input type="hidden" name="slug" value={account.slug} />
                          <input type="hidden" name="versionId" value={v.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("lab.rollback")}</Button>
                        </form>
                      ) : null}
                    </div>
                    <span className="sas-small">{t("lab.version_model", { model: v.model, effort: v.effort })}{v.publishedAt ? ` · ${t("lab.published_at", { date: exactTime(v.publishedAt) })}` : ""}</span>
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
                      <a href={`${lab}?c=${c.id}`} aria-current={c.id === conv?.id ? "page" : undefined}>
                        {t("lab.version", { version: v?.version ?? "?" })} · {LANG_NAME[c.language] ?? c.language}
                      </a>{" "}
                      <span className="sas-small">{relativeTime(c.updatedAt)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
