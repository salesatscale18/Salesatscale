/**
 * Buyer simulator rules (pure; unit-tested). The simulator is a conversation
 * channel ("simulator") whose buyer side is a login-free web chat
 * (`/chat/<token>`) instead of WhatsApp.
 */

export const SIMULATOR_CHANNEL = "simulator";

/**
 * The web chat for real leads (reach plan §1): the same /chat/<token> page as
 * the simulator, on its own channel so the "Simulated" chip, the test banner
 * and "Simulate WhatsApp rules" never apply to a real buyer. Simulated buyers
 * stay on "simulator"; the test lab ("testlab") is separate.
 */
export const WEB_CHAT_CHANNEL = "chat";

/** The channels the buyer chat page shows and writes to. */
export const WEB_CHAT_CHANNELS: readonly string[] = [WEB_CHAT_CHANNEL, SIMULATOR_CHANNEL];

/** True for a conversation the buyer has at /chat/<token>: a real lead's web chat or a simulated chat. */
export const isWebChat = (channel: string | null | undefined): boolean => channel === WEB_CHAT_CHANNEL || channel === SIMULATOR_CHANNEL;

/** The web-chat channel a lead's conversations start on: simulated buyers on "simulator", real leads on "chat". */
export const webChatChannelOf = (lead: { buyerRef?: string | null; phone: string }): string =>
  isSimulatedLead(lead) ? SIMULATOR_CHANNEL : WEB_CHAT_CHANNEL;

/** A chat link stops working this many days after its last activity (user decision, 17 Nov). */
export const CHAT_LINK_IDLE_DAYS = 14;

/** Per-link limits on buyer messages (each one can start a paid agent turn). */
export const CHAT_RATE_PER_MINUTE = 20;
export const CHAT_RATE_PER_DAY = 100;

/**
 * When a chat link expires: CHAT_LINK_IDLE_DAYS after the latest anchor. The
 * anchors are the link's creation, the last message from the buyer or a person
 * on the seller's team, the latest simulator conversation's start, and the due
 * date of a scheduled or sent follow-up, so a link never expires before a
 * call-back the agent agreed with the buyer. Automatic agent messages are not
 * anchors: an agent nudging a silent buyer must not keep a link alive forever.
 */
export function chatLinkExpiresAt(anchors: readonly (Date | null | undefined)[]): Date {
  const latest = Math.max(...anchors.filter((d): d is Date => d instanceof Date).map((d) => d.getTime()));
  if (!Number.isFinite(latest)) return new Date(0);
  return new Date(latest + CHAT_LINK_IDLE_DAYS * 86_400_000);
}

/** Placeholder `leads.phone` of a simulated buyer: never a dialable number (lib/leads/rules normalizePhone refuses it). */
export const SIM_PHONE_PREFIX = "sim:";

export const simulatedPhone = (buyerRef: string) => `${SIM_PHONE_PREFIX}${buyerRef}`;

/** True for a simulated buyer (a buyer ID instead of a phone). Such a lead is never sent anything on WhatsApp. */
export function isSimulatedLead(lead: { buyerRef?: string | null; phone: string }): boolean {
  return !!lead.buyerRef || lead.phone.startsWith(SIM_PHONE_PREFIX);
}

/** "SIM-0001", "SIM-0042", … "SIM-12345". */
export function formatBuyerRef(n: number): string {
  return `SIM-${String(n).padStart(4, "0")}`;
}

/** The next buyer ID after the highest existing one (ignores values that are not SIM-<digits>). */
export function nextBuyerRef(existing: (string | null)[]): string {
  let max = 0;
  for (const r of existing) {
    const m = r ? /^SIM-(\d{1,9})$/.exec(r) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatBuyerRef(max + 1);
}

/** How long after the buyer's last message the chat shows "typing…" while no reply came (an agent turn is running). */
export const TYPING_MS = 90_000;

/** Whether the buyer page shows "typing…": the buyer wrote last, recently, and the agent (not a person) holds the chat. */
export function agentTyping(
  c: { status: string } | null, lastMessage: { actor: string; createdAt: Date } | null, accountStatus: string, now: Date,
): boolean {
  if (!c || c.status !== "open" || accountStatus === "paused" || !lastMessage) return false;
  return lastMessage.actor === "buyer" && now.getTime() - lastMessage.createdAt.getTime() < TYPING_MS;
}

/** Order-form links (`…/f/<token>`) in a message body, in order, without duplicates. */
export function orderFormLinks(body: string): { url: string; token: string }[] {
  const out: { url: string; token: string }[] = [];
  for (const m of body.matchAll(/https?:\/\/[^\s<>()]+?\/f\/([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g)) {
    if (!out.some((o) => o.url === m[0])) out.push({ url: m[0], token: m[1] });
  }
  return out;
}

/**
 * Contrast ratio between two #rrggbb colours (WCAG 2). Used to pick the buyer
 * bubble tint: the brand colour at 12% over white, unless ink on it falls under 4.5:1.
 */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const HEX = /^#[0-9a-f]{6}$/i;
export const INK = "#0f1420";
export const PRIMARY_SOFT = "#e8effc";

/** The brand colour mixed at `alpha` over white, as #rrggbb. */
export function tintOverWhite(brand: string, alpha = 0.12): string {
  const n = parseInt(brand.slice(1), 16);
  const mix = (v: number) => Math.round(255 + (v - 255) * alpha);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => mix(v).toString(16).padStart(2, "0")).join("")}`;
}

/** The buyer bubble colour for a brand colour (UX spec: 12% tint, else primary-soft). */
export function buyerBubbleColor(brand: string | null | undefined): string {
  if (!brand || !HEX.test(brand)) return PRIMARY_SOFT;
  const tint = tintOverWhite(brand);
  return contrastRatio(tint, INK) >= 4.5 ? tint : PRIMARY_SOFT;
}

/** A safe brand colour for inline styles: #rrggbb only. */
export function safeBrand(brand: string | null | undefined, fallback = "#0f6b5a"): string {
  return brand && HEX.test(brand) ? brand : fallback;
}

/**
 * Text colours that stay readable with any seller brand colour (UX, P11 wave 2):
 * `onBrand` is the text on a brand fill (white, or ink when white falls under
 * 4.5:1); `brandText` is brand-coloured text on white (the brand, or ink when
 * the brand falls under 4.5:1 against white).
 */
export function brandTextColors(brand: string | null | undefined): { brand: string; onBrand: string; brandText: string } {
  const b = safeBrand(brand);
  const ok = contrastRatio(b, "#ffffff") >= 4.5;
  return { brand: b, onBrand: ok ? "#ffffff" : INK, brandText: ok ? b : INK };
}
/** CSS custom properties for a brand-coloured root (`prefix` is "--brand" or "--qc-brand"). */
export function brandVars(brand: string | null | undefined, prefix = "--brand"): Record<string, string> {
  const c = brandTextColors(brand);
  return { [prefix]: c.brand, [`${prefix}-on`]: c.onBrand, [`${prefix}-text`]: c.brandText };
}
