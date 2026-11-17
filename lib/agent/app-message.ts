/**
 * Messages the app writes into a conversation itself (P11.2), as opposed to
 * text the model wrote. They are stored as agent messages; their kind comes
 * from the tool call that wrote them (create_quote's `quote_message_id`), so
 * no extra column is needed. The web chats render both kinds as the designed
 * quote card (lib/agent/quote-card.ts); the stored text stays the fallback and
 * what WhatsApp sends. "quote_held" is the placeholder of a quote waiting for
 * the seller's approval (no numbers; web chats only). Pure: safe in client components.
 */
export type AppMessageKind = "quote" | "quote_held";

type CallLike = { name: string; outcome: string; result: Record<string, unknown> | null | undefined };

/** Message id → kind, from the tool calls of a conversation. */
export function appMessageKinds(calls: readonly CallLike[]): Map<string, AppMessageKind> {
  const out = new Map<string, AppMessageKind>();
  for (const c of calls) {
    const id = c.result?.quote_message_id;
    if (c.name === "create_quote" && c.outcome === "ok" && typeof id === "string") out.set(id, c.result?.quote_held === true ? "quote_held" : "quote");
  }
  return out;
}

/** WhatsApp-style bold (`*text*` on one line) as segments, for the web chats. */
export function boldSegments(body: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /\*([^*\n]+)\*/g;
  let at = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > at) out.push({ text: body.slice(at, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    at = m.index + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at), bold: false });
  return out;
}
