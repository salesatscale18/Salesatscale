import { Button } from "@/components/sas/primitives";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { appDb } from "@/lib/auth/account";
import { listConnections, listTemplates } from "@/lib/channels/connections";
import { twilioConfig } from "@/lib/channels/twilio";
import { listMarkets } from "@/lib/markets/service";
import { relativeTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import type { SellerAccount } from "@/db/schema";
import { openerStatusOf, whatsappStatus } from "@/lib/channels/rules";
import { WhatsAppStatusPill } from "./whatsapp-status";
import {
  addTemplateAction, addWhatsappNumberAction, refreshTemplatesAction, removeTemplateAction, removeWhatsappNumberAction, setTesterNumbersAction,
  setWhatsappNumberStatusAction,
} from "./actions";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const TEMPLATE_TONE: Record<string, string> = { approved: "sas-pill--success", pending: "sas-pill--warning", rejected: "sas-pill--danger" };
const known = (key: string) => (t(key as MessageKey) as string | undefined) ?? null;

/** Settings › WhatsApp (P6.8): Twilio numbers and message templates. Every action re-checks access on the server. */
export async function WhatsAppSection({ account, sp, baseUrl }: { account: SellerAccount; sp: Record<string, string | string[] | undefined>; baseUrl: string }) {
  const [connections, templates, marketList] = await Promise.all([
    listConnections(appDb, account.id), listTemplates(appDb, account.id), listMarkets(appDb, account.id),
  ]);
  const configured = !!twilioConfig();
  const webhook = `${baseUrl}/api/webhooks/whatsapp`;
  const saved = one(sp.saved);
  const error = one(sp.error);
  const now = new Date();
  const marketName = (id: string | null) => (id ? marketList.find((m) => m.id === id)?.name ?? "-" : t("settings.whatsapp.all_markets"));
  const hidden = <input type="hidden" name="slug" value={account.slug} />;

  return (
    <>
      {saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{known(`settings.whatsapp.saved.${saved}`) ?? t("settings.whatsapp.saved.number")}</span></div> : null}
      {error ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{known(`settings.whatsapp.err.${error}`) ?? t("settings.whatsapp.err.generic")}</span></div> : null}

      <section className="sas-panel sas-panel__body sas-stack-4" aria-labelledby="wa-h">
        <div className="sas-page-head">
          <h2 id="wa-h" className="sas-heading">{t("settings.whatsapp.title")}</h2>
          {/* One WhatsApp status, as Go live and Markets show it; a missing provider is its own warning. */}
          {configured ? (
            <WhatsAppStatusPill status={whatsappStatus({
              numbers: connections.filter((c) => c.status === "active").length,
              opener: openerStatusOf(templates.filter((x) => x.purpose === "opener").map((x) => x.status)),
            })} />
          ) : (
            <span className="sas-pill sas-pill--warning"><Icon name="alert-triangle" />{t("settings.whatsapp.provider_missing")}</span>
          )}
        </div>
        <span className="sas-small">{t(configured ? "settings.whatsapp.intro" : "settings.whatsapp.not_configured")}</span>
        <div className="sas-stack-2">
          <span className="sas-input-label">{t("settings.whatsapp.webhook")}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code className="sas-num" style={{ overflowWrap: "anywhere" }}>{webhook}</code>
            <CopyButton value={webhook} />
          </div>
          <span className="sas-small">{t("settings.whatsapp.webhook_hint")}</span>
        </div>
      </section>

      <section className="sas-panel" aria-labelledby="wa-num-h">
        <div className="sas-panel__body"><h2 id="wa-num-h" className="sas-heading">{t("settings.whatsapp.numbers")}</h2></div>
        {connections.length === 0 ? (
          <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("settings.whatsapp.no_numbers")}</p>
        ) : (
          <ul className="sas-list">
            {connections.map((c) => (
              <li key={c.id} className="sas-list__row" style={{ flexWrap: "wrap", gap: 8 }}>
                <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <strong className="sas-num" dir="ltr">{c.senderNumber}</strong>{c.displayName ? ` · ${c.displayName}` : ""}
                  <span className="sas-small" style={{ display: "block" }}>
                    {marketName(c.marketId)}
                    {" · "}{c.lastInboundAt ? t("settings.whatsapp.last_in", { when: relativeTime(c.lastInboundAt, now) }) : t("settings.whatsapp.never_in")}
                    {c.lastOutboundAt ? ` · ${t("settings.whatsapp.last_out", { when: relativeTime(c.lastOutboundAt, now) })}` : ""}
                  </span>
                  {c.lastError ? <span className="sas-small" style={{ display: "block", color: "var(--danger)" }}>{t("settings.whatsapp.last_error", { error: c.lastError })}</span> : null}
                </span>
                <span className={`sas-pill ${c.status === "active" ? "sas-pill--success" : ""}`}>{t(`settings.whatsapp.status.${c.status}`)}</span>
                <form action={setTesterNumbersAction} style={{ flexBasis: "100%", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  {hidden}
                  <input type="hidden" name="connectionId" value={c.id} />
                  <div className="sas-input-group" style={{ flex: "1 1 260px" }}>
                    <label className="sas-input-label" htmlFor={`wa-testers-${c.id}`}>{t("settings.whatsapp.testers")}</label>
                    <input
                      className="sas-input sas-num" id={`wa-testers-${c.id}`} name="testers" dir="ltr" defaultValue={c.testerNumbers.join(", ")}
                      placeholder="+972501234567, +14155550100" aria-describedby={`wa-testers-hint-${c.id}`} maxLength={400}
                    />
                    <span id={`wa-testers-hint-${c.id}`} className="sas-small">{t("settings.whatsapp.testers_hint")}</span>
                  </div>
                  <Button type="submit" size="sm">{t("settings.whatsapp.testers_save")}</Button>
                </form>
                <form action={setWhatsappNumberStatusAction}>
                  {hidden}
                  <input type="hidden" name="connectionId" value={c.id} />
                  <input type="hidden" name="status" value={c.status === "active" ? "disabled" : "active"} />
                  <Button type="submit" size="sm">{t(c.status === "active" ? "settings.whatsapp.disable" : "settings.whatsapp.enable")}</Button>
                </form>
                <form action={removeWhatsappNumberAction}>
                  {hidden}
                  <input type="hidden" name="connectionId" value={c.id} />
                  <Button type="submit" size="sm" variant="danger">{t("settings.whatsapp.remove")}</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addWhatsappNumberAction} className="sas-panel__body sas-stack-2" style={{ borderBlockStart: "1px solid var(--line)" }}>
          {hidden}
          <h3 className="sas-label" style={{ margin: 0 }}>{t("settings.whatsapp.add_number")}</h3>
          <label className="sas-input-label" htmlFor="wa-sender">{t("settings.whatsapp.sender")}</label>
          <input className="sas-input sas-num" id="wa-sender" name="senderNumber" required placeholder="+14155238886" dir="ltr" inputMode="tel" maxLength={20} />
          <label className="sas-input-label" htmlFor="wa-name">{t("settings.whatsapp.display_name")}</label>
          <input className="sas-input" id="wa-name" name="displayName" maxLength={100} />
          <label className="sas-input-label" htmlFor="wa-mg">{t("settings.whatsapp.service_sid")}</label>
          <input className="sas-input sas-num" id="wa-mg" name="messagingServiceSid" placeholder="MG…" dir="ltr" maxLength={34} aria-describedby="wa-mg-hint" />
          <span id="wa-mg-hint" className="sas-small">{t("settings.whatsapp.service_sid_hint")}</span>
          {marketList.length > 1 ? (
            <>
              <label className="sas-input-label" htmlFor="wa-market">{t("settings.whatsapp.market")}</label>
              <select className="sas-select" id="wa-market" name="marketId" defaultValue="">
                <option value="">{t("settings.whatsapp.all_markets")}</option>
                {marketList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </>
          ) : null}
          <div><Button type="submit" variant="primary" size="sm">{t("settings.whatsapp.add_number_button")}</Button></div>
        </form>
      </section>

      <section className="sas-panel" aria-labelledby="wa-tpl-h">
        <div className="sas-panel__body sas-page-head">
          <h2 id="wa-tpl-h" className="sas-heading">{t("settings.whatsapp.templates")}</h2>
          {templates.length > 0 && configured ? (
            <form action={refreshTemplatesAction} className="sas-page-head__actions">
              {hidden}
              <Button type="submit" size="sm"><Icon name="clock" />{t("settings.whatsapp.refresh")}</Button>
            </form>
          ) : null}
        </div>
        <p className="sas-small" style={{ margin: 0, padding: "0 16px 12px" }}>{t("settings.whatsapp.templates_hint")}</p>
        {templates.length === 0 ? (
          <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{t("settings.whatsapp.no_templates")}</p>
        ) : (
          <ul className="sas-list">
            {templates.map((tpl) => (
              <li key={tpl.id} className="sas-list__row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
                <span style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <strong>{tpl.name}</strong>
                  <span className="sas-small"> · {t(`settings.whatsapp.purpose.${tpl.purpose}`)} · {tpl.language.toUpperCase()}{tpl.category ? ` · ${tpl.category}` : ""}</span>
                  <span className="sas-small" style={{ display: "block", whiteSpace: "pre-wrap" }} dir="auto">{tpl.body}</span>
                  {tpl.rejectionReason ? <span className="sas-small" style={{ display: "block", color: "var(--danger)" }}>{tpl.rejectionReason}</span> : null}
                </span>
                <span className={`sas-pill ${TEMPLATE_TONE[tpl.status] ?? ""}`}>{t(`settings.whatsapp.template.${tpl.status}`)}</span>
                <form action={removeTemplateAction}>
                  {hidden}
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <Button type="submit" size="sm" variant="danger">{t("settings.whatsapp.remove")}</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addTemplateAction} className="sas-panel__body sas-stack-2" style={{ borderBlockStart: "1px solid var(--line)" }}>
          {hidden}
          <h3 className="sas-label" style={{ margin: 0 }}>{t("settings.whatsapp.add_template")}</h3>
          <label className="sas-input-label" htmlFor="wa-hx">{t("settings.whatsapp.content_sid")}</label>
          <input className="sas-input sas-num" id="wa-hx" name="contentSid" required placeholder="HX…" dir="ltr" maxLength={34} />
          <label className="sas-input-label" htmlFor="wa-purpose">{t("settings.whatsapp.purpose")}</label>
          <select className="sas-select" id="wa-purpose" name="purpose" defaultValue="opener">
            <option value="opener">{t("settings.whatsapp.purpose.opener")}</option>
            <option value="follow_up">{t("settings.whatsapp.purpose.follow_up")}</option>
          </select>
          <div><Button type="submit" variant="primary" size="sm" disabled={!configured}>{t("settings.whatsapp.add_template_button")}</Button></div>
        </form>
      </section>
    </>
  );
}
