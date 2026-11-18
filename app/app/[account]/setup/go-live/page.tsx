import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { getMarketView, listMarkets } from "@/lib/markets/service";
import { Icon } from "@/components/sas/icon";
import { SetupSteps } from "@/components/sas/nav";
import { setupProgress } from "@/lib/overview/setup";
import { appDb, requireAccount } from "@/lib/auth/account";
import { loadGoLive, ROLLOUT_MODES, type GoLiveCheck } from "@/lib/accounts/go-live";
import { t, type MessageKey } from "@/lib/i18n";
import { goLiveAction, saveRolloutAction } from "./actions";
import { checkCount } from "@/lib/markets/rules";
import type { WhatsappStatus } from "@/lib/channels/rules";
import { CheckIcon, checkStateWord, WhatsAppStatusPill } from "../../settings/whatsapp-status";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function detail(c: GoLiveCheck): string {
  const d = c.data;
  if (c.state === "later") return t("golive.later");
  const ok = c.state === "pass";
  switch (c.id) {
    case "company": return ok ? t("golive.check.company.ok") : t("golive.check.company.fail", { missing: String(d.missing) });
    case "catalog": return ok ? t("golive.check.catalog.ok", { version: d.version, count: d.products }) : t("golive.check.catalog.fail");
    case "agent": return ok ? t("golive.check.agent.ok", { version: d.version }) : t("golive.check.agent.fail");
    case "knowledge": return ok ? t("golive.check.knowledge.ok", { count: d.count }) : t("golive.check.knowledge.fail");
    case "legal": return ok ? t("golive.check.legal.ok") : t("golive.check.legal.fail", { missing: String(d.missing) || "-" });
    case "payments": {
      if (!ok) return t(d.bankWithoutDetails ? "golive.check.payments.no_bank" : "golive.check.payments.fail");
      const methods = String(d.methods).split("+").map((m) => t(m === "card" ? "golive.method.card" : "golive.method.bank")).join(" · ");
      return t("golive.check.payments.ok", { methods });
    }
    case "test_lab": return ok ? t("golive.check.test_lab.ok", { count: d.count }) : t("golive.check.test_lab.fail");
    case "whatsapp": return ok ? t("golive.check.whatsapp.ok", { count: d.numbers }) : t(d.numbers ? "golive.check.whatsapp.no_opener" : "golive.check.whatsapp.fail");
    default: return "";
  }
}

/** Setup 8 · Go live (P8.7, canvas: GoLive). Checks come from real data, computed on the server. */
export default async function GoLivePage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const [result, marketList] = await Promise.all([loadGoLive(appDb, account), listMarkets(appDb, account.id)]);
  const marketViews = (await Promise.all(marketList.map((m) => getMarketView(appDb, account.id, m.id)))).filter((v) => v !== null);
  const base = `/app/${account.slug}`;
  const pct = result.total === 0 ? 0 : Math.round((result.passed / result.total) * 100);
  const err = one(sp.error);
  const liveSince = account.wentLiveAt
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: account.timezone }).format(account.wentLiveAt)
    : null;

  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <div className="sas-page-head">
          <h1 className="sas-title">{t("golive.title")}</h1>
          <div className="sas-page-head__actions">
            {account.status === "live" && liveSince ? (
              account.rollout === "test_only" ? (
                // Only test leads are contacted: live, but not with real buyers yet.
                <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <span className="sas-pill sas-pill--success" data-live="test_only"><Icon name="check-circle" />{t("golive.live_test_only")}</span>
                  <span className="sas-small">{t("golive.live_since", { date: liveSince })}</span>
                </span>
              ) : (
                <span className="sas-pill sas-pill--success" data-live={account.rollout}><Icon name="check-circle" />{t("golive.live_since", { date: liveSince })}</span>
              )
            ) : account.status === "setting_up" ? (
              <form action={goLiveAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <Button type="submit" variant="primary" icon="rocket" disabled={!result.ready}>{t("golive.button")}</Button>
              </form>
            ) : null}
          </div>
        </div>
        <span className="sas-small">
          {account.status === "paused"
            ? t("golive.paused")
            : result.ready
              ? t("golive.ready", { passed: result.passed, total: result.total })
              : t("golive.progress", { passed: result.passed, total: result.total })}
        </span>
        <SetupSteps basePath={`/app/${account.slug}`} current="go-live" completed={await setupProgress(appDb, account)} />
      </header>
      {sp.live ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("golive.went_live")}</span></div> : null}
      {sp.rollout ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("golive.rollout.saved")}</span></div> : null}
      {err ? (
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t(err === "not_ready" ? "golive.err.not_ready" : err === "rollout" ? "golive.err.rollout" : "golive.err.not_setting_up")}</span>
        </div>
      ) : null}

      <div className="sas-split">
        <section className="sas-panel sas-split__main" aria-labelledby="ck-h" style={{ gap: 0, overflow: "hidden" }}>
          <div className="sas-panel__body sas-stack-2">
            <h2 id="ck-h" className="sas-heading">{t("golive.checklist")}</h2>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={result.total} aria-valuenow={result.passed} aria-label={t("golive.progress_label", { passed: result.passed, total: result.total })}
              style={{ height: 8, borderRadius: 4, background: "var(--surface-sunken)" }}>
              <div style={{ width: `${pct}%`, height: "100%", borderRadius: 4, background: "var(--success)" }} />
            </div>
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {result.checks.map((c) => (
              <li key={c.id} data-check={c.id} data-state={c.state} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", padding: "14px 16px", borderTop: "1px solid var(--line)" }}>
                {c.state === "later" ? (
                  <span aria-hidden="true" style={{ display: "inline-grid", placeItems: "center", width: 28, height: 28, borderRadius: 999, flex: "none", background: "var(--surface-sunken)", color: "var(--ink-muted)" }}>
                    <Icon name="clock" />
                  </span>
                ) : <CheckIcon state={c.state} />}
                <span style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <strong>{t(`golive.check.${c.id}` as MessageKey)}</strong>
                  <span className="sas-sr"> · {c.state === "later" ? t("golive.state.later") : checkStateWord(c.state)}</span>
                  <span className="sas-small" style={{ display: "block" }}>{detail(c)}</span>
                </span>
                {(c.state === "fail" || c.state === "optional") && c.fixPath ? (
                  <a className={buttonClass("secondary", "sm")} href={`${base}${c.fixPath}`}>{t(`golive.fix.${c.id}` as MessageKey)}</a>
                ) : null}
                {c.id === "whatsapp" && typeof c.data.channel === "string" ? (
                  <WhatsAppStatusPill status={c.data.channel as WhatsappStatus} />
                ) : !c.blocking && c.state !== "pass" ? (
                  <span className="sas-pill">{t("golive.not_blocking")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="sas-panel sas-split__side" aria-labelledby="lm-h">
          <form action={saveRolloutAction} className="sas-panel__body sas-stack-4">
            <input type="hidden" name="slug" value={account.slug} />
            <h2 id="lm-h" className="sas-heading">{t("golive.rollout.title")}</h2>
            <fieldset className="sas-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="sas-sr">{t("golive.rollout.title")}</legend>
              {ROLLOUT_MODES.map((m) => (
                <label key={m} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 12, border: `1px solid ${account.rollout === m ? "var(--primary)" : "var(--line)"}`, borderRadius: 8, background: account.rollout === m ? "var(--primary-soft)" : undefined }}>
                  <input type="radio" name="rollout" value={m} defaultChecked={account.rollout === m} style={{ marginTop: 3 }} />
                  <span>
                    <strong>{t(`golive.rollout.${m}` as MessageKey)}</strong>
                    <span className="sas-small" style={{ display: "block" }}>{t(`golive.rollout.${m}.body` as MessageKey)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <span className="sas-small">{t("golive.rollout.note")}</span>
            <div><Button type="submit" variant="secondary" size="sm">{t("golive.rollout.save")}</Button></div>
          </form>
        </section>
      </div>

      <section className="sas-panel" aria-labelledby="mk-h" style={{ gap: 0, overflow: "hidden" }} data-golive-markets>
        <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
          <h2 id="mk-h" className="sas-heading">{t("golive.markets.title")}</h2>
          <span className="sas-small">{t("golive.markets.intro")}</span>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {marketViews.map(({ market, checks }) => {
            const { passed, total } = checkCount(checks);
            return (
              <li key={market.id} data-market={market.id} style={{ padding: "14px 16px", borderTop: "1px solid var(--line)" }} className="sas-stack-2">
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
                  <strong style={{ flex: "1 1 200px", minWidth: 0 }}>
                    {market.name}{market.isHome ? <span className="sas-chip" style={{ marginInlineStart: 8 }}>{t("golive.markets.home")}</span> : null}
                  </strong>
                  <StatusPill object="market" state={market.status} />
                  <span className="sas-small sas-num">{t("golive.markets.checks", { passed, total })}</span>
                  <a className={buttonClass("secondary", "sm")} href={`${base}/markets?m=${market.id}`}>{t("golive.markets.open")}</a>
                </div>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                  {checks.map((c) => (
                    <li key={c.key} data-check={c.key} data-ok={c.ok} className="sas-small" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: c.ok ? "var(--success)" : c.blocking ? "var(--danger)" : "var(--ink-muted)", display: "inline-flex" }}><Icon name={c.ok ? "check" : c.blocking ? "x" : "info"} /></span>
                      {t(`markets.check.${c.key}` as MessageKey)}
                      <span className="sas-sr"> · {checkStateWord(c.ok ? "pass" : c.blocking ? "fail" : "optional")}</span>
                      {c.channel && c.channel !== "connected" ? <WhatsAppStatusPill status={c.channel} /> : null}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
