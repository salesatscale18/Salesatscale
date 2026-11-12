import type { ReactNode } from "react";
import { dir, type Locale } from "@/lib/i18n";
import { Chip, type Actor } from "./primitives";
import type { IconName } from "./icon";

export type TraceItem = { kind: "tool" | "knowledge"; label: string };

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
            <Chip key={i} icon={(item.kind === "tool" ? "wrench" : "book-open") satisfies IconName}>
              {item.label}
            </Chip>
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
