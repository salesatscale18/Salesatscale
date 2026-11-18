/**
 * R3-8 UX follow-ups: "Contact hours" on an outside-contact-hours refusal goes
 * to the lead's market's own hours on the Markets page when the market sets
 * them, else to Settings › hours; the source type icons.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/app/[account]/leads/[leadId]/actions", () => ({ startWhatsAppAction: async () => {} }));
vi.mock("@/app/app/[account]/leads/[leadId]/simulator-actions", () => ({
  createChatLinkAction: async () => {}, resetChatLinkAction: async () => {}, startSimulatorAction: async () => {},
}));

const { contactHoursFixHref } = await import("@/lib/markets/lead-settings");
const { WhatsAppStart } = await import("@/app/app/[account]/leads/[leadId]/whatsapp-start");
const { SimulatorPanel } = await import("@/app/app/[account]/leads/[leadId]/simulator-panel");
const { KIND_ICON } = await import("@/app/app/[account]/setup/sources/view");
const { Icon } = await import("@/components/sas/icon");

const HOURS = Array.from({ length: 7 }, (_, i) => ({ on: i > 0 && i < 6, from: "09:00", to: "17:00" }));
const fixLink = (html: string) => html.match(/<a href="([^"]+)" data-fix-hours="">Contact hours<\/a>/)?.[1];

describe("fix hours link", () => {
  it("goes to the market's contact hours row when the lead's market sets its own hours", () => {
    expect(contactHoursFixHref("polar", { id: "m1", overrides: { contactHours: HOURS } })).toBe("/app/polar/markets?m=m1&override=contactHours#set-contactHours");
    // Only its own time zone: the hours are read there, so the time zone row.
    expect(contactHoursFixHref("polar", { id: "m1", overrides: { timezone: "America/New_York" } })).toBe("/app/polar/markets?m=m1&override=timezone#set-timezone");
  });

  it("goes to Settings › hours for a market that follows the account, or a lead with no market", () => {
    expect(contactHoursFixHref("polar", { id: "m1", overrides: {} })).toBe("/app/polar/settings?section=hours");
    expect(contactHoursFixHref("polar", { id: "m1", overrides: { languages: ["en"] } })).toBe("/app/polar/settings?section=hours");
    expect(contactHoursFixHref("polar", null)).toBe("/app/polar/settings?section=hours");
  });

  it("WhatsApp start and the simulator panel use it", () => {
    const href = "/app/polar/markets?m=m1&override=contactHours#set-contactHours";
    const wa = renderToStaticMarkup(<WhatsAppStart slug="polar" leadId="l1" refusal="outside_contact_hours" templateName={null} buyerName="Dana" hoursHref={href} />);
    expect(fixLink(wa)).toBe(href.replace(/&/g, "&amp;"));
    const waDefault = renderToStaticMarkup(<WhatsAppStart slug="polar" leadId="l1" refusal="outside_contact_hours" templateName={null} buyerName="Dana" />);
    expect(fixLink(waDefault)).toBe("/app/polar/settings?section=hours");
    const sim = renderToStaticMarkup(<SimulatorPanel slug="polar" leadId="l1" simulated url="https://example.test/c/x" refusal="outside_contact_hours" rules hoursHref={href} />);
    expect(fixLink(sim)).toBe(href.replace(/&/g, "&amp;"));
  });
});

describe("source type icons", () => {
  it("Website = globe, File = file-text, Note = sticky-note, Call = phone-call", () => {
    expect(KIND_ICON).toEqual({ website: "globe", file: "file-text", text: "sticky-note", call: "phone-call" });
    for (const name of ["globe", "sticky-note", "phone-call"] as const) {
      expect(renderToStaticMarkup(<Icon name={name} />)).toContain(`lucide-${name}`);
    }
  });
});
