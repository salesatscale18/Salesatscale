/**
 * The words on a fact's source chip (live review 7.1.11): "Pricing and policy"
 * (a note: the sticky-note icon shows the type, R5 S7), "Call · 02:11",
 * "Product sheet · p.2". The full source title stays on hover.
 */
import { t } from "@/lib/i18n";

export function evidenceChipText(link: { kind: string; title: string; locator: string }): string {
  const at = link.locator.trim();
  if (link.kind === "text") return `${link.title}${at && at.toLowerCase() !== "note" ? ` · ${at}` : ""}`;
  if (link.kind === "call") return at ? `${t("sources.kind.call")} · ${at}` : `${t("sources.kind.call")}: ${link.title}`;
  return at ? `${link.title} · ${at}` : link.title;
}
