"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { createIntakeKeyAction, type KeyState } from "./actions";

export function IntakeKeyForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<KeyState, FormData>(createIntakeKeyAction, { status: "idle" });
  return (
    <div className="sas-stack-4" style={{ padding: "0 var(--space-4) var(--space-4)" }}>
      {state.status === "created" ? (
        <div className="sas-stack-2 sas-alert--success" role="status" style={{ padding: 14, borderRadius: 10 }}>
          <strong>{t("settings.intake.new_key_title", { name: state.name })}</strong>
          <div className="sas-well">
            <label htmlFor="new-key" className="sas-sr">{t("settings.intake.col.key")}</label>
            <input id="new-key" className="sas-input" readOnly value={state.key} style={{ background: "var(--surface-raised)" }} />
            <CopyButton value={state.key} label={t("settings.intake.copy_key")} variant="primary" />
          </div>
          <span className="sas-small" style={{ color: "var(--ink)" }}>{t("settings.intake.new_key")}</span>
        </div>
      ) : null}
      <form action={action} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <input type="hidden" name="slug" value={slug} />
        <div className="sas-input-group" style={{ flex: "1 1 220px" }}>
          <label className="sas-input-label" htmlFor="key-name">{t("settings.intake.name")}</label>
          <input className="sas-input" id="key-name" name="name" defaultValue="Website form" />
        </div>
        <button type="submit" className={buttonClass("primary", "sm")} style={{ height: 36 }} disabled={pending}><Icon name="plus" />{t("settings.intake.create")}</button>
      </form>
    </div>
  );
}
