"use client";

import { createContext, startTransition, useActionState, useContext, type FormEvent, type ReactNode } from "react";
import type { LeadPageFormState } from "./actions";

const Errors = createContext<Record<string, string>>({});

/**
 * The add/edit form: a server action with field errors coming back (no full
 * reload, so what the seller typed stays). Submitted with JS through a
 * transition, which keeps the fields as typed; without JS the browser posts
 * the same action. The pressed button's name/value (Save draft / Go live /
 * Remove banner) goes with the form data.
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
  const errors = state?.errors ?? {};
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => dispatch(data));
  };
  return (
    <form action={dispatch} onSubmit={onSubmit} className={className} aria-busy={pending || undefined} data-pending={pending ? "" : undefined} noValidate>
      {Object.keys(errors).length ? (
        <div className="sas-alert sas-alert--danger" role="alert" data-form-errors="">
          <span>{errors.form ?? errorTitle}</span>
        </div>
      ) : null}
      <Errors.Provider value={errors}>{children}</Errors.Provider>
    </form>
  );
}

/** A field's error from the last save (under the field). */
export function FieldError({ name }: { name: string }) {
  const msg = useContext(Errors)[name];
  return msg ? <span className="lpg-field__err" role="alert" data-field-error={name}>{msg}</span> : null;
}
