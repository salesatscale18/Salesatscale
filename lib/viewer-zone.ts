/**
 * The viewer's own time zone on seller pages (owner request, 22 Nov): each
 * person on the sales team sees scheduled moments (team calls, callbacks,
 * follow-ups) in their own local time. The browser's IANA zone is kept in the
 * `sas_tz` cookie (components/sas/viewer-zone-cookie.tsx); the server reads
 * it (lib/viewer-zone-server.ts), validates it and falls back to the
 * account's (or the market's) zone. Stored data, the buyer side, contact
 * hours and slot generation never use it. Pure; unit-tested.
 */
import { formatDueLocal } from "@/lib/follow-ups/rules";
import { t } from "@/lib/i18n";

export const VIEWER_TZ_COOKIE = "sas_tz";

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** A valid IANA zone from the cookie (canonical name), or null for anything else. */
export function parseViewerZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    return null;
  }
  if (!v || v.length > 64 || !ZONE_SHAPE.test(v)) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: v }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const wall = (at: Date, zone: string) => formatDueLocal(at, zone);

/** True when the viewer's zone reads another wall-clock time than `fallback` at `at`. */
export function viewerDiffers(at: Date, viewer: string | null | undefined, fallback: string): boolean {
  if (!viewer || viewer === fallback) return false;
  try {
    return wall(at, viewer) !== wall(at, fallback);
  } catch {
    return false;
  }
}

/** The zone a scheduled moment is shown in: the viewer's, else the given (account or market) zone. */
export function shownZone(viewer: string | null | undefined, fallback: string): string {
  return viewer || fallback;
}

/** "Mon 23 Nov 10:00" in the zone the viewer sees. */
export function viewerTime(at: Date, viewer: string | null | undefined, fallback: string): string {
  return formatDueLocal(at, shownZone(viewer, fallback));
}

/** " · your time" after a time shown in the viewer's zone when it differs from `fallback`; "" otherwise. */
export function yourTimeSuffix(at: Date, viewer: string | null | undefined, fallback: string): string {
  return viewerDiffers(at, viewer, fallback) ? ` · ${t("time.your_time")}` : "";
}
