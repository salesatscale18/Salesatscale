import type { CSSProperties } from "react";
import { Icon, type IconName } from "@/components/sas/icon";
import { t } from "@/lib/i18n";

/** Neutral channel pill (artboards SimSeller, SimInbox): sunken background, muted text, 12px semibold. */
const PILL: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, lineHeight: "16px",
  fontWeight: 600, background: "var(--surface-sunken)", color: "var(--ink-muted)", whiteSpace: "nowrap", verticalAlign: "middle", fontFamily: "var(--font-sans)",
};

function ChannelPill({ icon, label }: { icon: IconName; label: string }) {
  return <span className="sas-channel-pill" style={PILL}><Icon name={icon} />{label}</span>;
}

/** "Simulated" (flask icon): a simulated buyer, or a conversation on the buyer simulator channel. */
export function SimulatedChip() {
  return <ChannelPill icon="flask-conical" label={t("sim.chip")} />;
}

/** "WhatsApp" (message-circle), the matching chip for real WhatsApp chats in the inbox. */
export function WhatsAppChip() {
  return <ChannelPill icon="message-circle" label={t("conv.channel.whatsapp")} />;
}

/** "Test lab chat" (flask): a chat with the draft agent on a hidden test lead. The Simulated chip's look, one term (round-3 review A8). */
export function TestLabChip() {
  return <span className="sas-channel-pill" style={PILL} data-test-chat=""><Icon name="flask-conical" />{t("inbox.channel.test")}</span>;
}
