"use client";

/**
 * The Back sheet (board VoiceBubbleBack 2 and 3): during a call, "End the call?" (buyers and the test lab alike; owner,
 * 26 Nov: End call replaced "Switch to text" in the buyer's voice UI, and still means the voice stops and the chat goes
 * on); "Leave the chat?" in the text chat.
 * An alertdialog over a scrim, from the bottom: focus moves to the safe choice (Keep talking, Stay in the chat) and
 * stays inside; Escape and a tap on the scrim are the safe choice. Opened by lib/voice/client/back-guard.ts.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Icon } from "@/components/sas/icon";
import type { Tr } from "@/lib/voice/client/buyer-ui";
import type { GuardAsk, GuardChoice } from "@/lib/voice/client/back-guard";
import "./leave-sheet.css";

export function LeaveSheet({ ask, tr, dir, onChoose }: {
  ask: GuardAsk; tr: Tr; dir: "ltr" | "rtl"; onChoose: (c: GuardChoice) => void;
  /** Was "text" | "end" (buyers' Switch to text? words): one set of words now; still accepted from the test lab. */
  callWords?: "end";
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const back = useRef<Element | null>(null);
  useEffect(() => {
    back.current = document.activeElement;
    safe.current?.focus();
    // Focus goes back where it was when the sheet closes (the element may be gone: then nowhere).
    return () => (back.current as HTMLElement | null)?.focus?.();
  }, [ask]);
  const end = ask === "end_call";
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onChoose("stay");
      return;
    }
    if (e.key !== "Tab") return;
    // The focus trap: Tab and Shift+Tab cycle through the sheet's buttons.
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
    e.preventDefault();
    items[next].focus();
  };
  const safeButton = (
    <button key="safe" ref={safe} type="button" className={`ls-btn ${end ? "ls-btn--secondary" : "ls-btn--primary"}`} onClick={() => onChoose("stay")} data-sheet-safe="">
      {tr(end ? "buyer.voice.sheet.end.keep" : "buyer.voice.sheet.leave.stay")}
    </button>
  );
  const goButton = end ? (
    <button key="go" type="button" className="ls-btn ls-btn--danger" onClick={() => onChoose("end_call")} data-sheet-end="">
      <Icon name="phone-off" />{tr("buyer.voice.end_call")}
    </button>
  ) : (
    <button key="go" type="button" className="ls-btn ls-btn--ghost" onClick={() => onChoose("leave")} data-sheet-leave="">
      {tr("buyer.voice.sheet.leave.leave")}
    </button>
  );
  return (
    <div className="ls" dir={dir} data-leave-sheet={ask}>
      <div className="ls-scrim" aria-hidden="true" onClick={() => onChoose("stay")} />
      <div
        ref={box} className="ls-sheet" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} onKeyDown={onKey}
      >
        <h2 className="ls-title" id={`${id}-t`}>{tr(end ? "buyer.voice.sheet.end.title" : "buyer.voice.sheet.leave.title")}</h2>
        <p className="ls-body" id={`${id}-d`}>{tr(end ? "buyer.voice.sheet.end.body" : "buyer.voice.sheet.leave.body")}</p>
        {/* End call over Keep talking; Stay in the chat over Leave. */}
        {end ? [goButton, safeButton] : [safeButton, goButton]}
      </div>
    </div>
  );
}
