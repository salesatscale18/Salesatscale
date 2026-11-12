import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listFacts } from "@/lib/agent/service";
import { t } from "@/lib/i18n";
import { addFactAction, removeFactAction } from "./actions";

/** Setup · Knowledge (P4.7, minimal): approved facts with their source. Documents and the review queue come in P8. */
export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const facts = await listFacts(appDb, account.id);
  const base = `/app/${account.slug}`;
  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head"><h1 className="sas-title">{t("knowledge.title")}</h1></div>
        <span className="sas-small">{t("knowledge.intro")}</span>
        <SetupSteps basePath={base} current="knowledge" completed={new Set()} />
      </header>
      {sp.added ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("knowledge.added")}</span></div> : null}
      {sp.error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("knowledge.error")}</span></div> : null}
      <div className="sas-split">
        <div className="sas-split__main">
          {facts.length === 0 ? (
            <section className="sas-panel sas-empty">
              <span className="sas-empty__icon sas-empty__icon--start"><Icon name="book-open" /></span>
              <strong>{t("knowledge.empty.title")}</strong>
              <span className="sas-small">{t("knowledge.empty.body")}</span>
            </section>
          ) : (
            <section className="sas-panel" aria-labelledby="kf-h">
              <div className="sas-panel__body sas-stack-4">
                <h2 id="kf-h" className="sas-heading">{t("knowledge.count", { count: facts.length })}</h2>
                <ul className="sas-stack-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {facts.map((f) => (
                    <li key={f.id} className="sas-stack-2" style={{ borderBlockEnd: "1px solid var(--line)", paddingBlockEnd: 12 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <strong>{f.topic}</strong>
                        {f.sourceLabel ? <span className="sas-chip"><Icon name="file-text" />{f.sourceLabel}</span> : null}
                        <form action={removeFactAction} style={{ marginInlineStart: "auto" }}>
                          <input type="hidden" name="slug" value={account.slug} />
                          <input type="hidden" name="factId" value={f.id} />
                          <Button type="submit" variant="ghost" size="sm">{t("knowledge.remove")}</Button>
                        </form>
                      </div>
                      <span>{f.statement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
        <aside className="sas-split__side">
          <section className="sas-panel" aria-labelledby="kf-add">
            <form action={addFactAction} className="sas-panel__body sas-stack-4">
              <h2 id="kf-add" className="sas-heading">{t("knowledge.add")}</h2>
              <input type="hidden" name="slug" value={account.slug} />
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="kf-topic">{t("knowledge.topic")}</label>
                <input className="sas-input" id="kf-topic" name="topic" required maxLength={60} />
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="kf-statement">{t("knowledge.statement")}</label>
                <textarea className="sas-textarea" id="kf-statement" name="statement" rows={4} required maxLength={1000} />
              </div>
              <div className="sas-input-group">
                <label className="sas-input-label" htmlFor="kf-source">{t("knowledge.source")}</label>
                <input className="sas-input" id="kf-source" name="source" maxLength={200} aria-describedby="kf-source-hint" />
                <span className="sas-hint" id="kf-source-hint">{t("knowledge.source_hint")}</span>
              </div>
              <div><Button type="submit" variant="primary">{t("knowledge.add")}</Button></div>
            </form>
          </section>
        </aside>
      </div>
    </main>
  );
}
