/**
 * The language the app writes to a buyer in, outside a chat turn (SMS, the stop
 * page, the continuation line of a new chat): the conversation's current
 * language (lib/conversations/turn-language.ts: the language of the buyer's
 * latest message, stored on the conversation by each turn), else the lead's
 * latest conversation's, else the lead's stored language (the starting value).
 * Scoped by account. Always one of the platform's buyer languages.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations } from "@/db/schema";
import { isLocale, type Locale } from "@/lib/i18n";

/** A stored language as a buyer locale ("en" when unknown). */
export const buyerLocale = (language: string | null | undefined): Locale => (language && isLocale(language) ? language : "en");

export async function currentBuyerLanguage(
  db: Db, accountId: string, lead: { id: string; language: string | null }, conversationId?: string | null,
): Promise<Locale> {
  if (conversationId) {
    const [c] = await db.select({ language: conversations.language }).from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId), eq(conversations.leadId, lead.id)));
    if (c) return buyerLocale(c.language);
  }
  const [latest] = await db.select({ language: conversations.language }).from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, lead.id), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt)).limit(1);
  return buyerLocale(latest?.language ?? lead.language);
}
