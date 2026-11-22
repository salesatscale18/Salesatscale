import { cookies } from "next/headers";
import { parseViewerZone, VIEWER_TZ_COOKIE } from "./viewer-zone";

/** The viewer's own IANA zone from the `sas_tz` cookie, or null (no cookie, or not a valid zone: the caller falls back to the account's). */
export async function readViewerZone(): Promise<string | null> {
  try {
    return parseViewerZone((await cookies()).get(VIEWER_TZ_COOKIE)?.value);
  } catch {
    return null;
  }
}
