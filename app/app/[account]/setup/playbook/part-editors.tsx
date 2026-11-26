"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { Playbook } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { EntryPart } from "@/lib/agent/playbook-save";
import { partOfKey, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { PART_LABEL } from "./summaries";
import { savePlaybookPartAction, type PlaybookFormState } from "./actions";
import { SignedNotPaidCard, unpaidValues } from "./after-order";
import { unpaidRemindersOf, type PlaybookWithUnpaid, type UnpaidReminderSettings } from "@/lib/orders/unpaid-reminders";
import "./playbook.css";

/**
 * A part saved with its whole editor (its inputs as in the one-page form):
 * the server re-checks the whole playbook (savePlaybookPartAction). Errors of
 * another part name that part and link to it.
 */
function PartForm({ slug, part, state, action, pending, blocked, hrefs, children }: {
  slug: string; part: EntryPart; state: PlaybookFormState; action: (f: FormData) => void; pending: boolean; blocked?: boolean;
  hrefs: Record<string, string>;
  children: ReactNode;
}) {
  const e = state.status === "error" ? state.errors : {};
  const count = Object.keys(e).length;
  const first = Object.values(e)[0];
  return (
    <form action={action} className="sas-stack-4 pb-form pb-part__body" noValidate onSubmit={(ev) => { if (blocked) ev.preventDefault(); }} data-part-form={part}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="part" value={part} />
      {children}
      {count ? (
        <div className="sas-alert sas-alert--danger" role="alert">
          <Icon name="alert-triangle" />
          <span>{t("playbook.error_summary", { count })} {first} <OtherPartLinks errors={e} part={part} hrefs={hrefs} /></span>
        </div>
      ) : null}
      <div><button type="submit" className={buttonClass("primary")} disabled={pending || blocked}>{pending ? t("playbook.saving") : t("playbook.save")}</button></div>
    </form>
  );
}

/** Links to the other parts whose values were refused (an invalid stored value elsewhere). */
function OtherPartLinks({ errors, part, hrefs }: { errors: Record<string, string>; part: EntryPart; hrefs: Record<string, string> }) {
  const own: PlaybookPart = part === "name" ? "agent" : part;
  const others = [...new Set(Object.keys(errors).map(partOfKey).filter((x): x is PlaybookPart => !!x && x !== own))];
  if (!others.length) return null;
  return <>{others.map((x) => <a key={x} href={hrefs[x]} style={{ marginInlineStart: 6 }}>{t("playbook.row.open_part", { part: t(PART_LABEL[x]) })}</a>)}</>;
}

// ---------------------------------------------------------------------------
// After the order
// ---------------------------------------------------------------------------

/** After the order (board UnpaidReminders): what happens when a buyer signs and does not pay. The wording the buyer gets is in the part's preview (S3, preview.tsx AfterPreviewPanel). */
export function AfterPart({ slug, hrefs, p, liveUnpaid }: { slug: string; hrefs: Record<string, string>; p: Playbook; liveUnpaid: UnpaidReminderSettings }) {
  const [state, action, pending] = useActionState<PlaybookFormState, FormData>(savePlaybookPartAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  // An error shows under a days field (checked when it loses focus): Save waits for the fix.
  const [blocked, setBlocked] = useState(false);
  const draft = unpaidRemindersOf(p as PlaybookWithUnpaid);
  return (
    <PartForm slug={slug} part="after" state={state} action={action} pending={pending} blocked={blocked} hrefs={hrefs}>
      <SignedNotPaidCard
        initial={unpaidValues(draft, state.status === "error" ? state.values.unpaidReminders : undefined)} errors={e}
        draft={draft} live={liveUnpaid} onBlocked={setBlocked}
      />
    </PartForm>
  );
}
