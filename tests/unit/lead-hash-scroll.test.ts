/**
 * Phone deep link (Needs you "Open lead" / "Confirm time" → `?tab=deal#after-call` / `#callback`):
 * the lead page streams in, so the browser's own jump to the hash finds the card before it is
 * laid out and the page stays at the top. ScrollLeadToHash scrolls it into view once the page is
 * in place, showing its tab first when needed. Fake elements; no DOM.
 */
import { describe, expect, it, vi } from "vitest";
import { openAtHash, scrollToHashTarget } from "@/app/app/[account]/leads/[leadId]/scroll-latest";

type Radio = { checked: boolean };
/** A lead page with the three phone tab radios; `shown(tab)` says whether a panel is laid out. */
function fakePage(checked: "chat" | "deal" | "timeline") {
  const radios: Record<string, Radio> = { chat: { checked: checked === "chat" }, deal: { checked: checked === "deal" }, timeline: { checked: checked === "timeline" } };
  const shown = (tab: string) => radios[tab].checked;
  const el = (panel: { dataTab?: string; side?: boolean }) => ({
    scrollIntoView: vi.fn(),
    getClientRects: () => ({ length: shown(panel.dataTab ?? "deal") ? 1 : 0 }),
    closest: (sel: string) =>
      sel === "[data-tab]" && panel.dataTab ? { getAttribute: () => panel.dataTab! }
        : sel === ".sas-lead__side" && panel.side ? { getAttribute: () => null }
          : null,
  });
  const els: Record<string, ReturnType<typeof el>> = {
    "after-call": el({ side: true }),
    callback: el({ side: true }),
    "lead-timeline": el({ dataTab: "timeline" }),
  };
  const doc = { getElementById: (id: string) => els[id] ?? (id.startsWith("lt-") ? radios[id.slice(3)] ?? null : null) };
  return { doc, els, radios };
}

describe("lead page: open at the #hash card", () => {
  it("scrolls the after-call card into view on the Deal tab (block start, so scroll-margin-top applies)", () => {
    const { doc, els, radios } = fakePage("deal");
    expect(scrollToHashTarget(doc, "#after-call")).toBe("scrolled");
    expect(els["after-call"].scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(radios.deal.checked).toBe(true);
  });

  it("shows the Deal tab first when the card sits in a hidden tab (#callback without ?tab=deal)", () => {
    const { doc, els, radios } = fakePage("chat");
    expect(scrollToHashTarget(doc, "#callback")).toBe("scrolled");
    expect(radios.deal.checked).toBe(true);
    expect(els.callback.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("takes the tab from the panel's data-tab", () => {
    const { doc, els, radios } = fakePage("chat");
    expect(scrollToHashTarget(doc, "#lead-timeline")).toBe("scrolled");
    expect(radios.timeline.checked).toBe(true);
    expect(els["lead-timeline"].scrollIntoView).toHaveBeenCalledOnce();
  });

  it("does nothing for an unknown, empty or broken hash, or a target that stays hidden", () => {
    const { doc, els } = fakePage("deal");
    expect(scrollToHashTarget(doc, "#nope")).toBeNull();
    expect(scrollToHashTarget(doc, "#")).toBeNull();
    expect(scrollToHashTarget(doc, "#%E0%A4%A")).toBeNull();
    const hidden = { scrollIntoView: vi.fn(), getClientRects: () => ({ length: 0 }), closest: () => null };
    expect(scrollToHashTarget({ getElementById: (id) => (id === "x" ? hidden : null) }, "#x")).toBeNull();
    expect(hidden.scrollIntoView).not.toHaveBeenCalled();
    expect(els["after-call"].scrollIntoView).not.toHaveBeenCalled();
  });

  it("the effect runs only with a hash, so the phone still opens at the latest message without one", () => {
    const { doc, els, radios } = fakePage("chat");
    const getElementById = vi.fn(doc.getElementById);
    expect(openAtHash({ location: { hash: "" }, document: { getElementById } })).toBeNull();
    expect(getElementById).not.toHaveBeenCalled();
    expect(radios.chat.checked).toBe(true);
    expect(openAtHash({ location: { hash: "#after-call" }, document: doc })).toBe("scrolled");
    expect(els["after-call"].scrollIntoView).toHaveBeenCalledOnce();
  });
});
