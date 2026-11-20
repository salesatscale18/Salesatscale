"use client";

import { useEffect } from "react";
import { scrollThreadToEnd } from "../../conversations/scroll-end";

/**
 * Phone: the lead page opens at the latest chat message, not at the top of the
 * lead (R5-17). Only on first load, only on a phone (the Chat tab is the one
 * shown) and only when the URL does not ask for another place (#hash).
 */
export function ScrollLeadToLatest() {
  useEffect(() => {
    if (window.location.hash) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    scrollThreadToEnd(document.querySelector<HTMLElement>("#conversation .sas-chat"));
  }, []);
  return null;
}

type Target = {
  getClientRects(): { length: number };
  scrollIntoView(o?: ScrollIntoViewOptions): void;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
};
type Doc = { getElementById(id: string): unknown };

/**
 * The lead page streams in behind `leads/loading.tsx`: when the browser makes its
 * own jump to `#after-call` / `#callback`, only the skeleton is on screen and the
 * card is not laid out yet, so the page stays at the top. Once the page is in
 * place: show the tab that holds the target if it is hidden (phone tabs are radio
 * inputs), then scroll it into view; the card's `scroll-margin-top` keeps it below
 * the top bar and the sticky tabs. Pure enough to unit-test with fake elements.
 */
export function scrollToHashTarget(doc: Doc, hash: string): "scrolled" | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  if (!id) return null;
  const el = doc.getElementById(id) as Target | null;
  if (!el) return null;
  if (el.getClientRects().length === 0) {
    const tab = el.closest("[data-tab]")?.getAttribute("data-tab")?.split(/\s+/)[0] ?? (el.closest(".sas-lead__side") ? "deal" : null);
    const radio = tab ? (doc.getElementById(`lt-${tab}`) as { checked: boolean } | null) : null;
    if (radio && !radio.checked) radio.checked = true;
    if (el.getClientRects().length === 0) return null;
  }
  el.scrollIntoView({ block: "start" });
  return "scrolled";
}

/** The effect's body: nothing without a #hash, so the phone's open-at-latest-message (ScrollLeadToLatest) stays. */
export function openAtHash(win: { location: { hash: string }; document: Doc }): "scrolled" | null {
  if (!win.location.hash) return null;
  return scrollToHashTarget(win.document, win.location.hash);
}

/** With a #hash (Needs you's call links), the lead page opens at that card, once, after it is in place. */
export function ScrollLeadToHash() {
  useEffect(() => {
    openAtHash(window);
  }, []);
  return null;
}
