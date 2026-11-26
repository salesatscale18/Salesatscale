import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { publishAction } from "../test-lab/actions";
import type { DraftBarData } from "./data";
import "./playbook.css";

/** "3 changes not published." / "1 change not published." / "No changes since v4." / "Nothing is live yet." */
export function draftBarText(bar: Pick<DraftBarData, "changes" | "live" | "draftVersion">): { lead: string; rest: string } {
  if (!bar.live || bar.changes === null) return { lead: t("playbook.bar.none_live"), rest: t("playbook.bar.none_live_rest", { version: bar.draftVersion }) };
  if (bar.changes === 0) return { lead: t("playbook.bar.no_changes", { version: bar.live.version }), rest: "" };
  return { lead: t(bar.changes === 1 ? "playbook.bar.changes_one" : "playbook.bar.changes", { n: bar.changes }), rest: t("playbook.bar.still_live", { version: bar.live.version }) };
}

/**
 * The draft bar on the Playbook home, every part and Sales plays (board:
 * PlaybookHome). The count is the number of rows "Compare with live" lists
 * (draftChangeCount). Publish is the test lab's own publish action: the same
 * form, the same checks and the same permissions (it returns to the test lab).
 */
export function DraftBar({ bar }: { bar: DraftBarData }) {
  const text = draftBarText(bar);
  return (
    <section className="pb-draftbar" role="status" aria-label={t("playbook.bar.label", { version: bar.draftVersion })} data-testid="draft-bar" data-changes={bar.changes ?? undefined}>
      <span className="pb-draftbar__mark"><Icon name="file-pen" /><span>{t("playbook.bar.draft", { version: bar.draftVersion })}</span></span>
      <span className="pb-draftbar__text"><strong>{text.lead}</strong>{text.rest ? <> <span className="pb-muted">{text.rest}</span></> : null}</span>
      <span className="pb-draftbar__actions">
        {bar.compareHref ? <a className={buttonClass("secondary", "sm")} href={bar.compareHref} data-compare-with-live="">{t("compare.with_live")}</a> : null}
        {bar.changes === 0 ? (
          // Nothing to publish: Publish stays visible but off (the action and its checks are unchanged).
          <button type="button" className={buttonClass("secondary", "sm")} disabled data-publish="" data-publish-off="">{t("lab.publish", { version: bar.draftVersion })}</button>
        ) : (
          <form action={publishAction}>
            <input type="hidden" name="slug" value={bar.slug} />
            <button type="submit" className={buttonClass("primary", "sm")} data-publish="">{t("lab.publish", { version: bar.draftVersion })}</button>
          </form>
        )}
      </span>
    </section>
  );
}
