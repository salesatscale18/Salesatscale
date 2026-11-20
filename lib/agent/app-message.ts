/**
 * Messages the app writes into a conversation itself (P11.2), as opposed to
 * text the model wrote. They are stored as agent messages; their kind comes
 * from the tool call that wrote them (create_quote's `quote_message_id`), so
 * no extra column is needed. The web chats render both kinds as the designed
 * quote card (lib/agent/quote-card.ts); the stored text stays the fallback and
 * what WhatsApp sends. "quote_held" is the placeholder of a quote waiting for
 * the seller's approval (no numbers; web chats only).
 *
 * After a seller approves a held quote (lib/agent/quote-approval.ts), the app
 * writes the next step itself, with no model turn: "quote_offer" ("The team
 * can offer 5%…", before an in-limit card) and "quote_close" ("If this looks
 * right, I'll send the order form now…"). Those, and a quote card the app
 * sends then, are linked by an `app_message` row in tool_calls (no tool the
 * model can call; left out of the trace). "follow_up" is the agreed follow-up
 * the platform scheduler sends (lib/follow-ups/scheduler.ts). "callback" tells
 * the buyer the call time the seller confirmed or changed (lib/callbacks,
 * O6). Pure: safe in client components.
 */
export type AppMessageKind = "quote" | "quote_held" | "quote_close" | "quote_offer" | "follow_up" | "callback";

/** The tool_calls name of a message the app wrote outside a model turn. */
export const APP_MESSAGE_CALL = "app_message";
const APP_KINDS: readonly string[] = ["quote", "quote_close", "quote_offer", "follow_up", "callback"];

/** Plain text the app wrote (not a quote card): shown as "Sent by the app" in seller views. */
export const isAppText = (k: AppMessageKind | undefined) => k === "quote_close" || k === "quote_offer" || k === "follow_up" || k === "callback";

type CallLike = { name: string; outcome: string; result: Record<string, unknown> | null | undefined };

/** Message id → kind, from the tool calls of a conversation. */
export function appMessageKinds(calls: readonly CallLike[]): Map<string, AppMessageKind> {
  const out = new Map<string, AppMessageKind>();
  for (const c of calls) {
    const id = c.result?.quote_message_id;
    if (c.name === "create_quote" && c.outcome === "ok" && typeof id === "string") out.set(id, c.result?.quote_held === true ? "quote_held" : "quote");
    const appId = c.result?.message_id;
    const kind = c.result?.kind;
    if (c.name === APP_MESSAGE_CALL && typeof appId === "string" && typeof kind === "string" && APP_KINDS.includes(kind)) out.set(appId, kind as AppMessageKind);
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
