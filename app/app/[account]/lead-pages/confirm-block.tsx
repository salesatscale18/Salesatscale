import Link from "next/link";
import type { ReactNode } from "react";
import { FocusOnMount } from "@/components/sas/list-kit-client";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";

/**
 * The list kit's in-page confirm step (ConfirmDelete's markup and classes: never window.confirm),
 * with the submit button passed in so it can show that it is working (PendingButton).
 */
export function ConfirmBlock({ title, children, action, fields, cancelHref, submit }: {
  title: string;
  children?: ReactNode;
  action: (f: FormData) => Promise<void>;
  fields: Record<string, string>;
  cancelHref: string;
  submit: ReactNode;
}) {
  return (
    <div className="sas-confirm" role="alertdialog" aria-labelledby="sas-confirm-title" aria-describedby="sas-confirm-body" tabIndex={-1} data-focus-on-mount="" data-confirm-delete="">
      <Icon name="alert-triangle" className="sas-confirm__icon" />
      <div className="sas-confirm__text">
        <strong id="sas-confirm-title"><bdi>{title}</bdi></strong>
        {children ? <span id="sas-confirm-body" className="sas-small">{children}</span> : null}
      </div>
      <form action={action} className="sas-confirm__actions">
        {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Link href={cancelHref} className={buttonClass("secondary", "sm")} replace scroll={false}>{t("common.cancel")}</Link>
        {submit}
      </form>
      <FocusOnMount />
    </div>
  );
}
