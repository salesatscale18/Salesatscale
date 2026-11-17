import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";

/** Default card (bookmark, grey) or the seller's own card (store, blue). */
export function PlayStatus({ own }: { own: boolean }) {
  return (
    <span
      className="sas-pill" data-play-status={own ? "own" : "default"}
      style={{ flex: "none", ...(own ? { background: "var(--primary-soft)", color: "var(--primary)" } : {}) }}
    >
      <Icon name={own ? "store" : "bookmark"} />{t(own ? "playbook.play.own" : "playbook.play.default")}
    </span>
  );
}

/** The dashed violet "Suggested" tag for items from the knowledge analysis that are not decided yet. */
export function SuggestedTag() {
  return (
    <span data-suggested="" style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, border: "1px dashed var(--agent)", color: "var(--agent)", whiteSpace: "nowrap", flex: "none" }}>
      {t("playbook.suggested")}
    </span>
  );
}
