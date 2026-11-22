/**
 * The Back sheets (components/sas/voice/leave-sheet.tsx) and the bubble menu's order (components/sas/voice/voice-bubble.tsx
 * BubbleMenu), rendered on the server. Focus, the trap, Escape and the scrim are driven in Chromium by
 * tests/e2e/voice/back-sheet-shots.ts.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaveSheet } from "@/components/sas/voice/leave-sheet";
import { BubbleMenu } from "@/components/sas/voice/voice-bubble";
import { translator } from "@/lib/i18n";
import { bubbleView } from "@/lib/voice/client/bubble";
import type { MirrorState } from "@/lib/voice/client/tab-link";

const en = translator("en");
const he = translator("he");
const text = (html: string) => html.replace(/<[^>]+>/g, "|").split("|").map((x) => x.trim()).filter(Boolean);

describe("the Back sheets", () => {
  it("buyers during a call: Switch to text? (an alertdialog, modal, named and described); Switch to text (primary, keyboard) then Stay in voice (the safe choice)", () => {
    const html = renderToStaticMarkup(<LeaveSheet ask="end_call" tr={en} dir="ltr" onChoose={() => {}} />);
    expect(html).toMatch(/role="alertdialog" aria-modal="true" aria-labelledby="([^"]+)-t" aria-describedby="\1-d"/);
    expect(text(html)).toEqual(["Switch to text?", "The conversation continues here in writing. You can switch back to voice any time.", "Switch to text", "Stay in voice"]);
    expect(html).toMatch(/class="ls-btn ls-btn--primary" data-sheet-end=""><svg[^>]*class="lucide lucide-keyboard sas-ico"/);
    expect(html).toMatch(/class="ls-btn ls-btn--secondary"[^>]*data-sheet-safe="">Stay in voice/);
    expect(html).not.toMatch(/phone-off|danger/);
    // The scrim is decoration for assistive technology.
    expect(html).toContain('<div class="ls-scrim" aria-hidden="true"></div>');
  });

  it("the test lab during a call: End the call?; End call (red, phone-off) then Keep talking (the safe choice)", () => {
    const html = renderToStaticMarkup(<LeaveSheet ask="end_call" tr={en} dir="ltr" onChoose={() => {}} callWords="end" />);
    expect(html).toMatch(/role="alertdialog" aria-modal="true" aria-labelledby="([^"]+)-t" aria-describedby="\1-d"/);
    expect(text(html)).toEqual(["End the call?", "You&#x27;ll stay in the chat and can switch to voice again any time.", "End call", "Keep talking"]);
    expect(html).toMatch(/class="ls-btn ls-btn--danger" data-sheet-end=""><svg[^>]*class="lucide lucide-phone-off sas-ico"/);
    expect(html).toMatch(/class="ls-btn ls-btn--secondary"[^>]*data-sheet-safe="">Keep talking/);
  });

  it("Leave the chat?: Stay in the chat (primary, the safe choice) then Leave", () => {
    const html = renderToStaticMarkup(<LeaveSheet ask="leave_chat" tr={en} dir="ltr" onChoose={() => {}} />);
    expect(text(html)).toEqual(["Leave the chat?", "Your chat is saved. You can come back any time with the same link.", "Stay in the chat", "Leave"]);
    expect(html).toMatch(/class="ls-btn ls-btn--primary"[^>]*data-sheet-safe="">Stay in the chat/);
    expect(html).toMatch(/class="ls-btn ls-btn--ghost"[^>]*data-sheet-leave="">Leave/);
  });

  it("Hebrew: the owner's wording, right to left", () => {
    const end = renderToStaticMarkup(<LeaveSheet ask="end_call" tr={he} dir="rtl" onChoose={() => {}} />);
    expect(end).toContain('dir="rtl"');
    expect(text(end)).toEqual(["לעבור לכתיבה?", "השיחה ממשיכה כאן בכתב. אפשר לחזור לקול בכל רגע.", "מעבר לכתיבה", "להישאר בקול"]);
    const leave = renderToStaticMarkup(<LeaveSheet ask="leave_chat" tr={he} dir="rtl" onChoose={() => {}} />);
    expect(text(leave)).toEqual(["לצאת מהצ&#x27;אט?", "הצ&#x27;אט נשמר. אפשר לחזור בכל רגע עם אותו קישור.", "להישאר בצ&#x27;אט", "יציאה"]);
  });
});

describe("the bubble menu", () => {
  const base: MirrorState = { phase: "live", live: "speaking", muted: false, endReason: null, mic: 0, out: 0, caption: null, secondsLeft: 268, outputs: [], output: null };
  const items = (s: MirrorState, tr = en) => {
    const html = renderToStaticMarkup(<BubbleMenu id="m" state={s} view={bubbleView(s, tr, "Maya")} tr={tr} act={() => {}} />);
    return [...html.matchAll(/data-bubble-(?!menu)(\w+)=""|role="separator"|class="vb-menu__state"/g)].map((m) => m[1] ?? (m[0].startsWith("role") ? "divider" : "state"));
  };

  it("state and time left, Mute, Speaker, a divider, Switch to text (last, keyboard, normal colour)", () => {
    const two = { ...base, outputs: [{ id: "a", label: "Default" }, { id: "b", label: "Headphones" }] } as MirrorState;
    expect(items(two)).toEqual(["state", "mute", "speaker", "divider", "end"]);
    const html = renderToStaticMarkup(<BubbleMenu id="m" state={two} view={bubbleView(two, en, "Maya")} tr={en} act={() => {}} />);
    expect(html).toMatch(/class="vb-item vb-item--end" data-bubble-end=""><svg[^>]*lucide-keyboard[^>]*>.*<\/svg>Switch to text<\/button><\/div>$/);
    expect(html).toContain("4:28 left");
    expect(items(base)).toEqual(["state", "mute", "divider", "end"]);
  });

  it("on standby, Talk to the agent stays first; Hebrew Switch to text", () => {
    const standby = { ...base, live: "standby" } as MirrorState;
    expect(items(standby)).toEqual(["state", "wake", "mute", "divider", "end"]);
    const html = renderToStaticMarkup(<BubbleMenu id="m" state={base} view={bubbleView(base, he, "Maya")} tr={he} act={() => {}} />);
    expect(html).toContain("מעבר לכתיבה</button>");
  });
});
