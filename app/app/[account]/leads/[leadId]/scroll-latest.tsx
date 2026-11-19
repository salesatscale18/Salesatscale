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
