import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { formatMoney } from "@/lib/domain/money";
import { dir, isLocale, translator, type Locale } from "@/lib/i18n";
import { loadForm, orderLabel, signatureFor } from "@/lib/orders/service";
import { PrintButton } from "./print-button";
import "../buyer.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Signed order form", robots: { index: false, follow: false } };

/**
 * The signed document (P5.7): the write-once snapshot plus the signature and
 * its SHA-256 fingerprint. "Print or save as PDF" uses the browser; a stored
 * PDF file comes with the real document pipeline.
 */
export default async function SignedDocumentPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const view = await loadForm(appDb, token);
  if (!view || view.state !== "signed") notFound();
  const sig = await signatureFor(appDb, view.form.id);
  if (!sig) notFound();
  const s = view.form.snapshot;
  const asked = typeof sp.lang === "string" ? sp.lang : "";
  const lang: Locale = isLocale(asked) ? asked : isLocale(view.form.language) ? view.form.language : "en";
  const tr = translator(lang);
  const m = (minor: number) => formatMoney(minor, s.currency);
  const date = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(sig.signedAt) + " UTC";
  return (
    <div className="b-root" lang={lang} dir={dir(lang)} style={{ ["--brand" as string]: s.seller.brandColor }}>
      <div className="b-page">
        <div className="b-strip" role="note">{tr("buyer.test_strip")}</div>
        <section className="b-sec">
          <h1 className="b-h1">{tr("buyer.document_title")}</h1>
          <span>{s.seller.legalName ?? s.seller.tradeName} · <span className="b-num">Q-{s.quote.number} v{s.quote.version}</span> · <span className="b-num">{orderLabel(s.seller.tradeName, view.order.number)}</span></span>
        </section>
        <section className="b-sec">
          {s.lines.map((l) => (
            <div key={l.sku} className="b-row"><span>{l.qty} × {l.name} <span className="b-mut">{l.sku}</span></span><span className="b-num">{l.recurring ? tr("buyer.per_month", { price: m(l.lineTotalMinor) }) : m(l.lineTotalMinor)}</span></div>
          ))}
          <div className="b-row b-row--total"><span>{tr("buyer.due_today")}</span><span className="b-num">{m(s.oneTime.totalMinor)}</span></div>
          <span className="b-mut">{s.pricesIncludeTax ? tr("buyer.incl_vat") : tr("buyer.plus_vat", { tax: m(s.oneTime.taxMinor) })}</span>
        </section>
        <section className="b-sec">
          <h2 className="b-h2">{tr("buyer.details")}</h2>
          {Object.entries(sig.buyerFields).filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="b-row"><span className="b-mut">{tr(`buyer.field.${k}` as "buyer.field.company_name")}</span><span>{v}</span></div>
          ))}
        </section>
        <section className="b-sec b-terms" style={{ gap: 8 }}>
          <h2 className="b-h2">{tr("buyer.terms")}</h2>
          {s.legal.map((l) => (
            <div key={l.key}><b>{l.title}</b> <span className="b-mut">{tr("buyer.version", { version: l.version })}</span><pre>{l.body}</pre></div>
          ))}
        </section>
        <section className="b-sec">
          <b>{tr("buyer.document_signed", { name: sig.fullName, role: sig.role ? `, ${sig.role}` : "", date })}</b>
          <span className="b-mut">{tr("buyer.document_record", { ip: sig.ip ?? "—", version: `Q-${s.quote.number} v${s.quote.version} · ${s.legal.map((l) => `${l.title} v${l.version}`).join(", ")}` })}</span>
          <span className="b-mut b-num" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{tr("buyer.document_hash", { hash: sig.documentHash })}</span>
          <div className="b-noprint" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <PrintButton label={tr("buyer.print")} />
            <a className="b-btn b-btn--2" href={`/f/${token}?lang=${lang}`}>{tr("buyer.back")}</a>
          </div>
        </section>
        <footer className="b-foot">{tr("buyer.generated_by")}</footer>
      </div>
    </div>
  );
}
