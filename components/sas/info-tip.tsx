"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Icon } from "./icon";

/**
 * InfoTip: a small (i) button right after a label that holds the label's explanation, so read
 * screens show label, value and action only (owner, 26 Nov: "a small (I) button … when hover or
 * pressed"). Hover or keyboard focus shows the text in a small popover; a click or tap pins it
 * open; Escape or a tap outside closes it. The popover stays in the DOM (hidden) so the button's
 * aria-describedby always reads it. It is placed inside the viewport (flips above, clamps at the
 * edges) and never over the controls of its row: the nearest `[data-info-scope]` ancestor's
 * `[data-info-avoid]` elements. 16px icon, 24px hit area (44px on touch screens), CSS in sas.css.
 */

export type InfoTipState = { pinned: boolean; hover: boolean; focus: boolean; dismissed: boolean };
export type InfoTipEvent = "enter" | "leave" | "focus" | "blur" | "click" | "escape" | "outside";

export const INFO_TIP_CLOSED: InfoTipState = { pinned: false, hover: false, focus: false, dismissed: false };

/** Shown: pinned, hovered or focused, unless it was just closed (Escape, or a click on a pinned one) and the pointer and focus have not both left since. */
export const infoTipOpen = (s: InfoTipState) => !s.dismissed && (s.pinned || s.hover || s.focus);

/** The next state for one event. Pure. */
export function infoTipNext(s: InfoTipState, e: InfoTipEvent): InfoTipState {
  switch (e) {
    case "enter": return { ...s, hover: true };
    // A closed one stays closed until both the pointer and focus have left it.
    case "leave": return { ...s, hover: false, dismissed: s.dismissed && s.focus };
    case "focus": return { ...s, focus: true };
    case "blur": return { ...s, focus: false, dismissed: s.dismissed && s.hover };
    // A click pins it open; a click on a pinned one closes it (until the pointer or focus leaves).
    case "click": return s.pinned && infoTipOpen(s) ? { ...s, pinned: false, dismissed: true } : { ...s, pinned: true, dismissed: false };
    case "escape": return { ...s, pinned: false, dismissed: true };
    case "outside": return { ...s, pinned: false, hover: false };
  }
}

export type Box = { left: number; top: number; right: number; bottom: number };
/** `maxHeight`: set when the popover is shortened to fit (its content then scrolls). */
export type InfoTipPlace = { side: "below" | "above"; left: number; top: number; width: number; maxHeight?: number };

const hits = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The shortest a shortened popover may get, in pixels. */
const MIN_HEIGHT = 120;

/**
 * Where the popover goes, in viewport pixels. Pure. Inside the viewport (`margin` from its edges,
 * never wider than it) and never over an `avoid` box (the row's Change control or stepper). In
 * order: below the button, else above it, starting just before the button or moved sideways off
 * an avoid box; then below or above the avoid boxes themselves; then the first of those with room
 * for at least 120px, shortened to fit; last, the side with more room, moved inside the viewport.
 */
export function placeInfoTip({ anchor, size, viewport, avoid = [], gap = 6, margin = 8 }: {
  anchor: Box; size: { width: number; height: number }; viewport: { width: number; height: number }; avoid?: Box[]; gap?: number; margin?: number;
}): InfoTipPlace {
  const width = Math.max(0, Math.min(size.width, viewport.width - 2 * margin));
  const clampLeft = (x: number) => Math.min(Math.max(x, margin), Math.max(margin, viewport.width - width - margin));
  const lefts = [...new Set([(anchor.left + anchor.right) / 2 - 20, ...avoid.flatMap((a) => [a.left - gap - width, a.right + gap])].map(clampLeft))];
  // Edges to sit under / over: the button's first, then the avoid boxes' (below or above it).
  const edges: ["below" | "above", number][] = [
    ["below", anchor.bottom], ["above", anchor.top],
    ...avoid.filter((a) => a.bottom > anchor.bottom).map((a) => ["below", a.bottom] as ["below", number]),
    ...avoid.filter((a) => a.top < anchor.top).map((a) => ["above", a.top] as ["above", number]),
  ];
  const clear = (left: number, top: number, h: number) => !avoid.some((a) => hits({ left, top, right: left + width, bottom: top + h }, a));
  const candidates = edges.flatMap(([side, edge]) => lefts.map((left) => {
    const room = side === "below" ? viewport.height - margin - (edge + gap) : edge - gap - margin;
    const h = Math.min(size.height, room);
    return { side, left, room, top: side === "below" ? edge + gap : edge - gap - size.height, shortTop: side === "below" ? edge + gap : edge - gap - h, h };
  }));
  const whole = candidates.find((c) => c.room >= size.height && c.top >= margin && clear(c.left, c.top, size.height));
  if (whole) return { side: whole.side, left: whole.left, top: whole.top, width };
  const short = candidates.find((c) => c.h >= Math.min(size.height, MIN_HEIGHT) && clear(c.left, c.shortTop, c.h));
  if (short) return { side: short.side, left: short.left, top: short.shortTop, width, maxHeight: short.h };
  const below = viewport.height - anchor.bottom >= anchor.top;
  const top = below ? anchor.bottom + gap : anchor.top - gap - size.height;
  return { side: below ? "below" : "above", left: lefts[0], top: Math.max(margin, Math.min(top, viewport.height - size.height - margin)), width };
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/**
 * Measures a shown popover and returns where it goes (also used by visual checks). The popover is
 * `position: fixed`, so a panel with `overflow: hidden` around the row does not cut it off.
 */
export function measureInfoTip(wrap: HTMLElement, button: HTMLElement, pop: HTMLElement): InfoTipPlace {
  const scope = wrap.closest("[data-info-scope]");
  const avoid = scope ? [...scope.querySelectorAll<HTMLElement>("[data-info-avoid]")].filter((el) => !el.contains(wrap)).map((el) => boxOf(el.getBoundingClientRect())) : [];
  return placeInfoTip({
    // The whole content's height, also while a shortened popover scrolls.
    anchor: boxOf(button.getBoundingClientRect()), size: { width: pop.offsetWidth, height: pop.scrollHeight + pop.offsetHeight - pop.clientHeight },
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight }, avoid,
  });
}

/**
 * `label`: the row's label (the button reads "About: {label}"). `children`: the moved explanation
 * (short paragraphs; no links needed to read it). `wide`: up to ~360px for longer content.
 * `popoverId`: a fixed id for the popover, for other elements' aria-describedby.
 */
export function InfoTip({ label, children, wide, popoverId }: { label: string; children: ReactNode; wide?: boolean; popoverId?: string }) {
  const auto = useId();
  const id = popoverId ?? `${auto}-info`;
  const [s, setS] = useState<InfoTipState>(INFO_TIP_CLOSED);
  const [place, setPlace] = useState<InfoTipPlace | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = infoTipOpen(s);
  const send = useCallback((e: InfoTipEvent) => setS((x) => infoTipNext(x, e)), []);

  const measure = useCallback(() => {
    if (!wrapRef.current || !btnRef.current || !popRef.current) return;
    setPlace(measureInfoTip(wrapRef.current, btnRef.current, popRef.current));
  }, []);
  useLayoutEffect(() => { if (open) measure(); else setPlace(null); }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) send("outside"); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") send("escape"); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, send, measure]);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  return (
    <span
      ref={wrapRef} className="sas-info" data-info-open={open ? "" : undefined}
      // Hover only for a mouse: a touch shows it with the tap (click), which pins it.
      onPointerEnter={(e) => { if (e.pointerType !== "mouse") return; if (leaveTimer.current) clearTimeout(leaveTimer.current); send("enter"); }}
      onPointerLeave={(e) => { if (e.pointerType !== "mouse") return; leaveTimer.current = setTimeout(() => send("leave"), 120); }}
    >
      <button
        ref={btnRef} type="button" className="sas-info__btn" aria-label={t("info.about", { label })}
        aria-expanded={open} aria-controls={id} aria-describedby={id} data-info-pinned={s.pinned && open ? "" : undefined}
        onClick={() => send("click")}
        onFocus={() => send("focus")}
        onBlur={() => send("blur")}
        // Escape closes this popover only, not a sheet or row it sits in.
        onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); e.preventDefault(); send("escape"); } }}
      >
        <Icon name="info" />
      </button>
      <span
        ref={popRef} id={id} role="tooltip" className={`sas-info__pop${wide ? " sas-info__pop--wide" : ""}`} hidden={!open}
        data-side={place?.side} style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : undefined}
      >
        {children}
      </span>
    </span>
  );
}
