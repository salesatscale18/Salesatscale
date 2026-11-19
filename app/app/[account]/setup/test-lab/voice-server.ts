/**
 * Server helpers for test-lab voice calls (not actions: nothing here is
 * callable from the browser).
 */
import { headers } from "next/headers";

/**
 * The relay's address: VOICE_WS_URL when set (the local dev server), else the
 * Vercel route on this host. The host header is used only when it looks like a host.
 */
export async function voiceSocketUrl(env: Record<string, string | undefined> = process.env): Promise<string> {
  const fromEnv = env.VOICE_WS_URL?.trim();
  if (fromEnv) return fromEnv;
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new Error("No valid host for the voice socket");
  return `${proto === "http" ? "ws" : "wss"}://${host}/api/voice/socket`;
}

/** Minor units of the account currency per USD (cost in the account currency, like Sources), or null without a rate. */
export function minorPerUsd(rate: number | null): number | null {
  return rate === null ? null : rate * 100;
}
