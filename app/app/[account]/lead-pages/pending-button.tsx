"use client";

import { useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button for the page view's small forms (Go live, Pause, Resume, Add / Remove an address,
 * Get a preview link): disabled with a spinner while its form is being sent, so a press always shows
 * that something happens and a second press is not sent.
 */
export function PendingButton({ className, icon, children, ariaLabel }: { className: string; icon?: ReactNode; children: ReactNode; ariaLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending || undefined} aria-label={ariaLabel} data-pending={pending ? "" : undefined}>
      {pending ? <span className="lpg-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/** Drops one-time query parameters (`?created=1`) from the address bar, so a reload does not mark the block again. */
export function ForgetParams({ keys }: { keys: readonly string[] }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const k of keys) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
    if (changed) window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [keys]);
  return null;
}
