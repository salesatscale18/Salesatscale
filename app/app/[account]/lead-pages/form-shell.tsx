"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import type { LeadPageFormState } from "./actions";

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
 */
export function LeadPageFormShell({
  action, errorTitle, children, className,
}: {
  action: (prev: LeadPageFormState, form: FormData) => Promise<LeadPageFormState>;
  errorTitle: string;
  children: ReactNode;
  className?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const errors = state?.errors ?? {};
  const connection = state?.connection;
  useEffect(() => {
    if (!connection || !ref.current) return;
    const radio = Array.from(ref.current.querySelectorAll<HTMLInputElement>('input[name="connection"]')).find((r) => r.value === connection);
    if (radio && !radio.disabled && !radio.checked) radio.checked = true;
  }, [connection, state]);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => dispatch(data));
  };
  return (
    <form ref={ref} action={dispatch} onSubmit={onSubmit} className={className} aria-busy={pending || undefined} data-pending={pending ? "" : undefined} noValidate>
      {Object.keys(errors).length ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-form-errors="">
          <span>{errors.form ?? errorTitle}</span>
        </div>
      ) : null}
      <State.Provider value={state}>{children}</State.Provider>
    </form>
  );
}

/** The last save's result (null before the first one). */
export const useLeadPageFormState = () => useContext(State);

/** A field's error from the last save (under the field). */
export function FieldError({ name }: { name: string }) {
  const msg = useContext(State)?.errors[name];
  return msg ? <span className="lpg-field__err" role="alert" data-field-error={name}>{msg}</span> : null;
}
