import { buttonClass } from "./primitives";
import { Icon } from "./icon";
import { t } from "@/lib/i18n";
import type { ExceptionNotice } from "@/lib/quotes/exception-notice";

/**
 * The amber line at the top of a held quote's approval panel when the quote
 * uses an approved exception (lib/quotes/exception-notice.ts): the exception
 * is not in the prices, so the seller edits the lines first. "Edit lines" is
 * the existing new-version editor (`editHref`). The exception text is the
 * seller's own words: rendered as text, never as HTML.
 */
export function ExceptionNoticeLine({ notice, editHref }: { notice: ExceptionNotice; editHref: string }) {
  const one = notice.texts.length === 1;
  return (
    <div
      role="note"
      data-exception-notice=""
      style={{
        display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap", padding: "8px 10px", borderRadius: 8,
        border: "1px solid var(--warning)", borderInlineStartWidth: 4, background: "var(--surface-raised)", color: "var(--ink)", minWidth: 0,
      }}
    >
      <span style={{ color: "var(--warning)", display: "inline-flex", paddingTop: 2 }}><Icon name="alert-triangle" /></span>
      <div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }} className="sas-small">
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>{one ? t("quote.exception.one", { text: notice.texts[0] }) : t("quote.exception.many")}</span>
        {one ? null : (
          <ul style={{ margin: "4px 0 0", paddingInlineStart: 18, color: "var(--ink)" }}>
            {notice.texts.map((x, i) => <li key={i} data-exception-text="">{x}</li>)}
          </ul>
        )}
      </div>
      <a className={buttonClass("secondary", "sm")} href={editHref} data-edit-lines="">{t("quote.exception.edit_lines")}</a>
    </div>
  );
}
