/**
 * "Signed, not paid yet" runner (owner decision 23 Nov 2026; rules in ./unpaid-reminders.ts). Runs on the
 * follow-ups cron (app/api/cron/follow-ups, every minute), across accounts; each order's reads and writes are
 * scoped by that order's own account.
 *
 * For each signed order still waiting for payment (not started or pending; a failed payment and an expected
 * bank transfer already have their own Needs you item), with the account's live playbook settings:
 * - a reminder step that is due goes into the lead's latest chat as one agent message: the reminder line (a
 *   fixed template in the conversation's language, no model call) and the signed form's link, which every chat
 *   shows as the pay card; then the fixed SMS line with the chat link (lib/sms, its modes and caps). Only inside
 *   contact hours and never during a call (both wait for a later run); never once the order is paid, the buyer
 *   wrote back after signing, or a person holds the chat;
 * - "Tell your team" writes the flag event; Needs you shows the order until it is paid (lib/overview/service.ts).
 *
 * Idempotent: each step is a lead event whose id comes from the order and the step, written before anything
 * is sent, so a step goes out at most once per order even when two runs overlap or the settings change later.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lte, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  agentVersions, conversations, leadEvents, leads, messages, orderForms, orders, quotes, sellerAccounts, toolCalls,
  type Conversation, type Lead, type SellerAccount,
} from "@/db/schema";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import type { TwilioTransport } from "@/lib/channels/twilio";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { isWebChat, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { nudgePayReminder } from "@/lib/sms/outbound";
import type { NudgeDeps } from "@/lib/sms/service";
import { activeCallOn } from "@/lib/voice/one-agent";
import { linkFor, orderLabel } from "./service";
import {
  dueReminderStep, reminderBlock, reminderText, teamFlagDue, UNPAID_EVENTS, UNPAID_HORIZON_MS, UNPAID_STATUSES, UNPAID_STEPS, unpaidRemindersOf,
  type PlaybookWithUnpaid, type ReminderStep, type UnpaidReminderSettings, type UnpaidStep,
} from "./unpaid-reminders";

const DAY_MS = 24 * 3_600_000;
/** Orders looked at per run, oldest first. */
const RUN_LIMIT = 500;

/**
 * The lead event id of one order's step: a UUID from sha256("unpaid:<order>:<step>"). Two runs writing the same
 * step collide on the primary key, so the step is written (and its reminder sent) at most once per order.
 */
export function unpaidStepEventId(orderId: string, step: UnpaidStep): string {
  const h = createHash("sha256").update(`unpaid:${orderId}:${step}`).digest("hex").split("");
  h[12] = "8"; // version 8 (custom)
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export type UnpaidRunSummary = { orders: number; reminders: number; flagged: number; deferred: number; stopped: number; skipped: number };

type Candidate = {
  id: string; accountId: string; leadId: string; number: number; amountMinor: number; currency: string;
  formId: string; signedAt: Date | null; createdAt: Date; bankTransfer: string | null; sellerName: string | null;
};

export async function runUnpaidReminders(
  db: Db, transport: TwilioTransport | null, now = new Date(), opts: { sms?: NudgeDeps; limit?: number } = {},
): Promise<UnpaidRunSummary> {
  const summary: UnpaidRunSummary = { orders: 0, reminders: 0, flagged: 0, deferred: 0, stopped: 0, skipped: 0 };
  const rows: Candidate[] = await db.select({
    id: orders.id, accountId: orders.accountId, leadId: orders.leadId, number: orders.number, amountMinor: orders.amountDueMinor,
    currency: orders.currency, formId: orders.orderFormId, signedAt: orderForms.signedAt, createdAt: orders.createdAt,
    // Only this flag of the frozen form, never the whole snapshot.
    bankTransfer: sql<string | null>`${orderForms.snapshot}->'paymentMethods'->>'bankTransfer'`,
    // The trade name frozen on the form: the order number reads as on the pay page and the chat's pay card.
    sellerName: sql<string | null>`${orderForms.snapshot}->'seller'->>'tradeName'`,
  }).from(orders)
    .innerJoin(leads, and(eq(leads.id, orders.leadId), eq(leads.accountId, orders.accountId)))
    .innerJoin(quotes, and(eq(quotes.id, orders.quoteId), eq(quotes.accountId, orders.accountId)))
    .innerJoin(orderForms, and(eq(orderForms.id, orders.orderFormId), eq(orderForms.accountId, orders.accountId)))
    .where(and(
      inArray(orders.paymentStatus, [...UNPAID_STATUSES]), ne(quotes.status, "cancelled"), eq(leads.isTest, false),
      // Signed at least a day ago (the shortest step) and not past the last step a setting can have.
      lte(orders.createdAt, new Date(now.getTime() - DAY_MS)), gte(orders.createdAt, new Date(now.getTime() - UNPAID_HORIZON_MS)),
    ))
    .orderBy(asc(orders.createdAt), asc(orders.id)).limit(opts.limit ?? RUN_LIMIT);
  if (rows.length === 0) return summary;

  // Steps already written, for every candidate in one read (ids derived from order and step).
  const ids = rows.flatMap((o) => UNPAID_STEPS.map((s) => unpaidStepEventId(o.id, s)));
  const done = new Set((await db.select({ id: leadEvents.id }).from(leadEvents).where(inArray(leadEvents.id, ids))).map((r) => r.id));
  const accounts = new Map<string, { account: SellerAccount | null; settings: UnpaidReminderSettings }>();

  for (const o of rows) {
    summary.orders++;
    try {
      if (!accounts.has(o.accountId)) {
        const [[account], [live]] = await Promise.all([
          db.select().from(sellerAccounts).where(eq(sellerAccounts.id, o.accountId)),
          db.select({ playbook: agentVersions.playbook }).from(agentVersions)
            .where(and(eq(agentVersions.accountId, o.accountId), eq(agentVersions.status, "live"))).limit(1),
        ]);
        accounts.set(o.accountId, { account: account ?? null, settings: unpaidRemindersOf(live?.playbook as PlaybookWithUnpaid | undefined) });
      }
      const { account, settings } = accounts.get(o.accountId)!;
      if (!account) continue;
      const signedAt = o.signedAt ?? o.createdAt;
      const written = new Set<UnpaidStep>(UNPAID_STEPS.filter((s) => done.has(unpaidStepEventId(o.id, s))));

      const step = dueReminderStep(settings, signedAt, now, written);
      if (step) {
        const r = await remind(db, transport, account, o, step, settings, signedAt, now, opts.sms ?? {});
        summary[r]++;
        if (r === "reminders") written.add(step);
      }
      if (teamFlagDue(settings, signedAt, now, written)) {
        const remindersSent = (["first", "second"] as const).filter((s) => written.has(s)).length;
        const [ins] = await db.insert(leadEvents).values({
          id: unpaidStepEventId(o.id, "team"), accountId: o.accountId, leadId: o.leadId, type: UNPAID_EVENTS.flagged, actor: "system",
          data: { orderId: o.id, number: o.number, days: settings.team.days, remindersSent }, createdAt: now,
        }).onConflictDoNothing().returning({ id: leadEvents.id });
        if (ins) summary.flagged++;
      }
    } catch (e) {
      // Never the row's data in the log: only that one order failed.
      console.error("[unpaid] an order failed", e instanceof Error ? e.name : "error");
      summary.skipped++;
    }
  }
  return summary;
}

type RemindOutcome = "reminders" | "deferred" | "stopped" | "skipped";

/** One due reminder step of one order: checks, then the claim (the step's event), the message, delivery and the SMS. */
async function remind(
  db: Db, transport: TwilioTransport | null, account: SellerAccount, o: Candidate, step: ReminderStep,
  settings: UnpaidReminderSettings, signedAt: Date, now: Date, smsDeps: NudgeDeps,
): Promise<RemindOutcome> {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, o.leadId), eq(leads.accountId, o.accountId)));
  if (!lead) return "skipped";
  // The lead's latest chat (test-lab chats left out): the reminder goes where the buyer talks to the agent now.
  const [conv]: Conversation[] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, o.accountId), eq(conversations.leadId, o.leadId), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.createdAt), desc(conversations.id)).limit(1);
  const [[wrote], call, contact] = await Promise.all([
    // Anything the buyer said after signing, in any of the lead's chats (typed, or on a call): the buyer is engaged.
    db.select({ id: messages.id }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        eq(messages.accountId, o.accountId), eq(conversations.accountId, o.accountId), eq(conversations.leadId, o.leadId),
        eq(messages.actor, "buyer"), gt(messages.createdAt, signedAt),
      )).limit(1),
    // One agent at a time: nothing is posted while a call holds the conversation (the next run after it sends).
    conv ? activeCallOn(db, o.accountId, conv.id, now) : Promise.resolve(null),
    leadContactSettings(db, account, lead.marketId),
  ]);
  const block = reminderBlock({
    leadOptedOut: lead.status === "opted_out",
    accountStatus: account.status,
    needsLiveAccount: conv?.channel === "whatsapp",
    conversationStatus: conv?.status ?? null,
    personHolds: personHolds(lead),
    buyerWroteAfterSigning: !!wrote,
    callActive: !!call,
    withinContactHours: isWithinContactHours(contact.contactHours, contact.timezone, now),
  });
  if (block) {
    if (block.reason === "call_active" && call) console.info(`[unpaid] deferred: a call is on the conversation (${call.slice(0, 8)})`);
    return block.action === "stop" ? "stopped" : "deferred";
  }
  // WhatsApp free text needs the 24-hour window, which a quiet buyer has closed; templates are not supported yet.
  const windowed = conv.channel === "whatsapp" || (conv.channel === SIMULATOR_CHANNEL && account.simulateWhatsappRules);
  if (windowed && !(await conversationWindow(db, o.accountId, conv.id, now)).open) return "skipped";

  // The claim: the step's event, before anything is sent. Another run that got here first wins.
  const messageId = randomUUID();
  const [claimed] = await db.insert(leadEvents).values({
    id: unpaidStepEventId(o.id, step), accountId: o.accountId, leadId: o.leadId, type: UNPAID_EVENTS.reminder, actor: "agent",
    data: { orderId: o.id, number: o.number, step, days: settings[step].days, conversationId: conv.id, messageId }, createdAt: now,
  }).onConflictDoNothing().returning({ id: leadEvents.id });
  if (!claimed) return "skipped";

  const text = reminderText({
    step, language: conv.language, leadName: lead.fullName, order: orderLabel(o.sellerName || account.tradeName, o.number),
    amountMinor: o.amountMinor, currency: o.currency, bankTransfer: o.bankTransfer === "true",
  });
  // The signed form's link: every chat shows it as the pay card (it opens at the payment step).
  const body = `${text}\n${linkFor({ id: o.formId }).url}`;
  await atomic(db, (q) => [
    // Stored as an agent message the app wrote, so the agent sees it in its history if the buyer replies.
    q.insert(messages).values({ id: messageId, accountId: o.accountId, conversationId: conv.id, actor: "agent", body, language: conv.language, createdAt: now }),
    q.insert(toolCalls).values({
      accountId: o.accountId, conversationId: conv.id, messageId, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: messageId, kind: "pay_reminder", order_id: o.id, step }, outcome: "ok", createdAt: now,
    }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, o.accountId))),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, o.leadId), eq(leads.accountId, o.accountId))),
  ]);
  if (conv.channel === "whatsapp" || isWebChat(conv.channel)) {
    // A failed delivery stays on the message (its state shows in the thread); the step is not sent again.
    await deliverText(db, transport, { accountId: o.accountId, conversationId: conv.id, messageId, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
  }
  // A real buyer's web chat: the fixed SMS line with the chat link (mock by default; the SMS rules decide).
  if (isWebChat(conv.channel) && !conv.isTest) {
    await nudgePayReminder(db, o.accountId, o.leadId, messageId, { ...smsDeps, now }).catch((e) => {
      console.error("[unpaid] SMS failed", e instanceof Error ? e.name : "error");
    });
  }
  return "reminders";
}

/** A person holds the lead: handed to a person (waiting or taken), or a teammate owns it. */
const personHolds = (lead: Pick<Lead, "status" | "ownerUserId">) => lead.status === "human_handling" || !!lead.ownerUserId;
