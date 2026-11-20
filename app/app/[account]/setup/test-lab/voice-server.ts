/**
 * Server helpers for test-lab voice calls (not actions: nothing here is
 * callable from the browser).
 */
import { headers } from "next/headers";
import { voiceSocketUrlFrom } from "@/lib/voice/ws-url";

/** The relay's address for this request (lib/voice/ws-url.ts). */
export async function voiceSocketUrl(env: Record<string, string | undefined> = process.env): Promise<string> {
  return voiceSocketUrlFrom(await headers(), env);
}

/** Minor units of the account currency per USD (cost in the account currency, like Sources), or null without a rate. */
export function minorPerUsd(rate: number | null): number | null {
  return rate === null ? null : rate * 100;
}
