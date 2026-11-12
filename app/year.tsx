"use client";

/** Current year, rendered on the client like the original page did. */
export function Year() {
  return <span suppressHydrationWarning>{new Date().getFullYear()}</span>;
}
