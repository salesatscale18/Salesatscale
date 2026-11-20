/**
 * The no-cost voice harness, order form side (the voice bubble, step 2): a stand-in for the order form page
 * (app/f/[token]/page.tsx is a server component with server actions, so it cannot be bundled here) with its
 * styles and the REAL form bubble (app/f/[token]/voice-bubble.tsx). Each step is a page load, as on the real
 * form (?step=order|company|sign|pay), so the bubble's tab link reconnects on every step like it will there.
 */
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { FormVoiceBubble } from "@/app/f/[token]/voice-bubble";
import { translator, type MessageKey } from "@/lib/i18n";

type Config = { lang: "en" | "he"; tabKey: string; agentName: string; seller: string; rootStyle: CSSProperties };

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "he" ? "he" : "en";
const STEPS = ["order", "company", "sign", "pay"] as const;
const step = (STEPS as readonly string[]).includes(q.get("step") ?? "") ? (q.get("step") as (typeof STEPS)[number]) : "order";
const LABEL: Record<(typeof STEPS)[number], MessageKey> = { order: "buyer.steps.order", company: "buyer.steps.company", sign: "buyer.steps.sign", pay: "buyer.step_pay" };

function Page({ c }: { c: Config }) {
  const tr = translator(c.lang);
  const n = STEPS.indexOf(step);
  const next = STEPS[Math.min(n + 1, STEPS.length - 1)];
  const href = (s: string) => `/form?lang=${c.lang}&step=${s}`;
  return (
    <div className="b-root" lang={c.lang} dir={c.lang === "he" ? "rtl" : "ltr"} style={c.rootStyle}>
      <div className="b-page b-page--wide">
        <header className="b-head">
          <span className="b-logo" aria-hidden="true">{c.seller.slice(0, 2).toUpperCase()}</span>
          <span className="b-head__name"><b style={{ fontSize: 16 }}><bdi>{c.seller}</bdi></b><span className="b-mut">{tr("buyer.order_form")} · Q-1001</span></span>
        </header>
        <main style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div className="b-main" data-order-step={step}>
            {step === "pay" ? null : (
              <nav className="b-prog" aria-label={tr("buyer.steps.label")}>
                <span className="b-mut" style={{ fontWeight: 600 }}>{tr("buyer.steps.of", { step: n + 1 })}</span>
                <ol>{(["order", "company", "sign"] as const).map((s, i) => <li key={s} className={i < n ? "done" : i === n ? "on" : undefined}><i /><span>{tr(LABEL[s])}</span></li>)}</ol>
              </nav>
            )}
            <section className="b-sec">
              <h1 className="b-h1">{tr(LABEL[step])}</h1>
              {step === "company" ? (
                <>
                  <label className="b-mut" htmlFor="co">{tr("buyer.field.company_name" as MessageKey)}</label>
                  <input id="co" className="b-in" defaultValue="Cohen Shop Ltd" style={{ minHeight: 44, border: "1px solid var(--line)", borderRadius: 10, padding: "0 12px", font: "inherit" }} />
                  <label className="b-mut" htmlFor="addr">{tr("buyer.field.billing_address" as MessageKey)}</label>
                  <input id="addr" className="b-in" defaultValue="8 Dizengoff St, Tel Aviv" style={{ minHeight: 44, border: "1px solid var(--line)", borderRadius: 10, padding: "0 12px", font: "inherit" }} />
                </>
              ) : (
                <div className="b-row"><span>2 × User seat</span><span className="b-num">₪200.00</span></div>
              )}
            </section>
            <div className="b-cta">
              <a className="b-btn" href={href(next)} data-form-next="">{step === "sign" ? tr("buyer.sign_and_pay") : tr("buyer.continue")}</a>
              {n > 0 && step !== "pay" ? <a className="b-btn b-btn--2" href={href(STEPS[n - 1])}>{tr("buyer.back")}</a> : null}
            </div>
          </div>
        </main>
        <footer className="b-foot">{tr("buyer.secured_by")}</footer>
      </div>
      <FormVoiceBubble tabKey={c.tabKey} step={step} label={tr(LABEL[step])} lang={c.lang} agentName={c.agentName} />
    </div>
  );
}

void fetch(`/api/form-config?lang=${lang}`).then((r) => r.json() as Promise<Config>).then((c) => {
  createRoot(document.getElementById("root")!).render(<Page c={c} />);
});
