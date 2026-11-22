"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const COOKIE = "sas_tz";

/**
 * Keeps the browser's IANA time zone in the `sas_tz` cookie, so seller pages
 * show scheduled moments in the viewer's own local time (lib/viewer-zone.ts).
 * Refreshes once when the cookie was missing or changed. Renders nothing.
 */
export function ViewerZoneCookie() {
  const router = useRouter();
  useEffect(() => {
    let zone = "";
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return;
    }
    if (!zone) return;
    const current = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    let decoded = current;
    try {
      decoded = current ? decodeURIComponent(current) : current;
    } catch {
      decoded = undefined;
    }
    if (decoded === zone) return;
    document.cookie = `${COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
    router.refresh();
  }, [router]);
  return null;
}
