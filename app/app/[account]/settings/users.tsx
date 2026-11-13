"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/sas/copy-button";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { inviteUserAction, renewUserInviteAction, type UserInviteState } from "./actions";

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** One-time display of an invite link (no invite emails yet, D8). */
function LinkPanel({ state }: { state: Extract<UserInviteState, { status: "created" }> }) {
  const who = state.name ? `${state.name} (${state.email})` : state.email;
  return (
    <div className="sas-stack-2 sas-alert--success" role="status" style={{ padding: 14, borderRadius: 10 }}>
      <strong><Icon name="check-circle" /> {t("settings.users.link_title", { who })}</strong>
      <div className="sas-well">
        <label htmlFor="invite-url" className="sas-sr">{t("invite_link.label")}</label>
        <input id="invite-url" className="sas-input" readOnly value={state.url} style={{ background: "var(--surface-raised)" }} />
        <CopyButton value={state.url} variant="primary" />
      </div>
      <span className="sas-small" style={{ color: "var(--ink)" }}>{t("settings.users.link_hint", { date: dateFmt.format(new Date(state.expiresAt)) })}</span>
    </div>
  );
}

export function InviteUserForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<UserInviteState, FormData>(inviteUserAction, { status: "idle" });
  return (
    <div className="sas-stack-4">
      {state.status === "created" ? <LinkPanel state={state} /> : null}
      <form action={action} className="sas-stack-2">
        <input type="hidden" name="slug" value={slug} />
        <strong>{t("settings.users.invite_title")}</strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="sas-input-group" style={{ flex: "1 1 160px" }}>
            <label className="sas-input-label" htmlFor="iu-name">{t("settings.users.invite_name")}</label>
            <input className="sas-input" id="iu-name" name="name" autoComplete="off" maxLength={80} />
          </div>
          <div className="sas-input-group" style={{ flex: "1 1 200px" }}>
            <label className="sas-input-label" htmlFor="iu-email">{t("settings.users.invite_email")}</label>
            <input className="sas-input" id="iu-email" name="email" type="email" required autoComplete="off"
              aria-invalid={state.status === "error" ? true : undefined} aria-describedby={state.status === "error" ? "iu-error" : undefined} />
          </div>
          <button type="submit" className={buttonClass("secondary")} disabled={pending}><Icon name="user-plus" />{t("settings.users.invite")}</button>
        </div>
        {state.status === "error" ? <span className="sas-error" id="iu-error">{state.message}</span> : null}
      </form>
    </div>
  );
}

/** "Create new link" on a pending invite: cancels it and shows a fresh link once. */
export function RenewInvite({ slug, inviteId }: { slug: string; inviteId: string }) {
  const [state, action, pending] = useActionState<UserInviteState, FormData>(renewUserInviteAction, { status: "idle" });
  if (state.status === "created") return <LinkPanel state={state} />;
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <button type="submit" className={buttonClass("ghost", "sm")} disabled={pending}>{t("invite_link.renew")}</button>
      {state.status === "error" ? <span className="sas-error">{state.message}</span> : null}
    </form>
  );
}
