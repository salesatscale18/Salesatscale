import type { ReactNode } from "react";
import { dir, t, type Locale } from "@/lib/i18n";
import { agentStepsAction, type StepsScope } from "@/lib/conversations/agent-steps";
import { StatusPill, type Actor } from "./primitives";
import { Icon, type IconName } from "./icon";

/** A trace chip; `outcome` adds a Refused/Failed pill when the tool did not succeed. */
export type TraceItem = { kind: "tool" | "knowledge"; label: string; outcome?: "refused" | "failed"; title?: string; icon?: IconName };

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
  timeTitle,
  locale = "en",
  trace,
  spoken,
  children,
}: {
  actor: Actor;
  who: string;
  time?: string;
  /** The full date and time with the zone, shown on hover. */
  timeTitle?: string;
  locale?: Locale;
  trace?: TraceItem[];
  /** Spoken in a voice call: the time in the call ("0:11"), shown with a mic mark. */
  spoken?: { at: string; label: string; typed?: boolean; title?: string };
  children: ReactNode;
}) {
  return (
    <div className={`sas-msg sas-msg--${actor}`}>
      <div className="sas-msg__meta">
        <span className="sas-msg__who">{who}</span>
        {spoken ? <span className="sas-msg__spoken" title={spoken.title ?? spoken.label} data-spoken=""><Icon name={spoken.typed ? "keyboard" : "mic"} label={spoken.label} /><span className="sas-num">{spoken.at}</span></span> : null}
        {time ? <span className="sas-msg__time" title={timeTitle}>{time}</span> : null}
      </div>
      <div className="sas-msg__bubble" lang={locale} dir={dir(locale)}>
        {children}
      </div>
      {trace && trace.length > 0 ? (
        <div className="sas-msg__trace">
          {trace.map((item, i) => (
            <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title={item.title}>
              {/* Words, not codes: the plain (text font) chip (round-4 review C1, D11). */}
              <span className="sas-chip sas-chip--plain"><Icon name={item.icon ?? ((item.kind === "tool" ? "wrench" : "book-open") satisfies IconName)} />{item.label}</span>
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

/**
 * "Show agent steps" (board ConvSteps): a GET form that works without JS. The
 * route stores the choice (per user, workspace or test lab) and comes back to `back`.
 */
export function AgentStepsSwitch({ slug, scope, show, back }: { slug: string; scope: StepsScope; show: boolean; back: string }) {
  return (
    <form method="get" action={agentStepsAction(slug)} className="sas-steps-switch" data-agent-steps={show ? "on" : "off"}>
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="show" value={show ? "0" : "1"} />
      <input type="hidden" name="back" value={back} />
      <button type="submit" role="switch" aria-checked={show} className="sas-steps-switch__btn">
        <span className="sas-steps-switch__track" aria-hidden="true" />
        <span>{t("conv.steps.show")}</span>
      </button>
    </form>
  );
}

export type MarkerKind = "handoff" | "taken_over" | "handed_back" | "spend_cap" | "voice_started" | "voice_ended" | "chat_opened";
const MARKER_ICON: Record<MarkerKind, IconName> = {
  handoff: "user-plus", taken_over: "user", handed_back: "sparkles", spend_cap: "user-plus", voice_started: "phone-call", voice_ended: "phone-call",
  chat_opened: "eye",
};

/** A centred dashed marker in the thread: "Chat taken over by Dana · 14:02". Shown whether or not the steps are. */
export function ThreadMarkerLine({ kind, text, time, timeTitle, dateTime }: { kind: MarkerKind; text: string; time: string; timeTitle?: string; dateTime?: string }) {
  return (
    <div className="sas-thread-marker" role="note" data-thread-marker={kind}>
      <span className="sas-thread-marker__body">
        <Icon name={MARKER_ICON[kind]} />
        <span>{text}</span>
        <span aria-hidden="true">·</span>
        <time className="sas-num" dateTime={dateTime} title={timeTitle}>{time}</time>
      </span>
    </div>
  );
}
