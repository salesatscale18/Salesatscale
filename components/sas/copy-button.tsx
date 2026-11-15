"use client";

import { useState } from "react";
import { Icon } from "./icon";
import { buttonClass, type ButtonVariant } from "./primitives";

/** Copies a value; the label switches to "Copied" (UX invite-link spec). */
export function CopyButton({ value, label = "Copy", variant = "secondary" }: { value: string; label?: string; variant?: ButtonVariant }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass(variant, "sm")}
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </button>
  );
}
