import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { publishedCatalog } from "@/lib/catalog/service";
import { getLead } from "@/lib/leads/service";
import { getQuote, QUOTE_VALID_DAYS } from "@/lib/quotes/service";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import { QuoteEditor } from "./editor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Create a quote, or a new version of one (?from=<quoteId>). P3.5. */
export default async function QuoteEditorPage({ params, searchParams }: { params: Promise<{ account: string; leadId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, leadId } = await params;
  const sp = await searchParams;
  const { account } = await requireAccount(slug);
  if (!UUID.test(leadId)) notFound();
  const row = await getLead(appDb, account.id, leadId);
  if (!row) notFound();
  const fromId = typeof sp.from === "string" && UUID.test(sp.from) ? sp.from : undefined;
  const from = fromId ? await getQuote(appDb, account.id, fromId) : null;
  if (fromId && (!from || from.quote.leadId !== leadId)) notFound();
  const catalog = await publishedCatalog(appDb, account.id);

  const current = from?.versions[0];
  const initialQty = Object.fromEntries((current?.lines ?? []).map((l) => [l.sku, l.qty]));
  return (
    <main className="sas-shell__content">
      <header className="sas-stack-2">
        <nav aria-label="Breadcrumb" className="sas-small"><a href={`/app/${account.slug}/leads/${leadId}`}>{row.lead.fullName}</a> / {from ? `Q-${from.quote.number}` : t("quote.editor.create")}</nav>
        <h1 className="sas-title">{from ? t("quote.editor.title_version", { number: from.quote.number, version: from.quote.currentVersion + 1 }) : t("quote.editor.title_new", { name: row.lead.fullName })}</h1>
        {current ? (
          <span className="sas-small">
            {t("quote.editor.replaces", { version: current.version.version, total: formatMoney(current.version.oneTimeTotalMinor, account.currency) })}
            {current.version.recurringTotalMinor ? ` + ${formatMoney(current.version.recurringTotalMinor, account.currency, { period: "month" })}` : ""}
          </span>
        ) : null}
        {catalog ? <span className="sas-small">{t("quote.editor.intro", { version: catalog.version.version })}</span> : null}
      </header>
      {!catalog ? (
        <section className="sas-panel sas-empty">
          <span className="sas-empty__icon sas-empty__icon--start"><Icon name="package" /></span>
          <strong>{t("quote.editor.no_catalog")}</strong>
          <a className={buttonClass("primary", "sm")} href={`/app/${account.slug}/setup/catalog`}>{t("quote.editor.open_catalog")}</a>
        </section>
      ) : (
        <QuoteEditor
          slug={account.slug}
          leadId={leadId}
          fromQuote={from?.quote.id}
          currency={account.currency}
          maxDiscountPct={account.maxDiscountBp / 100}
          items={catalog.items.filter((i) => i.active).map((i) => ({ sku: i.sku, name: i.name, unit: i.unit, recurring: i.chargeType === "recurring", priceMinor: i.priceMinor, availability: i.availabilityNote }))}
          initialQty={initialQty}
          initialDiscount={current && current.version.discountBp ? String(current.version.discountBp / 100) : ""}
          idem={randomUUID()}
          validDays={QUOTE_VALID_DAYS}
        />
      )}
    </main>
  );
}
