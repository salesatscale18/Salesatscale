/**
 * Per-account SMS settings (Settings › Channels), without a schema change: one
 * `channel_connections` row with channel "sms" per account (reach plan §2).
 * - `tester_numbers`: the account's SMS test numbers. In test mode only they
 *   get real SMS. No row = the platform default (SMS_TEST_NUMBERS).
 * - `sender_number` holds a per-account placeholder ("account:<id>"), never a
 *   number: the registered sender is platform-level (TWILIO_SMS_SENDER_NAME).
 * WhatsApp readers filter channel = "whatsapp", so this row never shows there.
 * Scoped by account id everywhere.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { channelConnections } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { normalizePhone } from "@/lib/leads/rules";
import { DEMO_PHONE_RANGE } from "@/lib/demo/phones";

export const SMS_SETTINGS_CHANNEL = "sms";
export const MAX_SMS_TEST_NUMBERS = 10;

const placeholder = (accountId: string) => `account:${accountId}`;

/** The account's own SMS test numbers, or null when it uses the platform default. */
export async function accountSmsTestNumbers(db: Db, accountId: string): Promise<string[] | null> {
  const [row] = await db.select({ numbers: channelConnections.testerNumbers }).from(channelConnections)
    .where(and(eq(channelConnections.accountId, accountId), eq(channelConnections.channel, SMS_SETTINGS_CHANNEL)));
  return row ? row.numbers : null;
}

export type SmsTestNumbersResult =
  | { ok: true; numbers: string[] }
  | { ok: false; reason: "invalid_number" | "demo_number" | "too_many" };

/** Saves the account's SMS test numbers (the whole list). Audited. */
export async function saveSmsTestNumbers(
  db: Db, actor: Actor, account: { id: string; market: string }, raw: readonly string[],
): Promise<SmsTestNumbersResult> {
  const numbers: string[] = [];
  for (const p of raw.map((r) => r.trim()).filter(Boolean)) {
    const n = normalizePhone(p, account.market);
    if (!n) return { ok: false, reason: "invalid_number" };
    // Never send to fictional demo numbers, not even as a tester.
    if (DEMO_PHONE_RANGE.test(n)) return { ok: false, reason: "demo_number" };
    if (!numbers.includes(n)) numbers.push(n);
  }
  if (numbers.length > MAX_SMS_TEST_NUMBERS) return { ok: false, reason: "too_many" };
  const [existing] = await db.select({ id: channelConnections.id }).from(channelConnections)
    .where(and(eq(channelConnections.accountId, account.id), eq(channelConnections.channel, SMS_SETTINGS_CHANNEL)));
  if (existing) {
    await db.update(channelConnections).set({ testerNumbers: numbers })
      .where(and(eq(channelConnections.id, existing.id), eq(channelConnections.accountId, account.id)));
  } else {
    await db.insert(channelConnections).values({
      accountId: account.id, channel: SMS_SETTINGS_CHANNEL, senderNumber: placeholder(account.id), testerNumbers: numbers, createdByUserId: actor.userId,
    }).onConflictDoUpdate({ target: [channelConnections.channel, channelConnections.senderNumber], set: { testerNumbers: numbers } });
  }
  await writeAudit(db, actor, { accountId: account.id, action: "sms.test_numbers_changed", targetType: "account", targetId: account.id, details: { count: numbers.length } });
  return { ok: true, numbers };
}
