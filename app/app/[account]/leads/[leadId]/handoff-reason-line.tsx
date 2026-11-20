"use client";

/**
 * O35: the hand-off reason in the lead page's stage banner. One line, cut with "…"; the whole stored
 * reason shows under it only when that line is actually cut (UX):
 * - cut by the 60-character text cut (known on the server, `cut`): the full line is in the server HTML;
 * - cut only by the CSS ellipsis (a narrow screen): a check after layout (scrollWidth > clientWidth,
 *   again on resize) shows it. The `title` alone would not do here: a phone has no hover.
 * Not cut: one line, no second copy.
 */
import { useEffect, useRef, useState } from "react";

export function HandoffReasonLine({ why, full, cut }: { why: string; full: string | null; cut: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (cut || !full || !el) return;
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [cut, full]);
  return (
    <>
      <span ref={ref} className="sas-oneline" data-handoff-why="" dir="auto" title={why}>{why}</span>
      {full && (cut || clipped) ? <span className="sas-small" style={{ display: "block", overflowWrap: "anywhere" }} data-handoff-full="" dir="auto">{full}</span> : null}
    </>
  );
}
