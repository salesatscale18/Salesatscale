"use client";

import { useState, type MouseEvent } from "react";
import { Button } from "./primitives";
import { t } from "@/lib/i18n";

/**
 * The Approve submit button of a held quote's approval form. When the server
 * says the lines are still the agent's although the quote uses an exception
 * (`confirmUnchanged`, lib/quotes/exception-notice.ts), the first click asks
 * "Approve without changing the prices?" inline (no browser dialog), with
 * Confirm / Cancel. UI only: the approval itself is never blocked. Prices the
 * person typed into this form (approve form "price:" fields) count as a change.
 */
export function ApproveButton({ label, confirmUnchanged, icon }: { label: string; confirmUnchanged: boolean; icon?: "check-circle" }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    const onClick = (e: MouseEvent<HTMLButtonElement>) => {
      if (!confirmUnchanged) return;
      const form = e.currentTarget.form;
      const typed = form ? Array.from(form.elements).some((el) => el instanceof HTMLInputElement && el.name.startsWith("price:") && el.value.trim() !== "") : false;
      if (typed) return;
      e.preventDefault();
      setAsking(true);
    };
    return <Button type="submit" variant="primary" size="sm" icon={icon} onClick={onClick} data-approve="" data-confirm-unchanged={confirmUnchanged ? "" : undefined}>{label}</Button>;
  }
  return (
    <span role="group" aria-label={t("quote.exception.confirm")} data-approve-confirm="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, flexBasis: "100%" }}>
      <span className="sas-small" style={{ color: "var(--ink)", fontWeight: 600 }}>{t("quote.exception.confirm")}</span>
      <Button type="submit" variant="primary" size="sm" name="confirmedUnchanged" value="1" autoFocus>{t("quote.exception.confirm_yes")}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
    </span>
  );
}
