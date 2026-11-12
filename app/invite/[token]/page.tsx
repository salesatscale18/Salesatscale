import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { SasRoot } from "@/components/sas/root";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { ensureUser } from "@/lib/ensure-user";
import { appDb, verifiedEmails } from "@/lib/auth/account";
import { displayName } from "@/lib/auth/display";
import { findInviteByToken } from "@/lib/accounts/service";
import { inviteEmailMatches, inviteState } from "@/lib/accounts/rules";
import { t, type MessageKey } from "@/lib/i18n";
import { acceptInviteAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Invitation — Sales at Scale",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Canvas: AccessStates › invite acceptance. Requires sign-in (proxy.ts). */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const me = await ensureUser();
  if (!me) return (await auth()).redirectToSignIn();

  const found = await findInviteByToken(appDb, token);
  const state = found ? inviteState(found.invite, new Date()) : "not_found";
  const alreadyMine = found?.invite.acceptedByUserId === me.id;
  const emails = await verifiedEmails();
  const mismatch = found && state === "valid" && !inviteEmailMatches(found.invite.email, emails);

  let body: React.ReactNode;
  if (!found || (state !== "valid" && !alreadyMine)) {
    body = (
      <div className="sas-alert sas-alert--danger" role="alert">
        <Icon name="x-circle" />
        <span>{t(`invite.${state}` as MessageKey)}</span>
      </div>
    );
  } else if (alreadyMine) {
    body = <a className={buttonClass("primary")} href={`/app/${found.account.slug}`}>{t("admin.create.open")}</a>;
  } else if (mismatch) {
    body = (
      <>
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t("invite.email_mismatch", { invited: found.invite.email, current: me.email ?? "—" })}</span>
        </div>
        <SignOutButton redirectUrl={`/invite/${token}`}>
          <button type="button" className={buttonClass("secondary")}>{t("common.sign_out")}</button>
        </SignOutButton>
      </>
    );
  } else {
    body = (
      <form action={acceptInviteAction}>
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={buttonClass("primary")}>{t("invite.accept")}</button>
      </form>
    );
  }

  const role = t(`access.picker.role.${found?.invite.role ?? "seller_admin"}`);
  return (
    <SasRoot>
      <main className="sas-center">
        <section className="sas-panel sas-card-narrow">
          <div className="sas-panel__body sas-stack-4">
            <h1 className="sas-title">{t("invite.title", { account: found?.account.tradeName ?? "Sales at Scale" })}</h1>
            {found ? (
              <p>
                {found.inviter
                  ? t("invite.body", { inviter: displayName(found.inviter), role, email: found.invite.email })
                  : t("invite.body_no_inviter", { role, email: found.invite.email })}
              </p>
            ) : null}
            {body}
          </div>
        </section>
      </main>
    </SasRoot>
  );
}
