"use client";

import { useState } from "react";
import { Button } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { optOutLeadAction } from "../actions";

/** "Mark as opted out" with an inline confirm (UX decision: no browser dialog). */
export function OptOutButton({ slug, leadId }: { slug: string; leadId: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button size="sm" variant="danger" icon="x-circle" onClick={() => setConfirming(true)} style={{ alignSelf: "flex-start" }}>
        {t("lead.card.opt_out")}
      </Button>
    );
  }
  return (
    <form action={optOutLeadAction} className="sas-stack-2" role="group" aria-label={t("lead.card.opt_out")}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="leadId" value={leadId} />
      <span className="sas-small" style={{ color: "var(--ink)" }}>{t("lead.card.opt_out_confirm")}</span>
      <span style={{ display: "flex", gap: 8 }}>
        <Button type="submit" size="sm" variant="danger" autoFocus>{t("lead.card.opt_out")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
      </span>
    </form>
  );
}
