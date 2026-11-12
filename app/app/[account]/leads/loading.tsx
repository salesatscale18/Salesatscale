import { t } from "@/lib/i18n";

/** Skeleton rows in the list's own layout, never a page spinner (canvas: ListStates). */
export default function LeadsLoading() {
  return (
    <main className="sas-shell__content">
      <h1 className="sas-title">{t("leads.title")}</h1>
      <section className="sas-panel" aria-busy="true" aria-label={t("leads.loading")} style={{ overflow: "hidden" }}>
        <div className="sas-skeleton-head" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="sas-skeleton-row">
            <span className="sas-skeleton" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
            <span className="sas-skeleton" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
            <span className="sas-skeleton" style={{ width: `${30 + ((i * 11) % 40)}%` }} />
          </div>
        ))}
      </section>
    </main>
  );
}
