/**
 * Fictional phone numbers of the one-click demo account (lib/demo/seed.ts).
 * Pure: imported by the WhatsApp senders, so it must stay free of I/O.
 *
 * Israel has no reserved "fictional" mobile range, so a number like
 * +972 50-555-0101 could belong to a real person. Demo leads therefore carry
 * two markers, and every WhatsApp send path (lib/channels/whatsapp.ts)
 * refuses a lead that has both, as it refuses a test lead:
 * - the phone is in DEMO_PHONE_RANGE (+972 50-555-0100 to 0199), and
 * - the source ID starts with DEMO_SOURCE_REF_PREFIX (set only by the seed).
 * A real buyer with such a number in a real account has no demo source ID,
 * so nothing changes for them.
 */
export const DEMO_SOURCE_REF_PREFIX = "demo-seed:";

/** +972 50-555-01xx: the only numbers the seed hands out. */
export const DEMO_PHONE_RANGE = /^\+9725055501\d{2}$/;

/** The seed's n-th fictional lead number (1–99). */
export function demoPhone(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error("Demo phone numbers go from 1 to 99.");
  return `+97250555${String(100 + n).padStart(4, "0")}`;
}

/** True for a lead the demo seed created with a fictional number: never contacted. */
export function isFictionalDemoLead(lead: { phone: string; sourceRef: string | null }): boolean {
  return DEMO_PHONE_RANGE.test(lead.phone) && !!lead.sourceRef?.startsWith(DEMO_SOURCE_REF_PREFIX);
}
