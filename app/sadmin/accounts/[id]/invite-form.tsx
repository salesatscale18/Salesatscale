"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { inviteAction, type InviteState } from "../actions";

export function InviteForm({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteAction, { status: "idle" });
  return (
    <form action={action} className="sas-stack-2">
      <input type="hidden" name="accountId" value={accountId} />
      <label className="sas-input-label" htmlFor="invite-email">{t("admin.accounts.invite")}</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input className="sas-input" id="invite-email" name="email" type="email" style={{ flex: "1 1 200px", width: "auto" }}
          aria-invalid={state.status === "error" ? true : undefined} aria-describedby={state.status === "error" ? "invite-error" : undefined} />
        <button type="submit" className={buttonClass("secondary", "sm")} style={{ height: 36 }} disabled={pending}>
          {t("admin.accounts.invite")}
        </button>
      </div>
      {state.status === "error" ? <span className="sas-error" id="invite-error">{state.message}</span> : null}
      {state.status === "created" ? (
        <div className="sas-stack-2" role="status">
          <strong>{t("admin.accounts.invite_link", { email: state.email })}</strong>
          <code className="sas-copy">{state.inviteUrl}</code>
          <span className="sas-hint">{t("common.copy_hint")}</span>
        </div>
      ) : null}
    </form>
  );
}
