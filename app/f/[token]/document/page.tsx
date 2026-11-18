import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { sellerAccounts } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { dir, isLocale, translator, type Locale } from "@/lib/i18n";
import { displaySeller, loadForm, orderLabel, signatureFor, snapshotOf } from "@/lib/orders/service";
import { OrderLines } from "../lines";
import { DeliveryRow } from "../delivery";
import { PreferenceRow } from "../steps";
import { PrintButton } from "./print-button";
import { legalInOrder } from "@/lib/orders/display";
import { brandVars } from "@/lib/simulator/rules";
import { buyerDateTime, buyerZone, utcStamp } from "../time";
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
  const s = snapshotOf(view.form);
  const asked = typeof sp.lang === "string" ? sp.lang : "";
  const lang: Locale = isLocale(asked) ? asked : isLocale(view.form.language) ? view.form.language : "en";
  const tr = translator(lang);
  // The signing time in the buyer's (market's) zone, as on the payment page; UTC only as the audit value below.
  const [account] = await appDb.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, view.form.accountId));
  const date = buyerDateTime(sig.signedAt, buyerZone(s, account?.timezone ?? "UTC"), lang);
  const seller = displaySeller(view.form, lang);
  // Only the hash is monospace: the label around it stays in the page font.
  const hashParts = tr("buyer.document_hash", { hash: "\u0000" }).split("\u0000");
  // UTC is the secondary audit value, isolated so it keeps its order in Hebrew.
  const utcParts = tr("buyer.document_utc", { time: "\u0000" }).split("\u0000");
  const initials = seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  // The buyer's details in the form's own field order (step 2), then anything else that was signed.
  const order = [...s.fields, ...Object.keys(sig.buyerFields).filter((k) => !(s.fields as string[]).includes(k))];
  // One way to name a version per language: "v1" in English, "גרסה 1" in Hebrew (buyer.version).
  const ver = (version: number) => tr("buyer.version", { version });
  const quoteVersion = `Q-${s.quote.number} ${ver(s.quote.version)}`;
  // Sales terms first, then the other sections in the account's order (as on step 3).
  const legal = legalInOrder(s.legal);
  const details = order.map((k) => [k, (sig.buyerFields as Record<string, string | undefined>)[k]] as const).filter(([, v]) => v);
  return (
    <div className="b-root" lang={lang} dir={dir(lang)} style={brandVars(s.seller.brandColor)}>
      <div className="b-page">
        <header className="b-head" data-doc-seller="">
          <span className="b-logo" aria-hidden="true">{initials}</span>
          <span className="b-head__name"><b style={{ fontSize: 16 }}><bdi>{seller}</bdi></b>{s.seller.legalName && s.seller.legalName !== seller ? <span className="b-mut"><bdi>{s.seller.legalName}</bdi></span> : null}</span>
        </header>
        <section className="b-sec">
          <h1 className="b-h1">{tr("buyer.document_title")}</h1>
          <span data-doc-ids=""><bdi className="b-id">Q-{s.quote.number}</bdi> {ver(s.quote.version)} · <bdi className="b-id">{orderLabel(s.seller.tradeName, view.order.number)}</bdi></span>
        </section>
        <section className="b-sec">
          <OrderLines s={s} tr={tr} lang={lang} />
          <DeliveryRow s={s} signedAt={view.form.signedAt ?? sig.signedAt} tr={tr} lang={lang} />
          <PreferenceRow order={view.order} tr={tr} lang={lang} />
        </section>
        <section className="b-sec">
          <h2 className="b-h2">{tr("buyer.details")}</h2>
          {details.map(([k, v]) => (
            <div key={k} className="b-row" data-doc-field={k}><span className="b-mut">{tr(`buyer.field.${k}` as "buyer.field.company_name")}</span><span><bdi>{v}</bdi></span></div>
          ))}
        </section>
        <section className="b-sec b-terms" style={{ gap: 8 }}>
          <h2 className="b-h2">{tr("buyer.terms")}</h2>
          {legal.map((l) => (
            <div key={l.key}><b>{l.title}</b> <span className="b-mut">{tr("buyer.version", { version: l.version })}</span><pre>{l.body}</pre></div>
          ))}
        </section>
        <section className="b-sec">
          <b data-doc-signed="">{tr("buyer.document_signed", { name: sig.fullName, role: sig.role ? `, ${sig.role},` : "", date })}</b>
          <span className="b-mut">{tr("buyer.document_record", { ip: sig.ip ?? "—", version: `${quoteVersion} · ${legal.map((l) => `${l.title} ${ver(l.version)}`).join(", ")}` })} · {utcParts[0]}<bdi data-doc-utc="">{utcStamp(sig.signedAt)}</bdi>{utcParts[1]}</span>
          <span className="b-mut" style={{ overflowWrap: "anywhere" }}>{hashParts[0]}<span className="b-mono" data-doc-hash="">{sig.documentHash}</span>{hashParts[1]}</span>
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
