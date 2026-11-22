"use client";

import { useActionState, useMemo } from "react";
import { Icon } from "@/components/sas/icon";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { csvEscape } from "@/lib/leads/csv";
import { importLeadsAction, type ImportState } from "../actions";

/**
 * CSV import (canvas: ImportCsv): upload, then the result state. Consent for
 * the whole file is ticked by default (owner, 22 Nov) and recorded with the
 * file name; a row's own consent columns are used when it has them.
 * Unticked: the leads are saved and the agent never contacts them.
 */

export function ImportForm({ slug, who }: { slug: string; who: string }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importLeadsAction, { status: "idle" });

  const rejectedHref = useMemo(() => {
    if (state.status !== "done" || state.result.rejected.length === 0) return null;
    const lines = [["row", "name", "problem", "how_to_fix"], ...state.result.rejected.map((r) => [r.line, r.name, r.problem, r.fix])];
    return `data:text/csv;charset=utf-8,${encodeURIComponent(lines.map((l) => l.map(csvEscape).join(",")).join("\n"))}`;
  }, [state]);

  if (state.status === "done") {
    const r = state.result;
    const blocked = r.missingColumns.length > 0 || r.tooManyRows;
    return (
      <div className="sas-stack-6">
        <section className="sas-panel sas-file-line">
          <span className="sas-file-badge" aria-hidden="true">CSV</span>
          <span className="sas-list__main">
            <strong>{state.fileName}</strong>
            <span className="sas-small">
              {t("import.file_line", { rows: r.totalRows, when: "just now", who })}
              {state.fileConsent ? "" : ` · ${t("import.file_line_no_contact")}`}
            </span>
          </span>
          <a className={buttonClass("secondary", "sm")} href={`/app/${slug}/leads/import`}><Icon name="upload" />{t("import.another")}</a>
        </section>

        {blocked ? (
          <div className="sas-alert sas-alert--danger" role="alert">
            <Icon name="alert-triangle" />
            <span>{r.tooManyRows ? t("import.too_many") : t("import.missing_columns", { columns: r.missingColumns.join(", ") })}</span>
          </div>
        ) : (
          <>
            <section aria-label="Result" className="sas-tiles" role="status">
              <div className="sas-tile">
                <StatusPill object="intake_result" state="created" />
                <span className="sas-metric__value">{r.created}</span>
                <span className="sas-small">{t("import.tile.created")}</span>
              </div>
              <div className="sas-tile">
                <StatusPill object="intake_result" state="updated" />
                <span className="sas-metric__value">{r.updated}</span>
                <span className="sas-small">{t("import.tile.updated")}</span>
              </div>
              <div className={r.rejected.length ? "sas-tile sas-tile--danger" : "sas-tile"}>
                <StatusPill object="intake_result" state="rejected" />
                <span className="sas-metric__value">{r.rejected.length}</span>
                <span className="sas-small">{t("import.tile.rejected")}</span>
              </div>
            </section>
            {r.unknownColumns.length > 0 ? <span className="sas-small">{t("import.unknown_columns", { columns: r.unknownColumns.join(", ") })}</span> : null}
            {r.rejected.length > 0 ? (
              <section className="sas-panel" aria-labelledby="rej-h" style={{ overflow: "hidden" }}>
                <div className="sas-panel__head">
                  <h2 id="rej-h" className="sas-heading">{t("import.rejected_title", { count: r.rejected.length })}</h2>
                  {rejectedHref ? (
                    <a className={buttonClass("secondary", "sm")} href={rejectedHref} download={`rejected-${state.fileName.replace(/\.csv$/i, "")}.csv`}>
                      <Icon name="download" />{t("import.download_rejected")}
                    </a>
                  ) : null}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="sas-table" style={{ minWidth: 640 }}>
                    <thead><tr><th scope="col">{t("import.col.row")}</th><th scope="col">{t("import.col.name")}</th><th scope="col">{t("import.col.problem")}</th><th scope="col">{t("import.col.fix")}</th></tr></thead>
                    <tbody>
                      {r.rejected.slice(0, 200).map((x) => (
                        <tr key={x.line}>
                          <td className="sas-num">{x.line}</td>
                          <td>{x.name}</td>
                          <td style={{ whiteSpace: "normal" }}>{x.problem}</td>
                          <td className="sas-small" style={{ whiteSpace: "normal" }}>{x.fix}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {r.rejected.length > 200 ? <div className="sas-table-foot">{t("import.more_rejected")}</div> : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="sas-panel sas-panel__body sas-stack-4">
      <input type="hidden" name="slug" value={slug} />
      {state.status === "bad_file" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("import.bad_file")}</span></div> : null}
      <fieldset className="sas-fieldset" style={{ gridTemplateColumns: "1fr", padding: 12 }}>
        <legend>{t("lead.form.consent")}</legend>
        <label className="sas-check">
          <input type="checkbox" name="fileConsent" value="yes" defaultChecked aria-describedby="file-consent-hint" />
          {t("import.file_consent")}
        </label>
        <span className="sas-hint" id="file-consent-hint">{t("import.file_consent_hint")}</span>
      </fieldset>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="file">{t("import.file")}</label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          aria-describedby="file-hint"
        />
        <span className="sas-hint" id="file-hint">{t("import.file_hint")}</span>
      </div>
      <div><button type="submit" className={buttonClass("primary")} disabled={pending} aria-disabled={pending}><Icon name="upload" />{t("import.submit")}</button></div>
    </form>
  );
}
