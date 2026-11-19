"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { timelineCookie } from "@/lib/leads/timeline-fold";

/**
 * The lead timeline folded into one row (W3): chevron, "Timeline", the summary
 * and Show / Hide. It opens in place and remembers the choice in a cookie. The
 * row is a link (`?timeline=open` / `closed`), so it also works without JavaScript.
 */
export function TimelineFold({
  initialOpen, label, summary, showLabel, hideLabel, openHref, closeHref, children,
}: {
  initialOpen: boolean; label: string; summary: string; showLabel: string; hideLabel: string;
  openHref: string; closeHref: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="sas-tl-fold" data-open={open ? "true" : "false"} data-testid="timeline-fold">
      <h2 className="sas-tl-fold__head">
      <a
        className="sas-tl-fold__row" href={open ? closeHref : openHref}
        aria-expanded={open} aria-controls="lead-timeline-list"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          const next = !open;
          setOpen(next);
          try { document.cookie = timelineCookie(next); } catch { /* cookies blocked: still toggles */ }
        }}
      >
        <span className="sas-tl-fold__chevron" aria-hidden="true"><Icon name="chevron-down" /></span>
        <span className="sas-tl-fold__label">{label}</span>
        <span className="sas-tl-fold__summary sas-small">{summary}</span>
        <span className="sas-tl-fold__action">{open ? hideLabel : showLabel}</span>
      </a>
      </h2>
      <div id="lead-timeline-list" className="sas-tl-fold__list" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
