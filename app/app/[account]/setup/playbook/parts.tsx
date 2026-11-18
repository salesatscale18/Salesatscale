import type { ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";
import "./playbook.css";

/**
 * The draft banner on every Playbook page (editor, Sales plays, one play, the
 * draft from sources). Test-banner colours with a file icon: the flask is
 * reserved for the test lab.
 */
export function DraftBanner({ draft, live }: { draft: number; live: number | null }) {
  return (
    <div className="sas-banner sas-banner--test" role="status" data-testid="draft-banner">
      <Icon name="file-text" />
      <span className="sas-banner__text">
        <strong>{t("playbook.banner.draft", { version: draft })}</strong>{" "}
        {live ? t("playbook.banner.live", { version: live }) : t("playbook.banner.none_live")}
      </span>
    </div>
  );
}

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
