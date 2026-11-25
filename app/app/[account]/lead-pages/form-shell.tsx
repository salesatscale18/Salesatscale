"use client";

import { createContext, startTransition, useActionState, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/components/sas/primitives";
import { quickPageErrors } from "@/lib/lead-pages/page-check";
import type { LeadPageFormState } from "./actions";
import { DraftProvider, EMPTY_DRAFT, readDraft, type LeadPageDraft } from "./draft";

const State = createContext<LeadPageFormState>(null);

/** Where the first field with an error is, for the line next to the Save buttons. */
export type SaveSummary = { count: number; label: string; form: string | null };
type Feedback = { pending: boolean; pressed: string | null; summary: SaveSummary | null; jump: () => void };
const FeedbackCtx = createContext<Feedback>({ pending: false, pressed: null, summary: null, jump: () => {} });

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/** The line next to the Save buttons after a refused save ("Not saved: 2 fields need a fix. First: Name."). */
export function saveSummaryText(s: SaveSummary, text: Pick<SaveFootText, "notSavedOne" | "notSavedMany" | "notSavedForm">): string {
  if (!s.count || !s.label) return fill(text.notSavedForm, { reason: s.form ?? "" });
  return fill(s.count === 1 ? text.notSavedOne : text.notSavedMany, { n: s.count, field: s.label });
}

/** The field an error belongs to: its input (the checked card for the connection) and its visible label. */
function fieldOf(form: HTMLFormElement, name: string): { el: HTMLElement; label: string } | null {
  const item = form.elements.namedItem(name);
  const connection = (form.elements.namedItem("connection") as RadioNodeList | null)?.value ?? "";
  let el: HTMLElement | null = null;
  if (item instanceof RadioNodeList) {
    const radios = Array.from(item).filter((r): r is HTMLInputElement => r instanceof HTMLInputElement && !r.disabled);
    el = radios.find((r) => r.checked) ?? radios[0] ?? null;
  } else if (item instanceof HTMLElement) el = item;
  if (!el) return null;
  const textOf = (node: Element) => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll(".lpg-req, input, select, textarea, .sas-small, [data-field-error]").forEach((n) => n.remove());
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  const fieldset = el.closest("fieldset");
  const box = el.closest(".lpg-field");
  // The address field has one label per connection (shown by CSS): the one for the chosen connection.
  const labels = box ? Array.from(box.querySelectorAll(".lpg-field__label")) : [];
  const label = labels.find((l) => { const f = l.getAttribute("data-for"); return !f || f.split(/\s+/).includes(connection); });
  const text = item instanceof RadioNodeList && fieldset?.querySelector("legend") ? textOf(fieldset.querySelector("legend")!)
    : label ? textOf(label)
    : (el as HTMLInputElement).labels?.[0] ? textOf((el as HTMLInputElement).labels![0]) : name;
  return { el, label: text };
}

function reveal(el: HTMLElement) {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * The add/edit form: a server action with field errors coming back (no full
 * reload, so what the seller typed stays, the chosen banner file included: the
 * form and its file input stay mounted). Submitted with JS through a
 * transition, which keeps the fields as typed; without JS the browser posts
 * the same action. The pressed button's name/value (Save draft / Go live /
 * Remove banner) goes with the form data.
 *
 * A refused save never looks silent (owner, 25 Nov: "I tried to save a lead draft and it didn't
 * work"): the first field with an error is scrolled into view and focused, the refusal is read out
 * (aria-live), and the line next to the Save buttons (SaveFoot) says how many fields need a fix and
 * which is first. The simple cases (an empty name, an empty or invalid address where it is needed)
 * are checked here before sending, with the server's own messages (lib/lead-pages/page-check.ts);
 * the server checks everything again. While a save runs the buttons say so and are disabled, and a
 * second submit is ignored.
 *
 * When the errors arrive with a fresh page instead (a post sent before the
 * script ran, or without JS), the connection the seller chose is checked again
 * from the returned state, and the banner field asks for the image again.
 *
 * The form's current values (not saved) are read on every change into the
 * draft (draft.tsx), shared with `side`: the live preview, rendered next to
 * the form but outside it, so nothing in it is ever posted. The outer box
 * carries `className`; the form itself is laid out as its children
 * (display: contents) so the cards, the form and the side share one grid.
 */
export function LeadPageFormShell({
  action, errorTitle, children, className, side, initialDraft, summaryText,
}: {
  action: (prev: LeadPageFormState, form: FormData) => Promise<LeadPageFormState>;
  errorTitle: string;
  children: ReactNode;
  className?: string;
  /** Shown next to the form, outside it (the live preview). */
  side?: ReactNode;
  initialDraft?: LeadPageDraft;
  /** What the refusal is read out as (the same line as next to the Save buttons). */
  summaryText?: Pick<SaveFootText, "notSavedOne" | "notSavedMany" | "notSavedForm">;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  // The browser's own check (the simple cases), shown the same way as the server's errors.
  const [local, setLocal] = useState<LeadPageFormState>(null);
  const shown = local ?? state;
  const ref = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const [announce, setAnnounce] = useState("");
  const [draft, setDraft] = useState<LeadPageDraft>(initialDraft ?? EMPTY_DRAFT);
  const errors = shown?.errors ?? {};
  const connection = state?.connection;
  const sync = useCallback(() => {
    const form = ref.current;
    if (form) setDraft((d) => readDraft(form, d));
  }, []);
  useEffect(() => {
    if (!connection || !ref.current) return;
    const radio = Array.from(ref.current.querySelectorAll<HTMLInputElement>('input[name="connection"]')).find((r) => r.value === connection);
    if (radio && !radio.disabled && !radio.checked) radio.checked = true;
    sync();
  }, [connection, state, sync]);
  // The fields as the browser has them once the script runs (a value restored by the browser, a change made before).
  useEffect(() => { sync(); }, [sync]);
  useEffect(() => { if (!pending) busy.current = false; }, [pending]);

  /** The first field with an error (in the order of the form), or null. */
  const firstError = useCallback(() => {
    const form = ref.current;
    if (!form) return null;
    const marks = Array.from(form.querySelectorAll<HTMLElement>("[data-field-error]"));
    for (const m of marks) {
      const f = fieldOf(form, m.getAttribute("data-field-error") ?? "");
      if (f) return { ...f, count: marks.length };
    }
    return { el: null, label: "", count: 0 };
  }, []);
  const jump = useCallback(() => {
    const f = firstError();
    const el = f?.el ?? ref.current?.querySelector<HTMLElement>("[data-form-errors]") ?? null;
    if (el) reveal(el);
  }, [firstError]);

  // A refused save: the first field with an error in view and focused, the line next to the buttons, read out.
  useEffect(() => {
    if (!shown || !Object.keys(shown.errors).length) { setSummary(null); return; }
    // After the paint: the connection may have been checked again and the address field moved.
    const id = requestAnimationFrame(() => {
      const f = firstError();
      const s: SaveSummary = { count: f?.count ?? 0, label: f?.label ?? "", form: shown.errors.form ?? errorTitle };
      setSummary(s);
      setAnnounce(summaryText ? saveSummaryText(s, summaryText) : s.form ?? "");
      jump();
    });
    return () => cancelAnimationFrame(id);
  }, [shown, firstError, jump, errorTitle, summaryText]);

  const setBanner = useCallback((banner: string | null) => setDraft((d) => (d.banner === banner ? d : { ...d, banner })), []);
  const api = useMemo(() => ({ draft, setBanner }), [draft, setBanner]);
  const feedback = useMemo(() => ({ pending, pressed, summary, jump }), [pending, pressed, summary, jump]);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // A second press while the save runs is ignored.
    if (busy.current || pending) return;
    const form = e.currentTarget;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(form, submitter);
    const intent = String(data.get("intent") ?? "");
    if (intent !== "remove_banner" && form.elements.namedItem("name")) {
      const quick = quickPageErrors({
        name: String(data.get("name") ?? ""), connection: String(data.get("connection") ?? ""),
        address: form.elements.namedItem("address") ? String(data.get("address") ?? "") : "",
      });
      if (Object.keys(quick).length) {
        setAnnounce("");
        setLocal({ errors: quick });
        return;
      }
    }
    busy.current = true;
    setLocal(null);
    setSummary(null);
    setAnnounce("");
    setPressed(intent || null);
    startTransition(() => dispatch(data));
  };
  return (
    <DraftProvider value={api}>
      <FeedbackCtx.Provider value={feedback}>
        <div className={className} data-pending={pending ? "" : undefined}>
          <form ref={ref} action={dispatch} onSubmit={onSubmit} onChange={sync} className="lpg-form__form" aria-busy={pending || undefined} noValidate>
            {Object.keys(errors).length ? (
              <div className="sas-alert sas-alert--danger lpg-form__alert" role="alert" data-form-errors="" tabIndex={-1}>
                <span>{errors.form ?? errorTitle}</span>
              </div>
            ) : null}
            <State.Provider value={shown}>{children}</State.Provider>
          </form>
          {side}
          <p className="sas-sr" aria-live="assertive" data-save-announce="">{announce}</p>
        </div>
      </FeedbackCtx.Provider>
    </DraftProvider>
  );
}

/** The last save's result (null before the first one); the browser's own check counts as one. */
export const useLeadPageFormState = () => useContext(State);

/** A field's error from the last save (under the field). */
export function FieldError({ name }: { name: string }) {
  const msg = useContext(State)?.errors[name];
  return msg ? <span className="lpg-field__err" role="alert" data-field-error={name}>{msg}</span> : null;
}

export type SaveFootText = {
  /** "{field}" is filled in. */
  notSavedOne: string;
  /** "{n}" and "{field}" are filled in. */
  notSavedMany: string;
  /** "{reason}" is filled in (a refusal that is not about one field). */
  notSavedForm: string;
  saving: string;
  goingLive: string;
};
export type SaveButton = { intent: string; label: string; variant: ButtonVariant; icon?: ReactNode };

/**
 * The Save buttons with their state (presentational; SaveFoot gives it the form's state): while a
 * save runs every button is disabled and the pressed one says "Saving…" ("Going live…"); after a
 * refused save, a line next to them names how many fields need a fix and the first one, and
 * takes the seller there when pressed.
 */
export function SaveFootView({ buttons, text, after, pending, pressed, summary, onJump }: {
  buttons: SaveButton[]; text: SaveFootText; after?: ReactNode;
  pending: boolean; pressed: string | null; summary: SaveSummary | null; onJump: () => void;
}) {
  return (
    <div className="lpg-form__foot" data-save-foot="">
      {summary && !pending ? (
        <button type="button" className="lpg-notsaved" onClick={onJump} data-save-error="">
          <svg className="sas-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
          </svg>
          <span>{saveSummaryText(summary, text)}</span>
        </button>
      ) : null}
      <div className="lpg-form__buttons">
        {buttons.map((b) => {
          const on = pending && pressed === b.intent;
          return (
            <button
              key={b.intent} type="submit" name="intent" value={b.intent} className={buttonClass(b.variant)}
              disabled={pending} aria-disabled={pending || undefined} data-saving={on ? "" : undefined}
            >
              {on ? <span className="lpg-spin" aria-hidden="true" /> : b.icon}
              {on ? (b.intent === "live" ? text.goingLive : text.saving) : b.label}
            </button>
          );
        })}
        {after}
      </div>
    </div>
  );
}

/** The add/edit form's Save buttons, with the form's state. */
export function SaveFoot(props: { buttons: SaveButton[]; text: SaveFootText; after?: ReactNode }) {
  const { pending, pressed, summary, jump } = useContext(FeedbackCtx);
  return <SaveFootView {...props} pending={pending} pressed={pressed} summary={summary} onJump={jump} />;
}
