import type { ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";
import "./playbook.css";

/** Fits a textarea to its text (browsers without `field-sizing: content`). */
function fit(el: HTMLTextAreaElement) {
  if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

/** Props for a textarea that grows with its text instead of cutting it off (with the `pb-grow` class). */
export function growProps() {
  return {
    ref: (el: HTMLTextAreaElement | null) => { if (el) fit(el); },
    onInput: (ev: { currentTarget: HTMLTextAreaElement }) => fit(ev.currentTarget),
  };
}

/**
 * A single-line text in a growing textarea: Enter adds no line break and
 * saves the row, as Enter does in a one-line input (not while an input
 * method is composing).
 */
export function enterSaves(ev: { key: string; shiftKey?: boolean; preventDefault: () => void; currentTarget: HTMLTextAreaElement; nativeEvent?: { isComposing?: boolean } }) {
  if (ev.key !== "Enter" || ev.nativeEvent?.isComposing) return;
  ev.preventDefault();
  ev.currentTarget.form?.requestSubmit();
}

/** The grey "Set by the platform" tag with a lock. */
export function LockTag() {
  return (
    <span className="pb-lock-tag" data-fixed-tag="">
      <Icon name="lock" />{t("playbook.fixed.tag")}
    </span>
  );
}

/** Text the seller cannot change (opener's fixed parts, always-on rules, how the agent introduces itself): a sunken box with the lock tag. */
export function PlatformFixed({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="pb-fixed" id={id} data-platform-fixed="">
      <LockTag />
      <span className="pb-fixed__text">{children}</span>
    </div>
  );
}
