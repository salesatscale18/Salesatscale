import type { Metadata } from "next";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import { sellerAccounts, type OrderSnapshot } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { formatMoney } from "@/lib/domain/money";
import { dir, isLocale, translator, type Locale } from "@/lib/i18n";
import { attemptCount, lastAttempt, loadForm, markOpened, orderLabel, priceCheck, signatureFor, snapshotOf, type FormSnapshot } from "@/lib/orders/service";
import { fakePaymentsEnabled } from "@/lib/payments/mode";
import { acceptPriceAction, payBankAction, payCardAction } from "./actions";
import { chargeLabel, moneyFor, OrderLines } from "./lines";
import { SignForm } from "./sign-form";
import "./buyer.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order form", robots: { index: false, follow: false } };

type Tr = ReturnType<typeof translator>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function Check({ color = "currentColor", size = 18 }: { color?: string; size?: number }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size, fill: "none", stroke: color, strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round", flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>;
}
function Lock() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 2.4 }}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
}
function Alert({ color }: { color: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 22, height: 22, flex: "none", fill: "none", stroke: color, strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
}

function Shell(props: { lang: Locale; token: string; brand: string; seller: string; sub?: string; children: ReactNode; switcher?: boolean }) {
  const tr = translator(props.lang);
  const initials = props.seller.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="b-root" lang={props.lang} dir={dir(props.lang)} style={{ ["--brand" as string]: props.brand }}>
      <div className="b-page">
        {fakePaymentsEnabled() ? <div className="b-strip" role="note">{tr("buyer.test_strip")}</div> : null}
        <header className="b-head">
          <span className="b-logo" aria-hidden="true">{initials}</span>
          <span className="b-head__name"><b style={{ fontSize: 16 }}>{props.seller}</b>{props.sub ? <span className="b-mut">{props.sub}</span> : null}</span>
          {props.switcher !== false ? (
            <nav className="b-lang" aria-label={tr("buyer.language")}>
              <a href={`/f/${props.token}?lang=en`} lang="en" aria-current={props.lang === "en" ? "true" : undefined}>EN</a>
              <a href={`/f/${props.token}?lang=he`} lang="he" aria-current={props.lang === "he" ? "true" : undefined}>עב</a>
            </nav>
          ) : null}
        </header>
        <main style={{ display: "flex", flexDirection: "column", flex: 1 }}>{props.children}</main>
        <footer className="b-foot"><Lock />{tr("buyer.secured_by")}</footer>
      </div>
    </div>
  );
}

function money(s: Pick<OrderSnapshot, "currency">, minor: number) {
  return formatMoney(minor, s.currency);
}

function Lines({ s, tr, lang }: { s: OrderSnapshot; tr: Tr; lang: Locale }) {
  return <OrderLines s={s as FormSnapshot} tr={tr} lang={lang} />;
}

/** Buyer order form (P5.4). Public: the signed link is the credential. */
export default async function BuyerFormPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const view = await loadForm(appDb, token);
  const asked = one(sp.lang);
  if (!view) {
    const lang: Locale = isLocale(asked) ? asked : "en";
    const tr = translator(lang);
    return (
      <Shell lang={lang} token={token} brand="#566073" seller="Sales at Scale" switcher={false}>
        <div className="b-center"><h1 className="b-h1">{tr("buyer.not_found")}</h1><span className="b-mut">{tr("buyer.not_found_body")}</span></div>
      </Shell>
    );
  }
  const { form } = view;
  const s = snapshotOf(form);
  const lang: Locale = isLocale(asked) ? asked : isLocale(form.language) ? form.language : "en";
  const tr = translator(lang);
  const per = moneyFor(s, tr);
  // Recurring total period: older snapshots have none (monthly).
  const period = s.recurringPeriod === "year" ? "year" as const : "month" as const;
  // One parallel step after loadForm: the account, and for an open form the first-view mark and the price check.
  const isOpen = view.state === "open";
  const [[account], , priced] = await Promise.all([
    appDb.select().from(sellerAccounts).where(eq(sellerAccounts.id, form.accountId)),
    isOpen ? markOpened(appDb, form) : null,
    isOpen ? priceCheck(appDb, form) : null,
  ]);
  // A paused account takes no signatures or payments: show "unavailable".
  const paused = account.status === "paused";
  const date = (d: Date | string) => new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: account.timezone }).format(new Date(d));
  const time = (d: Date) => new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: account.timezone }).format(d);
  const shell = (sub: string | undefined, children: ReactNode) => (
    <Shell lang={lang} token={token} brand={s.seller.brandColor} seller={s.seller.tradeName} sub={sub}>{children}</Shell>
  );
  const quoteRef = `Q-${s.quote.number} v${s.quote.version}`;
  // Older snapshots have no supportContact: show nothing then.
  const support = (center: boolean) => s.supportContact ? <span className="b-mut" style={{ display: "block", ...(center ? { textAlign: "center" as const } : {}) }}><bdi>{s.supportContact}</bdi></span> : null;
  const hidden = <><input type="hidden" name="token" value={token} /><input type="hidden" name="lang" value={lang} /></>;

  // Offer updated / expired (canvas: BuyerExpired).
  if (view.state === "updated" || view.state === "expired") {
    const n = view.state === "updated" ? view.newer : null;
    return shell(`${tr("buyer.order_form")} · ${quoteRef}`, (
      <>
        <div className="b-center">
          <span className="b-badge" style={{ background: "var(--warn-soft)" }}><svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 28, height: 28, fill: "none", stroke: "var(--warn)", strokeWidth: 2.2 }}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg></span>
          <h1 className="b-h1">{view.state === "updated" ? tr("buyer.updated_title") : tr("buyer.expired_title")}</h1>
          <span className="b-mut" style={{ fontSize: 14, lineHeight: "22px" }}>{view.state === "updated" ? (n ? tr("buyer.updated_body") : tr("buyer.updated_no_link")) : tr("buyer.expired_body")}</span>
        </div>
        {n ? (
          <div style={{ margin: "0 20px", padding: 16, border: "1px solid var(--line)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="b-mut">{tr("buyer.new_offer")} · <span className="b-num">Q-{n.snapshot.quote.number} v{n.snapshot.quote.version}</span></span>
            <Lines s={n.snapshot} tr={tr} lang={lang} />
            {view.state === "updated" && view.changeNote ? <span className="b-mut">{tr("buyer.what_changed", { note: view.changeNote })}</span> : null}
          </div>
        ) : null}
        <div style={{ marginTop: "auto", padding: "16px 20px" }} className="b-noprint">
          {n ? <a className="b-btn" href={`/f/${n.token}?lang=${lang}`}>{tr("buyer.view_new")}</a> : <><span className="b-mut">{tr("buyer.questions")}</span>{support(false)}</>}
        </div>
      </>
    ));
  }

  // Signed: payment, bank transfer, failed or paid (canvas: BuyerPay, BuyerPayFailed, BuyerPaid).
  if (view.state === "signed") {
    const { order } = view;
    const isFailed = order.paymentStatus === "failed";
    const [sig, attempt, tries] = await Promise.all([
      signatureFor(appDb, form.id),
      order.paymentStatus === "paid" || isFailed ? lastAttempt(appDb, order.id) : null,
      isFailed ? attemptCount(appDb, order.id) : 0,
    ]);
    const label = orderLabel(s.seller.tradeName, order.number);
    const err = paused ? "unavailable" : one(sp.err);
    if (order.paymentStatus === "paid") {
      return shell(undefined, (
        <>
          <div className="b-center" style={{ background: "var(--ok-soft)" }}>
            <span className="b-badge" style={{ background: "var(--brand)" }}><Check color="#fff" size={28} /></span>
            <h1 className="b-h1">{tr("buyer.paid_title")}</h1>
            <span className="b-mut">{tr("buyer.paid_body", { name: (sig?.fullName ?? "").split(" ")[0], order: label })}</span>
          </div>
          <section className="b-sec">
            <Lines s={s} tr={tr} lang={lang} />
            <div className="b-row" style={{ fontWeight: 700 }}><span>{tr("buyer.paid_today")}{attempt ? ` · ${tr("buyer.card")}` : ` · ${tr("buyer.bank")}`}</span><span className="b-num">{money(s, order.amountDueMinor)}</span></div>
          </section>
          <section className="b-sec b-noprint">
            <a className="b-btn b-btn--2" href={`/f/${token}/document?lang=${lang}`}>{tr("buyer.signed_form")}</a>
            <span className="b-mut" style={{ textAlign: "center" }}>{tr("buyer.invoice_by", { seller: s.seller.tradeName })}</span>
            <span className="b-mut" style={{ textAlign: "center" }}>{tr("buyer.questions")}</span>
            {support(true)}
          </section>
        </>
      ));
    }
    // Card needs a provider: today only the test provider exists (off when PAYMENTS_MODE=live).
    const cardOn = s.paymentMethods.card && fakePaymentsEnabled();
    const method = order.paymentStatus === "bank_transfer_expected" ? "bank" : one(sp.pay) === "bank" && s.paymentMethods.bankTransfer ? "bank" : cardOn ? "card" : "bank";
    const failed = isFailed ? attempt : null;
    return shell(tr("buyer.step_pay"), (
      <>
        <section className="b-sec">
          <div className="b-note b-note--ok" style={{ padding: "10px 12px", alignItems: "center" }}><Check color="var(--brand)" />{failed ? tr("buyer.order_saved") : tr("buyer.signed_by", { name: sig?.fullName ?? "", time: sig ? time(sig.signedAt) : "" })}</div>
          {failed ? (
          <div className="b-note b-note--danger" role="alert" style={{ margin: 0 }}>
            <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 22, height: 22, flex: "none", fill: "none", stroke: "var(--danger)", strokeWidth: 2.2 }}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
            <span style={{ display: "flex", flexDirection: "column", gap: 4 }}><b>{tr("buyer.failed_title")}</b><span style={{ fontSize: 14 }}>{tr("buyer.failed_body")}</span><span className="b-mut">{tr("buyer.attempt", { count: tries })} · {tr("buyer.reason", { reason: failed.failureReason ?? "" })}</span></span>
          </div>
        ) : null}
          <div className="b-row" style={{ fontWeight: 700 }}><span>{tr("buyer.due_today")}</span><span className="b-num" style={{ fontSize: 16 }}>{money(s, order.amountDueMinor)}</span></div>
          {order.recurringMinor > 0 ? <div className="b-row"><span>{tr(period === "year" ? "buyer.then_yearly" : "buyer.then_monthly")}</span><span className="b-num">{per(order.recurringMinor, period)}</span></div> : null}
          {err ? <span className="b-err" role="alert">{err === "recurring_consent" ? tr("buyer.err.required") : tr("buyer.unavailable")}</span> : null}
          {paused && order.paymentStatus !== "bank_transfer_expected" ? null : cardOn && s.paymentMethods.bankTransfer && order.paymentStatus !== "bank_transfer_expected" ? (
            <nav className="b-tabs" aria-label={tr("buyer.method")}>
              <a href={`/f/${token}?lang=${lang}`} aria-current={method === "card" ? "true" : undefined}>{tr("buyer.card")}</a>
              <a href={`/f/${token}?lang=${lang}&pay=bank`} aria-current={method === "bank" ? "true" : undefined}>{tr("buyer.bank")}</a>
            </nav>
          ) : null}
          {paused && order.paymentStatus !== "bank_transfer_expected" ? null : method === "card" ? (
            <form action={payCardAction} className="b-stack" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {hidden}
              <div className="b-testbox"><span className="b-mut" style={{ display: "flex", gap: 6, alignItems: "center" }}><Lock />{tr("buyer.card_test_box")}</span></div>
              {order.recurringMinor > 0 ? (
                <label className="b-check"><input type="checkbox" name="recurring" defaultChecked /><span>{tr(period === "year" ? "buyer.recurring_consent_year" : "buyer.recurring_consent", { price: money(s, order.recurringMinor) })}</span></label>
              ) : null}
              <button type="submit" name="outcome" value="succeeded" className="b-btn">{tr("buyer.simulate_ok")}</button>
              <button type="submit" name="outcome" value="failed" className="b-btn b-btn--2">{tr("buyer.simulate_fail")}</button>
              <span className="b-mut" style={{ textAlign: "center" }}>{tr("buyer.invoice_by", { seller: s.seller.tradeName })}</span>
            </form>
          ) : order.paymentStatus === "bank_transfer_expected" ? (
            <div className="b-note b-note--warn" style={{ flexDirection: "column", gap: 6 }}>
              <b>{tr("buyer.bank_waiting")}</b>
              <span style={{ fontSize: 14 }}>{tr("buyer.bank_body", { amount: money(s, order.amountDueMinor), ref: label })}</span>
              {s.bankDetails ? <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit", fontSize: 14 }}>{s.bankDetails}</pre> : null}
            </div>
          ) : (
            <form action={payBankAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {hidden}
              <b>{tr("buyer.bank_title")}</b>
              <span style={{ fontSize: 14 }}>{tr("buyer.bank_body", { amount: money(s, order.amountDueMinor), ref: label })}</span>
              {s.bankDetails ? <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit", fontSize: 14 }}>{s.bankDetails}</pre> : null}
              <button type="submit" className="b-btn">{tr("buyer.bank_choose")}</button>
            </form>
          )}
        </section>
        <section className="b-sec b-noprint"><a className="b-btn b-btn--2" href={`/f/${token}/document?lang=${lang}`}>{tr("buyer.signed_form")}</a></section>
      </>
    ));
  }

  // Open: check the price again, then review and sign (canvas: BuyerOrder, BuyerPriceChanged).
  const check = paused || !priced ? { status: "unavailable" as const } : priced;
  const notice = one(sp.notice);
  if (check.status === "changed") {
    return shell(`${tr("buyer.order_form")} · Q-${s.quote.number}`, (
      <>
        <div className="b-note b-note--warn" style={{ margin: 20 }}>
          <Alert color="var(--warn)" />
          <span style={{ display: "flex", flexDirection: "column", gap: 4 }}><b>{tr("buyer.price_title")}</b><span style={{ fontSize: 14 }}>{tr("buyer.price_body")}</span></span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 20px 20px" }}>
          <div className="b-grid3 b-mut" style={{ fontSize: 12 }}><span /><span>{tr("buyer.before")}</span><span>{tr("buyer.now")}</span></div>
          {/* Per line and charge: one-time lines and the amount due today first, then recurring lines and their total (canvas: BuyerPriceChanged). */}
          {(["one_time", "recurring"] as const).map((charge) => {
            const rows = check.lines.filter((l) => l.charge === charge);
            if (rows.length === 0) return null;
            const p = charge === "recurring" ? (check.recurringPeriod ?? period) : null;
            const before = charge === "one_time" ? s.oneTime.totalMinor : s.recurring.totalMinor;
            const now = charge === "one_time" ? check.oneTimeMinor : check.recurringMinor;
            return (
              <div key={charge} style={{ display: "contents" }}>
                {rows.map((l) => (
                  <div key={`${l.sku}-${l.charge}`} className="b-grid3" data-charge={l.charge}>
                    <span><bdi>{l.qty} × {l.name}</bdi><span className="b-mut" style={{ display: "block" }}>{chargeLabel(tr, l.charge, l.period)}</span></span>
                    <span className={`b-num ${l.beforeMinor !== l.nowMinor ? "b-old" : "b-mut"}`}>{money(s, l.beforeMinor)}</span>
                    <span className="b-num" style={{ fontWeight: l.beforeMinor !== l.nowMinor ? 700 : 400 }}>{per(l.nowMinor, l.charge === "recurring" ? l.period ?? period : null)}</span>
                  </div>
                ))}
                <div className="b-grid3" style={{ paddingTop: 10, borderTop: "1px solid var(--line)", fontWeight: 700 }}>
                  <span>{charge === "one_time" ? tr("buyer.due_today") : tr(p === "year" ? "buyer.recurring_total.year" : "buyer.recurring_total.month")}</span>
                  <span className={`b-num ${before !== now ? "b-old" : "b-mut"}`} style={{ fontWeight: 400 }}>{money(s, before)}</span>
                  <span className="b-num">{per(now, p)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <form action={acceptPriceAction} style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "16px 20px" }}>
          {hidden}
          {notice === "needs_approval" ? <span className="b-err" role="alert">{tr("buyer.needs_team")}</span> : null}
          <button type="submit" className="b-btn">{tr("buyer.accept_new")}</button>
          <span className="b-mut" style={{ textAlign: "center" }}>{tr("buyer.accept_note")}</span>
        </form>
      </>
    ));
  }
  return shell(`${tr("buyer.order_form")} · ${quoteRef}`, (
    <>
      <div className="b-sec b-hero">
        <h1 className="b-h1">{tr("buyer.hi", { name: (s.prefill.signatory_name ?? "").split(" ")[0] })}</h1>
        <span className="b-mut">{tr("buyer.prepared", { date: date(s.validUntil) })}</span>
      </div>
      {check.status === "unavailable" ? <div className="b-note b-note--warn" role="alert" style={{ margin: 20 }}><Alert color="var(--warn)" /><span>{tr("buyer.unavailable")}</span></div> : null}
      <section className="b-sec" aria-labelledby="it-h">
        <h2 id="it-h" className="b-h2">{tr("buyer.ordering")}</h2>
        <Lines s={s} tr={tr} lang={lang} />
        <span className="b-mut">{tr("buyer.change_hint")}</span>
      </section>
      <section className="b-sec b-terms" aria-labelledby="tm-h" style={{ gap: 0 }}>
        <h2 id="tm-h" className="b-h2" style={{ paddingBottom: 8 }}>{tr("buyer.terms")}</h2>
        {s.legal.map((l) => (
          <details key={l.key}>
            <summary><span>{l.title} <span className="b-mut">{tr("buyer.version", { version: l.version })}</span></span><span aria-hidden="true">›</span></summary>
            <pre>{l.body}</pre>
          </details>
        ))}
      </section>
      {check.status === "same" ? (
        <SignForm token={token} lang={lang} fields={s.fields} prefill={s.prefill as Record<string, string>} company={s.prefill.company_name ?? ""} />
      ) : null}
    </>
  ));
}
