"use client";

import { createContext, startTransition, useActionState, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { LeadPageFormState } from "./actions";
import { DraftProvider, EMPTY_DRAFT, readDraft, type LeadPageDraft } from "./draft";

const State = createContext<LeadPageFormState>(null);

/**
 * The add/edit form: a server action with field errors coming back (no full
 * reload, so what the seller typed stays, the chosen banner file included: the
 * form and its file input stay mounted). Submitted with JS through a
 * transition, which keeps the fields as typed; without JS the browser posts
 * the same action. The pressed button's name/value (Save draft / Go live /
 * Remove banner) goes with the form data.
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
  action, errorTitle, children, className, side, initialDraft,
}: {
  action: (prev: LeadPageFormState, form: FormData) => Promise<LeadPageFormState>;
  errorTitle: string;
  children: ReactNode;
  className?: string;
  /** Shown next to the form, outside it (the live preview). */
  side?: ReactNode;
  initialDraft?: LeadPageDraft;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<LeadPageDraft>(initialDraft ?? EMPTY_DRAFT);
  const errors = state?.errors ?? {};
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
  const setBanner = useCallback((banner: string | null) => setDraft((d) => (d.banner === banner ? d : { ...d, banner })), []);
  const api = useMemo(() => ({ draft, setBanner }), [draft, setBanner]);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => dispatch(data));
  };
  return (
    <DraftProvider value={api}>
      <div className={className} data-pending={pending ? "" : undefined}>
        <form ref={ref} action={dispatch} onSubmit={onSubmit} onChange={sync} className="lpg-form__form" aria-busy={pending || undefined} noValidate>
          {Object.keys(errors).length ? (
            <div className="sas-alert sas-alert--danger lpg-form__alert" role="alert" data-form-errors="">
              <span>{errors.form ?? errorTitle}</span>
            </div>
          ) : null}
          <State.Provider value={state}>{children}</State.Provider>
        </form>
        {side}
      </div>
    </DraftProvider>
  );
}

/** The last save's result (null before the first one). */
export const useLeadPageFormState = () => useContext(State);

/** A field's error from the last save (under the field). */
export function FieldError({ name }: { name: string }) {
  const msg = useContext(State)?.errors[name];
  return msg ? <span className="lpg-field__err" role="alert" data-field-error={name}>{msg}</span> : null;
}
