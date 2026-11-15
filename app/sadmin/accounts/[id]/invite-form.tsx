"use client";

import { useActionState } from "react";
import { InviteLinkPanel } from "@/components/sas/invite-link-panel";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { inviteAction, renewInviteAction, type InviteState } from "../actions";

export function InviteForm({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteAction, { status: "idle" });
  if (state.status === "created") {
    return <InviteLinkPanel title="invite_link.title.invite" {...state.link} doneHref={`/sadmin/accounts/${accountId}`} />;
  }
  return (
    <form action={action} className="sas-stack-2">
      <input type="hidden" name="accountId" value={accountId} />
      <strong>{t("admin.accounts.invite")}</strong>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="sas-input-group" style={{ flex: "1 1 160px" }}>
          <label className="sas-input-label" htmlFor="invite-name">{t("admin.accounts.invite_name")}</label>
          <input className="sas-input" id="invite-name" name="name" autoComplete="off" />
        </div>
        <div className="sas-input-group" style={{ flex: "1 1 200px" }}>
          <label className="sas-input-label" htmlFor="invite-email">{t("admin.accounts.invite_email")}</label>
          <input className="sas-input" id="invite-email" name="email" type="email" autoComplete="off"
            aria-invalid={state.status === "error" ? true : undefined} aria-describedby={state.status === "error" ? "invite-error" : undefined} />
        </div>
        <button type="submit" className={buttonClass("secondary")} disabled={pending}>{t("admin.accounts.invite")}</button>
      </div>
      {state.status === "error" ? <span className="sas-error" id="invite-error">{state.message}</span> : null}
    </form>
  );
}

/** "Create new link" on a pending invite row. */
export function RenewInviteButton({ accountId, inviteId }: { accountId: string; inviteId: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(renewInviteAction, { status: "idle" });
  if (state.status === "created") {
    return <InviteLinkPanel title="invite_link.title.invite" {...state.link} doneHref={`/sadmin/accounts/${accountId}`} />;
  }
  return (
    <form action={action}>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <button type="submit" className={buttonClass("ghost", "sm")} disabled={pending}>{t("invite_link.renew")}</button>
      {state.status === "error" ? <span className="sas-error">{state.message}</span> : null}
    </form>
  );
}
