import { Fragment } from "react";
import { boldSegments, type AppMessageKind } from "@/lib/agent/app-message";

/**
 * A chat message body. Messages the app wrote itself (the quote message) carry
 * a kind and show their WhatsApp-style `*bold*` lines in bold; everything else
 * is plain text, as before.
 */
export function MessageBody({ body, kind }: { body: string; kind?: AppMessageKind }) {
  if (!kind) return <>{body}</>;
  return (
    <span data-kind={kind}>
      {boldSegments(body).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>))}
    </span>
  );
}
