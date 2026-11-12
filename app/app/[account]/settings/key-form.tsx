"use client";

import { useActionState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { createIntakeKeyAction, type KeyState } from "./actions";

export function IntakeKeyForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<KeyState, FormData>(createIntakeKeyAction, { status: "idle" });
  return (
    <div className="sas-stack-2">
      {state.status === "created" ? (
        <div className="sas-stack-2" role="status">
          <div className="sas-alert sas-alert--success"><Icon name="check-circle" /><span>{t("settings.intake.new_key")}</span></div>
          <code className="sas-copy">{state.key}</code>
        </div>
      ) : null}
      <form action={action} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <input type="hidden" name="slug" value={slug} />
        <div className="sas-input-group" style={{ flex: "1 1 220px" }}>
          <label className="sas-input-label" htmlFor="key-name">{t("settings.intake.name")}</label>
          <input className="sas-input" id="key-name" name="name" defaultValue="Website form" />
        </div>
        <button type="submit" className={buttonClass("secondary")} disabled={pending}>{t("settings.intake.create")}</button>
      </form>
    </div>
  );
}
