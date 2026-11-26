"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "@/lib/i18n";

/**
 * Drag to reorder, without a package (opener topics and questions): a handle
 * button per row. Pointer (mouse, pen, touch) drags the row; the keyboard
 * moves it one place with ↑ / ↓. The parent saves ONE move (from → to) and
 * the new position is announced. Nothing moves on the page while a save is
 * pending. Row elements carry `data-sort-row` inside the list element.
 */

/** Where a dragged row lands: the number of other rows whose middle is above the dragged row's middle. Pure. */
export function dropIndex(mids: readonly number[], from: number, center: number): number {
  let to = 0;
  mids.forEach((m, j) => { if (j !== from && m < center) to += 1; });
  return to;
}

/** The place ↑ / ↓ moves a row to, or null (another key, or already at that end). Pure. */
export function keyTarget(key: string, index: number, count: number): number | null {
  if (key === "ArrowUp") return index > 0 ? index - 1 : null;
  if (key === "ArrowDown") return index < count - 1 ? index + 1 : null;
  return null;
}

/** The list in its new order after moving `from` to `to` (the optimistic order while the save runs). Pure. */
export function moved<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

type Drag = { from: number; to: number; startY: number; mids: number[]; height: number; rows: HTMLElement[]; id: number };

export function useSortable({ count, busy, onMove, what, helpId }: {
  count: number;
  /** A save is running: no new move starts. */
  busy: boolean;
  onMove: (from: number, to: number) => void;
  /** The row's name, for the handle's label and the announcement. */
  what: (index: number) => string;
  /** The id of the list's SortHelp text (how to move a row). */
  helpId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");

  const clear = (d: Drag) => {
    for (const el of d.rows) { el.style.transform = ""; el.removeAttribute("data-dragging"); el.removeAttribute("data-shifted"); }
  };
  useEffect(() => () => { if (drag.current) clear(drag.current); }, []);

  const finish = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    clear(d);
    setDragging(null);
    if (commit && d.to !== d.from) {
      setAnnounce(t("playbook.sort.moved", { what: what(d.from), n: d.to + 1, total: count }));
      onMove(d.from, d.to);
    }
  };

  const handleProps = (index: number) => ({
    type: "button" as const,
    className: "pb-handle",
    "aria-label": t("playbook.sort.handle", { what: what(index), n: index + 1, total: count }),
    "aria-describedby": helpId,
    "aria-disabled": busy || count < 2 || undefined,
    "data-sort-handle": index,
    onKeyDown: (ev: KeyboardEvent<HTMLButtonElement>) => {
      if (ev.key === "Escape" && drag.current) { ev.preventDefault(); finish(false); return; }
      const to = keyTarget(ev.key, index, count);
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") ev.preventDefault();
      if (to === null || busy) return;
      setAnnounce(t("playbook.sort.moved", { what: what(index), n: to + 1, total: count }));
      onMove(index, to);
    },
    onPointerDown: (ev: PointerEvent<HTMLButtonElement>) => {
      if (busy || count < 2 || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > [data-sort-row]") ?? [])];
      if (rows.length !== count) return;
      ev.preventDefault();
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      const rects = rows.map((r) => r.getBoundingClientRect());
      drag.current = { from: index, to: index, startY: ev.clientY, mids: rects.map((r) => r.top + r.height / 2), height: rects[index].height, rows, id: ev.pointerId };
      rows[index].setAttribute("data-dragging", "");
      setDragging(index);
    },
    onPointerMove: (ev: PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.id) return;
      const dy = ev.clientY - d.startY;
      const to = dropIndex(d.mids, d.from, d.mids[d.from] + dy);
      d.rows[d.from].style.transform = `translateY(${dy}px)`;
      d.rows.forEach((el, j) => {
        if (j === d.from) return;
        const shift = d.from < to && j > d.from && j <= to ? -d.height : to < d.from && j >= to && j < d.from ? d.height : 0;
        el.style.transform = shift ? `translateY(${shift}px)` : "";
        if (shift) el.setAttribute("data-shifted", ""); else el.removeAttribute("data-shifted");
      });
      if (to !== d.to) {
        d.to = to;
        setAnnounce(t("playbook.sort.over", { n: to + 1, total: count }));
      }
    },
    onPointerUp: (ev: PointerEvent<HTMLButtonElement>) => { if (drag.current?.id === ev.pointerId) finish(true); },
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => { if (drag.current) finish(true); },
  });

  return { listRef, handleProps, dragging, announce };
}

/** The handle's help text and the live region for the new position (once per list). */
export function SortHelp({ id, announce }: { id: string; announce: string }) {
  return (
    <>
      <span id={id} className="sas-sr">{t("playbook.sort.help")}</span>
      <span className="sas-sr" aria-live="polite" aria-atomic="true" data-sort-announce="">{announce}</span>
    </>
  );
}
