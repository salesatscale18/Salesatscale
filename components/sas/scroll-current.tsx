"use client";

import { useEffect } from "react";

/**
 * Scrolls a sideways chip strip (setup steps, settings sections) so its
 * current item (aria-current) is in view. Only the strip scrolls, never the
 * page. Renders nothing; without JS the strip simply starts at its first item.
 */
export function ScrollCurrentIntoView({ selector }: { selector: string }) {
  useEffect(() => {
    for (const strip of document.querySelectorAll<HTMLElement>(selector)) {
      const cur = strip.querySelector<HTMLElement>("[aria-current]");
      if (!cur || strip.scrollWidth <= strip.clientWidth) continue;
      const s = strip.getBoundingClientRect();
      const c = cur.getBoundingClientRect();
      strip.scrollLeft += c.left - s.left - (s.width - c.width) / 2;
    }
  }, [selector]);
  return null;
}
