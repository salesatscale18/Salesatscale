import { Fragment } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import { DealStateFields } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { llmConfigured } from "@/lib/agent/llm";
import { conversationMessages, getConversation, getDealState, listTestConversations, listVersions } from "@/lib/agent/service";
import { exactTime, relativeTime } from "@/lib/format";
import { dir, isLocale, t, type MessageKey } from "@/lib/i18n";
import { publishAction, rollbackAction, startChatAction } from "./actions";
import { Composer } from "./composer";

// A turn can take several model rounds.
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Setup · Versions and test lab (P4.4): versions with publish/rollback, a test chat with the draft and its tool trace. */
export default async function TestLabPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  const versions = await listVersions(appDb, account.id);
  const draft = versions.find((v) => v.status === "draft");
  const chats = await listTestConversations(appDb, account.id);
  const conv = sp.c ? await getConversation(appDb, account.id, one(sp.c)) : null;
  const thread = conv?.isTest ? await conversationMessages(appDb, account.id, conv.id) : [];
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
                  const trace: TraceItem[] = calls.map((c) => ({ kind: c.name === "lookup_knowledge" ? "knowledge" : "tool", label: c.outcome === "ok" ? c.name : `${c.name} · ${c.outcome}` }));
                  const usage = m.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
                  return (
                    <Fragment key={m.id}>
                      <ChatMessage actor={actor} who={t(`lab.who.${actor}` as MessageKey)} time={exactTime(m.createdAt)} locale={m.language && isLocale(m.language) ? m.language : "en"} trace={trace}>
                        {m.body}
                      </ChatMessage>
                      {calls.length || usage ? (
                        <details className="sas-msg sas-msg--agent" style={{ maxWidth: "100%", width: "100%" }}>
                          <summary className="sas-small">{t("lab.trace")}{usage?.inputTokens !== undefined ? ` · ${t("lab.tokens", { input: usage.inputTokens, output: usage.outputTokens ?? 0, cached: usage.cacheReadTokens ?? 0 })}` : ""}</summary>
                          <ol className="sas-stack-2" style={{ margin: 0, paddingInlineStart: 20, textAlign: "start" }}>
                            {calls.map((c) => (
                              <li key={c.id} className="sas-stack-2">
                                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                  <strong className="sas-num">{c.name}</strong>
                                  {c.outcome === "refused" || c.outcome === "failed" ? <StatusPill object="tool_call" state={c.outcome} /> : null}
                                  {c.rule ? <span className="sas-small">{c.rule}</span> : null}
                                </div>
                                <span className="sas-small">{t("lab.input")}</span>
                                <pre className="sas-code" dir="ltr">{json(c.input)}</pre>
                                <span className="sas-small">{t("lab.result")}</span>
                                <pre className="sas-code" dir="ltr">{json(c.result)}</pre>
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : null}
                    </Fragment>
                  );
                })}
                <span id="end" />
              </ChatThread>
              {conv.status === "open" ? <Composer slug={account.slug} conversationId={conv.id} dir={dir(locale)} /> : (
                <div className="sas-alert" role="status" style={{ margin: 16 }}><Icon name="pause" /><span>{t(conv.status === "human" ? "lab.human" : "lab.closed")}</span></div>
              )}
            </section>
          ) : null}

          <section className="sas-panel" aria-labelledby="lab-new-h">
            <form action={startChatAction} className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <h2 id="lab-new-h" className="sas-heading" style={{ flexBasis: "100%" }}>{t("lab.new_chat")}</h2>
              <input type="hidden" name="slug" value={account.slug} />
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
