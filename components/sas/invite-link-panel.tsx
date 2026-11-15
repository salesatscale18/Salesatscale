"use client";

import { useState } from "react";
import { t, type MessageKey } from "@/lib/i18n";
import { Icon } from "./icon";
import { buttonClass } from "./primitives";

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/**
 * One-time display of an invite link until invite emails exist (D8).
 * Spec from the UX session: title, who/expiry line, read-only link with Copy, Done, footnote.
 */
export function InviteLinkPanel({
  title,
  name,
  email,
  expiresAt,
  url,
  doneHref,
}: {
  title: MessageKey;
  name?: string | null;
  email: string;
  expiresAt: string;
  url: string;
  doneHref: string;
}) {
  const [copied, setCopied] = useState(false);
  const who = name ? `${name} (${email})` : email;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked: the field is selectable, so the link can still be copied by hand.
      setCopied(false);
    }
  }
  return (
    <div className="sas-stack-4" role="status">
      <div className="sas-alert sas-alert--success">
        <Icon name="check-circle" />
        <strong>{t(title)}</strong>
      </div>
      <p style={{ margin: 0 }}>{t("invite_link.body", { who, date: dateFmt.format(new Date(expiresAt)) })}</p>
      <div className="sas-stack-2">
        <label className="sas-input-label" htmlFor="invite-link">{t("invite_link.label")}</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input id="invite-link" className="sas-input sas-num" readOnly value={url} style={{ flex: "1 1 260px", width: "auto" }} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={buttonClass("secondary")} onClick={copy} aria-live="polite">
            <Icon name={copied ? "check" : "file-text"} />
            {copied ? t("invite_link.copied") : t("invite_link.copy")}
          </button>
        </div>
      </div>
      <div>
        <a className={buttonClass("primary")} href={doneHref}>{t("invite_link.done")}</a>
      </div>
      <p className="sas-hint" style={{ margin: 0 }}>{t("invite_link.footnote")}</p>
    </div>
  );
}
