"use client";

import { useFormStatus } from "react-dom";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { sendTestMessageAction } from "./actions";

function Send() {
  const { pending } = useFormStatus();
  return (
    <>
      {pending ? <span className="sas-small" role="status">{t("lab.sending")}</span> : null}
      <button type="submit" className={buttonClass("primary")} disabled={pending}><Icon name="send" />{t("lab.send")}</button>
    </>
  );
}

/** Message box for a test chat. The turn runs on the server; the page reloads with the reply. */
export function Composer({ slug, conversationId, dir, initialText }: { slug: string; conversationId: string; dir: "ltr" | "rtl"; initialText?: string }) {
  return (
    <form action={sendTestMessageAction} className="sas-stack-2" style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <label className="sas-input-label" htmlFor="lab-text">{t("lab.message")}</label>
      <textarea
        className="sas-textarea" id="lab-text" name="text" rows={2} required maxLength={4000} dir={dir} autoFocus defaultValue={initialText}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}><Send /></div>
    </form>
  );
}
