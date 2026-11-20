/**
 * The voice relay's address for a request (live voice): VOICE_WS_URL when set
 * (the local dev relay, scripts/voice-dev-server.ts), else the Vercel route on
 * the request's own host. The host header is used only when it looks like a host.
 */
export function voiceSocketUrlFrom(h: Headers, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.VOICE_WS_URL?.trim();
  if (fromEnv) return fromEnv;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new Error("No valid host for the voice socket");
  return `${proto === "http" ? "ws" : "wss"}://${host}/api/voice/socket`;
}
