"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that shows a pending label while its form posts. Without
 * JavaScript it is a plain submit button (the form still works).
 */
export function SubmitButton({ label, pendingLabel, name, value, className = "b-btn" }: {
  label: string; pendingLabel: string; name?: string; value?: string; className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} className={className} disabled={pending} data-intent={value}>
      {pending ? pendingLabel : label}
    </button>
  );
}
