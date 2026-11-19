/**
 * A tool's chip in a seller's thread: its plain past-tense label ("Deal
 * details updated", never the internal name) and its icon. Shared by the
 * saved thread (leads/[leadId]/conversation.tsx) and the live call transcript
 * (components/sas/voice), so both read the same. Import-safe from server and
 * client code.
 */
import { messages, t, type MessageKey } from "@/lib/i18n";
import type { IconName } from "./icon";

/** The timeline's icon for the same event, where there is one (S3), plus deal details and fit; other tools keep the wrench. */
export const TOOL_ICON: Record<string, IconName> = {
  update_deal_state: "clipboard-list",
  check_fit: "list-checks",
  hand_off_to_human: "user",
  send_order_form: "send",
  create_quote: "file-text",
  schedule_follow_up: "clock",
  record_opt_out: "x-circle",
};

/** A tool's plain label ("Quote created"), or "Tool used" for one without a label. */
export function toolChipLabel(name: string): string {
  return messages.en[`conv.tool.${name}` as MessageKey] ?? t("conv.tool.other");
}

/** The chip's icon: the tool's own, knowledge's book, else the wrench. */
export function toolChipIcon(name: string): IconName {
  return TOOL_ICON[name] ?? (name === "lookup_knowledge" ? "book-open" : "wrench");
}
