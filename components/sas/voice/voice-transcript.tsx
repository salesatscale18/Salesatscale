"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { toolChipIcon, toolChipLabel } from "@/components/sas/tool-chip";
import { t } from "@/lib/i18n";
import { MAX_CLIENT_TEXT } from "@/lib/voice/protocol";
import { callClock } from "@/lib/voice/lab";
import type { VoiceItem } from "@/lib/voice/client/state";

/** Within this many px of the bottom the transcript follows new lines; scrolled further up, it stays put. */
const STICK_PX = 48;

/**
 * The live transcript of a call (board VoiceLab): agent lines right and
 * violet, the buyer's left, each with who, the time in the call and a mic
 * mark; tool chips with the thread's own labels; the line being spoken
 * outlined. It follows new lines unless the person scrolled up. The log is
 * not a live region (a screen reader would read every word as it grows);
 * the call bar announces state changes instead.
 */
export function VoiceTranscript({
  items,
  speakingKey,
  canType,
  onSendText,
  buyerLabel,
  emptyText,
  hint,
}: {
  items: VoiceItem[];
  speakingKey: string | null;
  canType: boolean;
  onSendText?: (text: string) => boolean;
  /** "You, as the buyer" in the test lab; "You" on the buyer page. */
  buyerLabel?: string;
  emptyText?: string;
  /** The footer line ("The transcript is written as you talk…"). */
  hint?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow new content only when the person is at the bottom (never fight their scroll).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [items, speakingKey]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stick.current) setBehind(false);
  };
  const jump = () => {
    const el = box.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setBehind(false);
  };
  const send = () => {
    if (!text.trim() || !onSendText) return;
    if (onSendText(text)) setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="sas-vt-wrap">
      <div ref={box} className="sas-vt" role="log" aria-live="off" aria-label={t("voice.transcript.label")} tabIndex={0} onScroll={onScroll} data-voice-transcript="">
        {items.length === 0 && emptyText ? <p className="sas-small sas-vt__empty">{emptyText}</p> : null}
        {items.map((it, i) => {
          if (it.kind === "tool") {
            const failed = it.status === "refused" || it.status === "failed";
            return (
              <span key={it.key} className="sas-vt__tool" data-voice-tool={it.name} data-tool-status={it.status}>
                {it.status === "running" ? <Icon name="loader" /> : <Icon name={toolChipIcon(it.name)} />}
                {it.status === "running" ? `${it.label}…` : toolChipLabel(it.name)}
                {failed ? <StatusPill object="tool_call" state={it.status as "refused" | "failed"} /> : null}
              </span>
            );
          }
          // A continued agent turn (after a chip) shows its who line again only when something else came between.
          const prev = items[i - 1];
          const showWho = !(prev && prev.kind === "line" && prev.turnId === it.turnId);
          return (
            <div key={it.key} className={`sas-vt__item sas-vt__item--${it.role}`} data-voice-line={it.role} data-final={it.final ? "" : undefined}>
              {showWho ? (
                <span className="sas-vt__who">
                  <span className="sas-vt__name">{it.role === "agent" ? t("voice.who.agent") : buyerLabel ?? t("voice.who.buyer")}</span>
                  <span className="sas-num">{callClock(it.atMs / 1000)}</span>
                  {it.typed ? <Icon name="keyboard" label={t("voice.typed")} /> : <Icon name="mic" label={t("voice.spoken")} />}
                </span>
              ) : null}
              <div className={`sas-vt__msg${it.key === speakingKey ? " sas-vt__msg--speaking" : ""}`} dir="auto">{it.text}</div>
            </div>
          );
        })}
      </div>
      {behind ? (
        <button type="button" className={`${buttonClass("secondary", "sm")} sas-vt__jump`} onClick={jump}>
          <Icon name="arrow-down" />{t("voice.transcript.latest")}
        </button>
      ) : null}
      <div className="sas-vt__foot">
        {typing && canType ? (
          <form className="sas-vt__type" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label className="sas-sr" htmlFor="sas-vt-input">{t("voice.type.label")}</label>
            <input
              ref={inputRef} id="sas-vt-input" className="sas-input" value={text} maxLength={MAX_CLIENT_TEXT} autoComplete="off"
              placeholder={t("voice.type.label")} onChange={(e) => setText(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setTyping(false); }}
            />
            <button type="submit" className={buttonClass("primary", "sm")} disabled={!text.trim()}><Icon name="send" />{t("voice.type.send")}</button>
            <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setTyping(false)}>{t("voice.type.hide")}</button>
          </form>
        ) : (
          <>
            <span className="sas-small sas-vt__hint">{hint ?? t("voice.transcript.hint")}</span>
            {canType ? (
              <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setTyping(true)} aria-expanded={false} data-voice-type="">
                <Icon name="keyboard" />{t("voice.type_instead")}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
