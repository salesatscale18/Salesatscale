import { Button, StatusPill, buttonClass, Chip } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { formatMoney } from "@/lib/domain/money";
import { exactTime, relativeTime } from "@/lib/format";
import { countAwaitingApproval, countQuotes, displayQuoteStatus, getQuote, listQuotes, type QuoteTab } from "@/lib/quotes/service";
import { catalogVersions, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { t } from "@/lib/i18n";
import { approveQuoteAction, cancelQuoteAction } from "./actions";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateShort = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Quotes and orders (P3.5, canvas: Orders). The order form and payment columns fill in P5. */
export default async function OrdersPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  const base = `/app/${account.slug}/orders`;
  const tabRaw = one(sp.tab);
  const tab: QuoteTab | "orders" = tabRaw === "approval" ? "approval" : tabRaw === "orders" ? "orders" : "quotes";
  const [rows, total, awaiting] = await Promise.all([
    tab === "orders" ? Promise.resolve([]) : listQuotes(appDb, account.id, tab),
    countQuotes(appDb, account.id),
    countAwaitingApproval(appDb, account.id),
  ]);
  const quoteId = one(sp.quote);
  const detail = UUID.test(quoteId) ? await getQuote(appDb, account.id, quoteId) : null;
  const now = new Date();
  const money = (m: number, recurring = false) => formatMoney(m, account.currency, recurring ? { period: "month" } : {});
  const tabHref = (x: string) => (x === "quotes" ? base : `${base}?tab=${x}`);

  const cur = detail?.versions[0];
  const incomplete = !!cur?.lines.some((l) => l.unitPriceMinor === null);
  const nameOf = async (id: string | null) => {
    if (!id) return null;
    const [u] = await appDb.select().from(users).where(eq(users.id, id));
    return u ? displayName(u) : null;
  };
  const approver = await nameOf(cur?.version.approvedByUserId ?? null);
  const creator =
    cur?.version.createdByActor === "human"
      ? (await nameOf(cur.version.createdByUserId)) ?? "a person"
      : cur
        ? t(`orders.detail.created_by.${cur.version.createdByActor as "agent" | "system"}`)
        : "";
  const [catalogVersion] = cur ? await appDb.select().from(catalogVersions).where(eq(catalogVersions.id, cur.version.catalogVersionId)) : [];

  return (
    <div className={detail ? "sas-with-panel" : undefined}>
      <main className="sas-shell__content">
        <header className="sas-stack-2">
          <h1 className="sas-title">{t("orders.title")}</h1>
          <nav aria-label={t("orders.tabs")} className="sas-tabs">
            <a className="sas-tab" href={tabHref("quotes")} aria-current={tab === "quotes" ? "page" : undefined}>{t("orders.tab.quotes")} <span className="sas-num">{total}</span></a>
            <a className="sas-tab" href={tabHref("orders")} aria-current={tab === "orders" ? "page" : undefined}>{t("orders.tab.orders")} <span className="sas-num">0</span></a>
            <a className="sas-tab" href={tabHref("approval")} aria-current={tab === "approval" ? "page" : undefined}>
              {t("orders.tab.approval")} {awaiting ? <span className="sas-pill sas-pill--warning" style={{ height: 20 }}>{awaiting}</span> : <span className="sas-num">0</span>}
            </a>
          </nav>
        </header>

        {tab === "orders" ? (
          <section className="sas-panel sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
            <span className="sas-small">{t("orders.orders_soon")}</span>
          </section>
        ) : rows.length === 0 ? (
          <section className="sas-panel sas-empty">
            <span className="sas-empty__icon sas-empty__icon--start"><Icon name="file-text" /></span>
            <strong>{tab === "approval" ? t("orders.empty.approval") : t("orders.empty.title")}</strong>
            {tab === "quotes" ? <span className="sas-small">{t("orders.empty.body")}</span> : null}
            {tab === "quotes" ? <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads`}>{t("orders.empty.go_leads")}</a> : null}
          </section>
        ) : (
          <section className="sas-panel" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="sas-table" style={{ minWidth: 720 }}>
                <thead><tr>
                  <th scope="col">{t("orders.col.quote")}</th><th scope="col">{t("orders.col.lead")}</th>
                  <th scope="col" style={{ textAlign: "end" }}>{t("orders.col.one_time")}</th><th scope="col" style={{ textAlign: "end" }}>{t("orders.col.monthly")}</th>
                  <th scope="col">{t("orders.col.quote")}</th><th scope="col">{t("orders.col.form")}</th><th scope="col">{t("orders.col.payment")}</th>
                </tr></thead>
                <tbody>
                  {rows.map(({ quote, version, lead }) => {
                    const toPrice = version.approvalReasons.some((r) => r.kind === "price_missing") && !version.approvedByUserId;
                    return (
                      <tr key={quote.id} className={quote.id === quoteId ? "sas-row--selected" : undefined}>
                        <td><a className="sas-num" href={`${base}?${tab === "quotes" ? "" : `tab=${tab}&`}quote=${quote.id}`}>Q-{quote.number} v{quote.currentVersion}</a></td>
                        <td>{lead.company ?? lead.fullName}</td>
                        <td className="sas-num" style={{ textAlign: "end" }}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : money(version.oneTimeTotalMinor)}</td>
                        <td className="sas-num" style={{ textAlign: "end" }}>{toPrice ? <span className="sas-small">{t("quote.to_price")}</span> : version.recurringTotalMinor ? money(version.recurringTotalMinor) : "—"}</td>
                        <td><StatusPill object="quote" state={displayQuoteStatus(quote.status, version.validUntil, now)} /></td>
                        <td className="sas-small">—</td>
                        <td className="sas-small">—</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {detail && cur ? (
        <aside className="sas-side-panel" aria-labelledby="q-h">
          <div className="sas-page-head">
            <div className="sas-stack-2" style={{ gap: 4, flex: 1 }}>
              <span className="sas-small sas-num">{t("orders.detail.valid", { number: detail.quote.number, version: cur.version.version, date: dateShort.format(cur.version.validUntil) })}</span>
              <h2 id="q-h" className="sas-title">{detail.lead.company ?? detail.lead.fullName}</h2>
              <span className="sas-small">{t("orders.detail.created", { who: creator, catalog: catalogVersion?.version ?? "?" })}</span>
            </div>
            <a className={buttonClass("ghost", "sm")} href={tab === "quotes" ? base : `${base}?tab=${tab}`} aria-label={t("lead.form.close")}><Icon name="x" /></a>
          </div>
          <StatusPill object="quote" state={displayQuoteStatus(detail.quote.status, cur.version.validUntil, now)} />
          {sp.approved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("orders.detail.approved_ok")}</span></div> : null}
          {sp.approve ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("orders.detail.approve_failed")}</span></div> : null}

          <section className="sas-stack-2" aria-labelledby="items-h">
            <h3 id="items-h" className="sas-heading">{t("orders.detail.items")}</h3>
            <dl className="sas-kv">
              {cur.lines.map((l) => (
                <div key={l.id} style={{ display: "contents" }}>
                  <dt style={{ color: "var(--ink)" }}>{l.qty} × {l.name} <Chip>{l.sku}</Chip><div className="sas-small">{t(`quote.price_source.${l.priceSource as "list" | "tier" | "custom"}`)}</div></dt>
                  <dd className="sas-num">{l.lineTotalMinor === null ? t("quote.to_price") : money(l.lineTotalMinor, l.chargeType === "recurring")}</dd>
                </div>
              ))}
              <dt>{t("quote.discount")}</dt><dd className="sas-num">{(cur.version.discountBp / 100).toFixed(1)}%</dd>
              <dt className="sas-kv__total">{t("quote.one_time_total")}</dt><dd className="sas-num sas-kv__total">{incomplete ? t("quote.to_price") : money(cur.version.oneTimeTotalMinor)}</dd>
              {cur.version.recurringTotalMinor || incomplete ? <><dt className="sas-kv__total">{t("quote.monthly_total")}</dt><dd className="sas-num sas-kv__total">{incomplete ? t("quote.to_price") : money(cur.version.recurringTotalMinor, true)}</dd></> : null}
            </dl>
            {incomplete ? null : <span className="sas-small">{t(cur.version.pricesIncludeTax ? "quote.incl_tax" : "quote.plus_tax", { tax: money(cur.version.oneTimeTaxMinor) })}</span>}
          </section>

          {detail.quote.status === "awaiting_approval" ? (
            <form action={approveQuoteAction} className="sas-alert sas-alert--warning sas-stack-2" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <input type="hidden" name="slug" value={account.slug} />
              <input type="hidden" name="quoteId" value={detail.quote.id} />
              <strong>{t("orders.detail.approval")}</strong>
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>{cur.version.approvalReasons.map((r, i) => <li key={i} className="sas-small" style={{ color: "var(--ink)" }}>{approvalReasonText(r)}</li>)}</ul>
              {cur.lines.filter((l) => l.unitPriceMinor === null || cur.version.approvalReasons.some((r) => r.kind === "custom_pricing_qty" && r.sku === l.sku)).map((l) => (
                <div key={l.id} className="sas-input-group">
                  <label className="sas-input-label" htmlFor={`p-${l.sku}`}>{t("orders.detail.price_for", { sku: l.sku, currency: account.currency })}</label>
                  <input className="sas-input sas-num" id={`p-${l.sku}`} name={`price:${l.sku}`} inputMode="decimal" placeholder={l.unitPriceMinor === null ? "" : (l.unitPriceMinor / 100).toFixed(2)} required={l.unitPriceMinor === null} />
                </div>
              ))}
              <div><Button type="submit" variant="primary" size="sm">{t("orders.detail.approve")}</Button></div>
            </form>
          ) : approver && cur.version.approvedAt ? (
            <span className="sas-small">
              {t("orders.detail.approved", { who: approver, when: relativeTime(cur.version.approvedAt, now) })}
              {cur.version.approvalReasons.length ? `: ${cur.version.approvalReasons.map(approvalReasonText).join("; ")}` : ""}
            </span>
          ) : null}

          <section className="sas-stack-2" aria-labelledby="ver-h">
            <h3 id="ver-h" className="sas-heading">{t("orders.detail.versions")}</h3>
            {detail.versions.map(({ version }, i) => (
              <span key={version.id} className={i === 0 ? "sas-small" : "sas-small"} style={{ color: i === 0 ? "var(--ink)" : undefined }} title={exactTime(version.createdAt)}>
                <span className="sas-num">v{version.version}</span> · {relativeTime(version.createdAt, now)}{version.changeNote ? ` · ${version.changeNote}` : ""}{i > 0 ? ` · ${t("orders.detail.replaced")}` : ""}
              </span>
            ))}
          </section>
          <section className="sas-stack-2"><h3 className="sas-heading">{t("orders.detail.form")}</h3><span className="sas-small">{t("orders.detail.form_soon")}</span></section>
          <section className="sas-stack-2"><h3 className="sas-heading">{t("orders.detail.payment")}</h3><span className="sas-small">{t("orders.detail.payment_soon")}</span></section>

          {detail.quote.status !== "cancelled" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <a className={buttonClass("secondary", "sm")} href={`/app/${account.slug}/leads/${detail.quote.leadId}/quote?from=${detail.quote.id}`}>{t("orders.detail.new_version")}</a>
              <form action={cancelQuoteAction}>
                <input type="hidden" name="slug" value={account.slug} />
                <input type="hidden" name="quoteId" value={detail.quote.id} />
                <Button type="submit" variant="danger" size="sm">{t("orders.detail.cancel")}</Button>
              </form>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
