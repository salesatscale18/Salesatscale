/**
 * The Back sheets (components/sas/voice/leave-sheet.tsx), the order form's tray (components/sas/voice/voice-bubble.tsx
 * BubbleTray), the voice bar (voice-bar.tsx), rendered on the server. Focus, the trap, Escape and the scrim are driven in Chromium by
 * tests/e2e/voice/back-sheet-shots.ts.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaveSheet } from "@/components/sas/voice/leave-sheet";
import { BubbleTray } from "@/components/sas/voice/voice-bubble";
import { VoiceBar } from "@/components/sas/voice/voice-bar";
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

describe("the voice bar and the form's tray", () => {
  const base: MirrorState = { phase: "live", live: "speaking", muted: false, endReason: null, mic: 0, out: 0, caption: null, secondsLeft: 268, outputs: [], output: null };
  const bar = (s: MirrorState, tr = en, dir: "ltr" | "rtl" = "ltr") => renderToStaticMarkup(<VoiceBar state={s} agentName="Maya" tr={tr} dir={dir} onCommand={() => {}} />);
  const order = (html: string) => [...html.matchAll(/data-bar-(\w+)=""|data-bubble-button=""/g)].map((m) => m[1] ?? "bubble");

  it("a toolbar: Mute · bubble · Text; Speaker (the same size) between Mute and the bubble only where the browser offers a choice", () => {
    const html = bar(base);
    expect(html).toMatch(/<div class="vb-bar" role="toolbar" aria-label="Call controls" dir="ltr"/);
    expect(order(html)).toEqual(["mute", "bubble", "text"]);
    const two = { ...base, outputs: [{ id: "a", label: "Default" }, { id: "b", label: "Headphones" }], output: "b" };
    const withSpeaker = bar(two);
    expect(order(withSpeaker)).toEqual(["mute", "speaker", "bubble", "text"]);
    expect(withSpeaker).toMatch(/class="vb-ctl" aria-label="Speaker: Headphones" data-bar-speaker=""/);
    // No pop-up menu, and no time left on screen (the bubble's accessible name keeps it, as built).
    expect(html).not.toMatch(/role="menu"|aria-haspopup/);
    expect(text(html).join(" ")).not.toContain("left");
  });

  it("Mute: one word under a round button, named by it; dark and Unmute while muted; Text is named Switch to text", () => {
    const html = bar(base);
    expect(html).toMatch(/<button type="button" class="vb-ctl" aria-pressed="false" data-bar-mute=""><span class="vb-ctl__circle" aria-hidden="true"><svg[^>]*lucide-mic-off[^>]*>.*?<\/svg><\/span><span class="vb-ctl__label">Mute<\/span><\/button>/);
    expect(html).toMatch(/class="vb-ctl" aria-label="Switch to text" data-bar-text=""><span class="vb-ctl__circle" aria-hidden="true"><svg[^>]*lucide-keyboard/);
    expect(html).toContain('<span class="vb-ctl__label" aria-hidden="true">Text</span>');
    const muted = bar({ ...base, muted: true });
    expect(muted).toMatch(/class="vb-ctl vb-ctl--on" aria-pressed="true" data-bar-mute="">.*?Unmute<\/span>/);
    expect(muted).toContain('data-bubble-look="muted"');
  });

  it("Hebrew: השתקה, ביטול השתקה, כתיבה; the bar follows the page's direction", () => {
    const html = bar(base, he, "rtl");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(">השתקה</span>");
    expect(html).toContain(">כתיבה</span>");
    expect(html).toContain('aria-label="מעבר לכתיבה"');
    expect(bar({ ...base, muted: true }, he, "rtl")).toContain(">ביטול השתקה</span>");
  });

  it("the order form's tray: Mute and Text, round, labels under, no headline", () => {
    const html = renderToStaticMarkup(<BubbleTray id="t" state={base} view={bubbleView(base, en, "Maya")} tr={en} act={() => {}} />);
    expect(html).toMatch(/^<div class="vb-tray" id="t" role="group" aria-label="Call controls" data-bubble-tray="">/);
    expect(order(html)).toEqual(["mute", "text"]);
    expect(html).not.toMatch(/<b>|<h\d|left/);
  });

  it("layout from CSS only: the short labels in the bar's own row above the controls (never inside the bubble), Speaker marks the bar", () => {
    const html = bar({ ...base, secondsLeft: 45 });
    // The note row comes first, holding the label; the bubble itself has no label inside it.
    expect(html).toMatch(/^<div class="vb-bar"[^>]*><div class="vb-bar__note"><button type="button" class="vb-flash"/);
    expect(/<div[^>]*data-voice-bubble=""[^>]*>.*data-bubble-note/.test(html)).toBe(false);
    // The row is there with nothing in it too (its height is kept).
    expect(bar(base)).toContain('<div class="vb-bar__note"></div>');
    expect(bar({ ...base, outputs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })).toMatch(/^<div class="vb-bar vb-bar--speaker" role="toolbar"/);
    // No inline sizes or positions: nothing measured in script.
    expect(html).not.toMatch(/style="[^"]*(width|left|right|transform)/);
  });

  it("the last minute: 1 min left above the bubble (the time left shows nowhere else)", () => {
    expect(bar({ ...base, secondsLeft: 45 })).toMatch(/class="vb-flash" dir="auto" data-bubble-note="last_minute">1 min left</);
    expect(bar({ ...base, secondsLeft: 61 })).not.toContain("data-bubble-note");
    expect(bar({ ...base, secondsLeft: 45 }, he, "rtl")).toContain(">נותרה דקה<");
  });
});
