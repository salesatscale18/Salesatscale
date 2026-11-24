"use client";

/**
 * Progressive enhancement for the list kit (components/sas/list-kit.tsx).
 * Every piece renders an empty marker span (or a plain input) on the server,
 * so the kit works without JS; with JS these attach behaviour to the nearest
 * form, menu, panel or tile row. None of them use the router, so they render
 * anywhere (render tests, static markup).
 */
import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { FOCUSABLE_SELECTOR, trapFocusIndex } from "@/lib/list-kit";

/**
 * Inside a list toolbar form: typing in the search box submits after a pause,
 * changing a filter select submits at once, and the no-JS Apply button hides
 * (the form gets data-enhanced).
 */
export function AutoSubmit({ delay = 350 }: { delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    form.dataset.enhanced = "true";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const submit = () => {
      clearTimeout(timer);
      form.requestSubmit();
    };
    const onInput = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!(el instanceof HTMLInputElement) || el.type !== "search") return;
      clearTimeout(timer);
      timer = setTimeout(submit, delay);
    };
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLSelectElement) submit();
    };
    form.addEventListener("input", onInput);
    form.addEventListener("change", onChange);
    return () => {
      clearTimeout(timer);
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onChange);
      delete form.dataset.enhanced;
    };
  }, [delay]);
  return <span ref={ref} hidden data-autosubmit="" />;
}

/**
 * Inside a RowMenu <details>: the summary reports aria-expanded; Arrow keys,
 * Home and End move between items; Escape and a click outside close it and
 * Escape returns focus to the button. While open the menu is placed with
 * fixed positioning so a scrolling table does not clip it.
 */
export function MenuEnhancer() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const details = ref.current?.closest("details");
    const summary = details?.querySelector("summary");
    const menu = details?.querySelector<HTMLElement>(".sas-rowmenu__list");
    if (!details || !summary || !menu) return;
    summary.setAttribute("aria-expanded", String(details.open));
    const items = () => [...menu.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];

    const place = () => {
      const r = summary.getBoundingClientRect();
      const rtl = getComputedStyle(details).direction === "rtl";
      menu.style.position = "fixed";
      menu.style.insetInlineEnd = "auto";
      menu.style.insetBlockStart = "auto";
      const h = menu.offsetHeight;
      const below = window.innerHeight - r.bottom;
      menu.style.top = `${below < h + 8 && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4}px`;
      if (rtl) {
        menu.style.left = `${Math.max(8, r.left)}px`;
        menu.style.right = "auto";
      } else {
        menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
        menu.style.left = "auto";
      }
      // data-menu-match="trigger" (Conversations view and sort menus): the list is as wide as its button, starts at
      // the button's edge and stays inside the screen with a 16px gutter.
      if (details.dataset.menuMatch === "trigger") {
        const w = Math.min(r.width, window.innerWidth - 32);
        menu.style.width = `${w}px`;
        menu.style.minWidth = "0";
        menu.style.left = `${Math.min(Math.max(16, rtl ? r.right - w : r.left), window.innerWidth - 16 - w)}px`;
        menu.style.right = "auto";
      }
    };
    const reset = () => {
      for (const p of ["position", "top", "left", "right", "insetInlineEnd", "insetBlockStart", "width", "minWidth"] as const) menu.style[p] = "";
    };
    const close = (focus: boolean) => {
      details.open = false;
      if (focus) summary.focus();
    };
    // Opened with ArrowUp: focus the last item instead of the first.
    let focusLast = false;
    const onToggle = () => {
      summary.setAttribute("aria-expanded", String(details.open));
      if (details.open) {
        place();
        // Opened from the keyboard: focus the first item (the last after ArrowUp).
        const list = items();
        if (document.activeElement === summary) list[focusLast ? list.length - 1 : 0]?.focus();
      } else reset();
      focusLast = false;
    };
    const onKey = (e: KeyboardEvent) => {
      // ArrowDown / ArrowUp on the closed ⋯ button open the menu (menu button pattern), like Enter and Space.
      if (!details.open && e.target === summary && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        focusLast = e.key === "ArrowUp";
        details.open = true;
        return;
      }
      if (!details.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowDown") next = i < 0 || i === list.length - 1 ? 0 : i + 1;
      else if (e.key === "ArrowUp") next = i <= 0 ? list.length - 1 : i - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next >= 0 && list[next]) {
        e.preventDefault();
        list[next].focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (details.open && !details.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (details.open && !menu.contains(e.target as Node)) close(false);
    };
    // Picking an item closes the menu. The <details> survives client navigation (Link, server-action
    // redirect), so without this it stayed open over the confirm step or the panel the item opened.
    // Closed on the next tick so the link's navigation or the form's submit starts first.
    const onPick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest("a, button")) setTimeout(() => close(false), 0);
    };
    menu.addEventListener("click", onPick);
    details.addEventListener("toggle", onToggle);
    details.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    const onResize = () => close(false);
    window.addEventListener("resize", onResize);
    return () => {
      menu.removeEventListener("click", onPick);
      details.removeEventListener("toggle", onToggle);
      details.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return <span ref={ref} hidden data-menu-enhancer="" />;
}

/**
 * Inside a SidePanel dialog: moves focus into the panel (an element marked
 * autofocus or data-autofocus, else the panel itself), keeps Tab inside it,
 * closes on Escape by following the X link, and gives focus back to the
 * element that had it when the panel closes (if it is still on the page).
 */
export function PanelFocus() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>("[data-sidepanel]");
    if (!panel) return;
    const before = document.activeElement as HTMLElement | null;
    const target = panel.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? panel;
    target.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        panel.querySelector<HTMLAnchorElement>("[data-sidepanel-close]")?.click();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      const next = trapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      items[next].focus();
    };
    // Focus that escapes (a click on the page behind) comes back to the panel.
    const onFocusIn = (e: FocusEvent) => {
      if (!panel.contains(e.target as Node)) panel.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      if (before && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return <span ref={ref} hidden data-panel-focus="" />;
}

/** Moves focus to the closest [data-focus-on-mount] element once (ConfirmDelete). */
export function FocusOnMount() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.closest<HTMLElement>("[data-focus-on-mount]")?.focus();
  }, []);
  return <span ref={ref} hidden />;
}

/* ---------------------------------------------------------------------------
 * Dropping files on a tile: the tile row keeps the dropped files here, then
 * follows the tile's link; the DropFileInput in the opened panel picks them up.
 * Module state survives client navigation, which is all this needs.
 * ------------------------------------------------------------------------- */
const pendingDrops = new Map<string, FileList>();

/** Exported for tests: hands files to the DropFileInput with this key. */
export function setPendingDrop(key: string, files: FileList): void {
  pendingDrops.set(key, files);
}
export function takePendingDrop(key: string): FileList | undefined {
  const files = pendingDrops.get(key);
  pendingDrops.delete(key);
  return files;
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

/**
 * Inside TypeTiles: tiles with data-drop-key accept dropped files (and the
 * whole page does, for the tile named by `pageDropKey`). A drop stores the
 * files and follows the tile's link, which opens its panel.
 */
export function TileDrop({ pageDropKey }: { pageDropKey?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const row = ref.current?.closest<HTMLElement>("[data-tiles]");
    if (!row) return;
    const tileFor = (key: string) => row.querySelector<HTMLAnchorElement>(`[data-drop-key="${CSS.escape(key)}"]`);
    const tileOf = (e: DragEvent) => (e.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>("[data-drop-key]") ?? null;
    const clear = () => row.querySelectorAll("[data-dragover]").forEach((el) => el.removeAttribute("data-dragover"));

    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      const tile = tileOf(e) ?? (pageDropKey ? tileFor(pageDropKey) : null);
      if (!tile) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      if (!tile.hasAttribute("data-dragover")) {
        clear();
        tile.setAttribute("data-dragover", "");
      }
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) clear();
    };
    const onDrop = (e: DragEvent) => {
      const tile = tileOf(e) ?? (pageDropKey ? tileFor(pageDropKey) : null);
      clear();
      if (!tile || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      setPendingDrop(tile.dataset.dropKey!, e.dataTransfer.files);
      tile.click();
    };
    const scope: HTMLElement | Document = pageDropKey ? document : row;
    scope.addEventListener("dragover", onOver as EventListener);
    scope.addEventListener("dragleave", onLeave as EventListener);
    scope.addEventListener("drop", onDrop as EventListener);
    return () => {
      scope.removeEventListener("dragover", onOver as EventListener);
      scope.removeEventListener("dragleave", onLeave as EventListener);
      scope.removeEventListener("drop", onDrop as EventListener);
    };
  }, [pageDropKey]);
  return <span ref={ref} hidden data-tile-drop="" />;
}

/**
 * A file input that receives files dropped on the TypeTiles tile with the
 * same `dropKey` (it fires a change event so form state sees them). Without
 * JS it is a plain file input.
 */
export function DropFileInput({ dropKey, ...rest }: InputHTMLAttributes<HTMLInputElement> & { dropKey: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    const files = takePendingDrop(dropKey);
    if (!input || !files?.length) return;
    const dt = new DataTransfer();
    for (const f of input.multiple ? [...files] : [...files].slice(0, 1)) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [dropKey]);
  return <input ref={ref} type="file" data-drop-input={dropKey} {...rest} />;
}
