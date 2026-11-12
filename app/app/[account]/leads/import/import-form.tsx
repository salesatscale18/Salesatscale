"use client";

import { useActionState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { importLeadsAction, type ImportState } from "../actions";

export function ImportForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importLeadsAction, { status: "idle" });
  const r = state.status === "done" ? state.result : null;
  return (
    <div className="sas-stack-4">
      <form action={action} className="sas-panel sas-panel__body sas-stack-4">
        <input type="hidden" name="slug" value={slug} />
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="file">{t("import.file")}</label>
          <input id="file" name="file" type="file" accept=".csv,text/csv" required aria-describedby="file-hint" />
          <span className="sas-hint" id="file-hint">{t("import.file_hint")}</span>
        </div>
        <div><button type="submit" className={buttonClass("primary")} disabled={pending}><Icon name="upload" />{t("import.submit")}</button></div>
      </form>

      {state.status === "bad_file" ? (
        <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("import.bad_file")}</span></div>
      ) : null}

      {r ? (
        <section className="sas-panel" role="status" aria-live="polite">
          <div className="sas-panel__body sas-stack-2">
            {r.missingColumns.length > 0 ? (
              <div className="sas-alert sas-alert--danger"><Icon name="alert-triangle" /><span>{t("import.missing_columns", { columns: r.missingColumns.join(", ") })}</span></div>
            ) : r.tooManyRows ? (
              <div className="sas-alert sas-alert--danger"><Icon name="alert-triangle" /><span>{t("import.too_many")}</span></div>
            ) : (
              <div className={r.rejected.length ? "sas-alert sas-alert--danger" : "sas-alert sas-alert--success"}>
                <Icon name={r.rejected.length ? "alert-triangle" : "check-circle"} />
                <span>{t("import.result", { created: r.created, updated: r.updated, rejected: r.rejected.length })}</span>
              </div>
            )}
            {r.unknownColumns.length > 0 ? <span className="sas-small">{t("import.unknown_columns", { columns: r.unknownColumns.join(", ") })}</span> : null}
          </div>
          {r.rejected.length > 0 ? (
            <>
              <h2 className="sas-group-label">{t("import.rejected")}</h2>
              <ul className="sas-list">
                {r.rejected.slice(0, 200).map((x) => (
                  <li key={x.line} className="sas-list__row">
                    <span className="sas-num" style={{ minWidth: 72 }}>{t("import.row", { line: x.line })}</span>
                    <span className="sas-small">{x.reasons.join(" ")}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
