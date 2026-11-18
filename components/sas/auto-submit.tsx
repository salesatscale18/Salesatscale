"use client";

import { useEffect, useRef } from "react";

/**
 * Put inside a GET filter form: a changed select submits the form at once (no
 * Apply button). Without JS the form keeps its submit button in <noscript>.
 */
export function AutoSubmit() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLSelectElement) form.requestSubmit();
    };
    form.addEventListener("change", onChange);
    return () => form.removeEventListener("change", onChange);
  }, []);
  return <span ref={ref} hidden />;
}
