"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { PlaybookChange } from "@/lib/agent/playbook-save";
import { partOfKey, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { savePlaybookRowAction } from "./actions";
import { PART_LABEL } from "./summaries";
import "./playbook.css";

/** What a part's rows share: the account, the part links, and which row is open (one at a time). */
type RowsCtx = { slug: string; part: PlaybookPart; hrefs: Record<PlaybookPart, string>; open: string | null; setOpen: (id: string | null) => void };
const Ctx = createContext<RowsCtx | null>(null);

/** `edit`: the row to open first (a link such as `limits?edit=handOffWhen`). */
export function PartRows({ slug, part, hrefs, edit, children }: { slug: string; part: PlaybookPart; hrefs: Record<PlaybookPart, string>; edit?: string | null; children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(edit ?? null);
  return <Ctx.Provider value={{ slug, part, hrefs, open, setOpen }}><div className="pb-rows">{children}</div></Ctx.Provider>;
}

export function useRows(): RowsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("Playbook rows need PartRows.");
  return c;
}

export type ErrorOf = (key: string) => string | undefined;

/** Errors of keys this row owns (`never.2`, `agentNameLocal.he`, …). */
const owns = (own: readonly string[], key: string) => own.some((o) => key === o || key.startsWith(`${o}.`));

/** A refused save: the row's own errors inline; anything else names its part and links there. */
export function OtherErrors({ errors, own }: { errors: Record<string, string>; own: readonly string[] }) {
  const c = useRows();
  const other = Object.entries(errors).filter(([k]) => !owns(own, k));
  if (!other.length) return null;
  return (
    <div className="sas-alert sas-alert--danger pb-row__alert" role="alert" tabIndex={-1} data-row-error="">
      <Icon name="alert-triangle" />
      <span className="sas-stack-2" style={{ gap: 4 }}>
        {other.map(([k, msg]) => {
          const part = partOfKey(k);
          return (
            <span key={k}>
              {part ? <>{t("playbook.row.other_part", { part: t(PART_LABEL[part]) })} {msg} <a href={c.hrefs[part]}>{t("playbook.row.open_part", { part: t(PART_LABEL[part]) })}</a></> : msg}
            </span>
          );
        })}
      </span>
    </div>
  );
}

/**
 * Runs one change through the row action, with pending state and the refusal
 * kept for the row. `onFail`: also told when the change was refused (a move
 * puts the row back).
 */
export function useRowSave(onDone: () => void, onFail?: () => void) {
  const c = useRows();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string> | null>(null);
  const run = (change: PlaybookChange | null) => {
    if (!change) return;
    start(async () => {
      try {
        const r = await savePlaybookRowAction(c.slug, change);
        if (r.ok) { setErrors(null); onDone(); } else { setErrors(r.errors); onFail?.(); }
      } catch {
        setErrors({ form: t("playbook.row.failed") });
        onFail?.();
      }
    });
  };
  return { pending, errors, setErrors, run };
}

/**
 * One line of a part, read first (board PlaybookAgent): the label, the current
 * value and "Change". Changing opens the row's fields only (sized to their
 * content) with Save / Cancel; Save sends ONE change and stays open with the
 * error at the row when it is refused. Focus moves into the fields on open and
 * back to "Change" on close. `extra`: more buttons in the read state (Remove).
 */
export function EditRow({ id, label, read, editor, toChange, own, hint, readHint, wide, changeLabel, extra, editable = true, item, lead, aside, rowAttrs, after }: {
  id: string;
  label: ReactNode;
  read: ReactNode;
  /** The fields; `e(key)` gives the row's own error for an input (also for aria-invalid). */
  editor?: (e: ErrorOf) => ReactNode;
  /** The change to save from the row's form; null keeps it open (nothing to save). */
  toChange?: (form: FormData) => PlaybookChange | null;
  /** Error keys this row owns (shown inline); others name their part. */
  own?: readonly string[];
  /** The full helper: shown only while the row is open. */
  hint?: ReactNode;
  /** At most one short muted line under the value in the read state (UX: no helper walls). */
  readHint?: ReactNode;
  /** No label column: the value takes the row (list items). */
  wide?: boolean;
  changeLabel?: string;
  extra?: ReactNode;
  editable?: boolean;
  /** A list item (boards PlaybookOpening2, PlaybookAsks, PlaybookObjections): "Change" is a pencil icon labelled with this text. */
  item?: { what: string };
  /** Before the value in the read state (a drag handle). */
  lead?: ReactNode;
  /** Between the value and the buttons in the read state (Default, Make default, a role tag). */
  aside?: ReactNode;
  /** On the row element (drag and drop: its position). */
  rowAttrs?: Record<string, string | number | undefined>;
  /** Under the row in the read state (a move's pending line or refusal). */
  after?: ReactNode;
}) {
  const c = useRows();
  const open = c.open === id;
  const changeRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const wasOpen = useRef(false);
  const close = () => c.setOpen(null);
  const { pending, errors, setErrors, run } = useRowSave(close);
  const labelId = useId();

  useEffect(() => {
    if (open) formRef.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button")?.focus();
    else if (wasOpen.current) changeRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (errors) formRef.current?.querySelector<HTMLElement>("[aria-invalid=true], [data-row-error]")?.focus();
  }, [errors]);

  const ownKeys = own ?? [];
  const e: ErrorOf = (key) => (errors && owns(ownKeys, key) ? errors[key] : undefined);
  return (
    <div className={`pb-row${wide || item ? " pb-row--wide" : ""}${item ? " pb-row--item" : ""}`} data-row={id} data-open={open ? "" : undefined} aria-busy={pending || undefined} {...rowAttrs}>
      {wide || item ? <span className="sas-sr" id={labelId}>{label}</span> : <span className="pb-row__label" id={labelId}>{label}</span>}
      {item && lead !== undefined ? <span className="pb-row__lead">{open ? null : lead}</span> : null}
      <div className="pb-row__value">
        {open && editor ? (
          <form
            ref={formRef} className="pb-row__form" aria-labelledby={labelId} noValidate
            onSubmit={(ev) => { ev.preventDefault(); run(toChange?.(new FormData(ev.currentTarget)) ?? null); }}
            onKeyDown={(ev) => { if (ev.key === "Escape") { ev.preventDefault(); setErrors(null); close(); } }}
          >
            {editor(e)}
            {hint ? <span className="sas-hint">{hint}</span> : null}
            {errors ? <OtherErrors errors={errors} own={ownKeys} /> : null}
            <span className="pb-row__buttons">
              <button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>{pending ? t("playbook.saving") : t("playbook.row.save")}</button>
              <button type="button" className={buttonClass("secondary", "sm")} disabled={pending} onClick={() => { setErrors(null); close(); }}>{t("playbook.row.cancel")}</button>
            </span>
          </form>
        ) : (
          <>
            {read}
            {readHint ? <span className="sas-small pb-row__hint">{readHint}</span> : null}
          </>
        )}
      </div>
      {!open ? (
        <span className="pb-row__actions">
          {aside}
          {editable && editor ? (
            item ? (
              <button ref={changeRef} type="button" className="pb-icon-btn" onClick={() => c.setOpen(id)} aria-label={t("playbook.row.edit", { what: item.what })} title={t("playbook.row.change")}><Icon name="pencil" /></button>
            ) : (
              <button ref={changeRef} type="button" className="pb-link" onClick={() => c.setOpen(id)} aria-describedby={labelId}>{changeLabel ?? t("playbook.row.change")}</button>
            )
          ) : null}
          {extra}
        </span>
      ) : null}
      {!open && after ? <div className="pb-row__after">{after}</div> : null}
    </div>
  );
}

/**
 * A button in a read row that saves one change at once (Remove), with its own
 * pending state and the refusal shown at the row.
 */
export function RowCommand({ change, label, ariaLabel, confirmText }: { change: PlaybookChange; label: string; ariaLabel?: string; confirmText?: string }) {
  const { pending, errors, run } = useRowSave(() => {});
  return (
    <>
      <button
        type="button" className="pb-link pb-link--muted" disabled={pending} aria-label={ariaLabel}
        onClick={() => { if (!confirmText || window.confirm(confirmText)) run(change); }}
      >
        {pending ? t("playbook.saving") : label}
      </button>
      {errors ? <span className="pb-row__cmd-error"><OtherErrors errors={errors} own={[]} /></span> : null}
    </>
  );
}

/** "Add …": a button that opens an empty editor at the end of a list. */
export function AddRow({ id, label, editor, toChange, own, disabled, note }: {
  id: string; label: string; editor: (e: ErrorOf) => ReactNode; toChange: (form: FormData) => PlaybookChange | null; own: readonly string[];
  /** The list is full: the button is off and `note` says why. */
  disabled?: boolean;
  note?: ReactNode;
}) {
  const c = useRows();
  if (c.open !== id) {
    return (
      <div className="pb-row pb-row--add">
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => c.setOpen(id)} disabled={disabled} data-add={id}><Icon name="plus" />{label}</button>
        {note ? <span className="sas-small pb-row__note">{note}</span> : null}
      </div>
    );
  }
  return <EditRow id={id} label={label} read={null} editor={editor} toChange={toChange} own={own} wide />;
}
