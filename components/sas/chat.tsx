import type { ReactNode } from "react";
import { dir, type Locale } from "@/lib/i18n";
import { Chip, StatusPill, type Actor } from "./primitives";
import type { IconName } from "./icon";

/** A trace chip; `outcome` adds a Refused/Failed pill when the tool did not succeed. */
export type TraceItem = { kind: "tool" | "knowledge"; label: string; outcome?: "refused" | "failed" };

/**
 * One chat message. Agent messages may carry a trace (tools and knowledge the
 * agent used); it is seller-only and must never be rendered on buyer pages.
 * `locale` sets dir/lang on the bubble only, so a Hebrew message mirrors
 * inside an English page.
 */
export function ChatMessage({
  actor,
  who,
  time,
  locale = "en",
  trace,
  children,
}: {
  actor: Actor;
  who: string;
  time?: string;
  locale?: Locale;
  trace?: TraceItem[];
  children: ReactNode;
}) {
  return (
    <div className={`sas-msg sas-msg--${actor}`}>
      <div className="sas-msg__meta">
        <span className="sas-msg__who">{who}</span>
        {time ? <span className="sas-msg__time">{time}</span> : null}
      </div>
      <div className="sas-msg__bubble" lang={locale} dir={dir(locale)}>
        {children}
      </div>
      {trace && trace.length > 0 ? (
        <div className="sas-msg__trace">
          {trace.map((item, i) => (
            <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <Chip icon={(item.kind === "tool" ? "wrench" : "book-open") satisfies IconName}>{item.label}</Chip>
              {item.outcome ? <StatusPill object="tool_call" state={item.outcome} /> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatThread({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="sas-chat" aria-label={label}>
      {children}
    </section>
  );
}
