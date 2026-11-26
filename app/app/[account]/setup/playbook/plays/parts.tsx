import { t } from "@/lib/i18n";

/** The dashed violet "Suggested" tag for items from the knowledge analysis that are not decided yet. */
export function SuggestedTag() {
  return (
    <span data-suggested="" style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, border: "1px dashed var(--agent)", color: "var(--agent)", whiteSpace: "nowrap", flex: "none" }}>
      {t("playbook.suggested")}
    </span>
  );
}
