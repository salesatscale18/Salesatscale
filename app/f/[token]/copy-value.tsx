"use client";

import { useState } from "react";

/** A small Copy button for one value on the buyer pages (bank reference, account number). R5-4. */
export function CopyValue({ value, label, copied, name }: { value: string; label: string; copied: string; name: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="b-copy" aria-label={`${label}: ${name}`} aria-live="polite" data-copy={value}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); } catch { setDone(false); }
      }}
    >
      {done ? copied : label}
    </button>
  );
}
