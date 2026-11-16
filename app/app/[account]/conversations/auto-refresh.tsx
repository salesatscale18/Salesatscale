"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Light polling for the inbox: re-renders the server page every `intervalMs`
 * while the tab is visible, and once when it becomes visible again. No websockets.
 * Skips a refresh while the person is typing, so a draft is never disturbed.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "submit"));
    };
    const tick = () => {
      if (document.visibilityState === "visible" && !typing()) router.refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);
  return null;
}
