/**
 * The facts the Conversations list previews need (lib/conversations/preview.ts),
 * for one page of rows in two queries at most: which last messages are quote
 * cards (create_quote / the app's quote message tool calls), and the order-form
 * link previews (the thread's form card data). Scoped by account id.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { toolCalls } from "@/db/schema";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { quoteCardLinks } from "@/lib/agent/quote-card";
import { linkPreviews } from "@/lib/simulator/service";
import type { PreviewFacts } from "./preview";

type Row = { conversationId: string; lastMessageId: string | null; lastActor: string | null; lastBody: string | null };

/** Preview facts by last message id. Buyers' own messages never get a card. */
export async function previewFacts(db: Db, accountId: string, rows: readonly Row[], now = new Date()): Promise<Map<string, PreviewFacts>> {
  const seller = rows.filter((r): r is Row & { lastMessageId: string; lastBody: string } => !!r.lastMessageId && !!r.lastBody && r.lastActor !== "buyer");
  const out = new Map<string, PreviewFacts>();
  if (!seller.length) return out;
  const withLinks = seller.filter((r) => r.lastBody.includes("/f/"));
  const [calls, forms] = await Promise.all([
    db.select({ name: toolCalls.name, outcome: toolCalls.outcome, result: toolCalls.result, conversationId: toolCalls.conversationId })
      .from(toolCalls)
      .where(and(
        eq(toolCalls.accountId, accountId), inArray(toolCalls.conversationId, [...new Set(seller.map((r) => r.conversationId))]),
        inArray(toolCalls.name, ["create_quote", APP_MESSAGE_CALL]), eq(toolCalls.outcome, "ok"),
      )),
    // The list is in English; the language only picks the seller's display name, which the preview does not show.
    withLinks.length ? linkPreviews(db, accountId, withLinks.map((r) => r.lastBody), "en", now) : Promise.resolve(new Map()),
  ]);
  const quoteOf = new Map(quoteCardLinks(calls).map((l) => [l.messageId, { number: l.number, version: l.version }]));
  for (const r of seller) {
    const quote = quoteOf.get(r.lastMessageId) ?? null;
    if (quote || forms.size) out.set(r.lastMessageId, { quote, forms });
  }
  return out;
}
