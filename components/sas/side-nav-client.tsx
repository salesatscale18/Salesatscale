"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePathname } from "next/navigation";
import { t } from "@/lib/i18n";
import { Icon } from "./icon";
import { ADMIN_NAV, SELLER_NAV, SideNav, type NavCount, type NavSetup } from "./nav";

/**
 * The active nav item for a URL: the longest matching path wins. An item whose
 * path is the base path itself (Overview) matches only that exact URL, never
 * the pages under it. Pure; unit-tested.
 */
export function activeNavId(items: { id: string; path: string }[], basePath: string, pathname: string, mode: "seller" | "admin"): string {
  let active = "";
  let best = -1;
  for (const it of items) {
    const href = `${basePath}${it.path}`;
    const root = it.path === "" || it.path === "/";
    const match = root ? pathname === href || pathname === `${href}/` : pathname === href || pathname.startsWith(`${href}/`);
    if (match && href.length > best) {
      active = it.id;
      best = href.length;
    }
  }
  return active;
}

type NavProps = {
  mode: "seller" | "admin";
  basePath: string;
  accountName?: string;
  /** `role`: the footer line under the name; defaults to the mode's role ("Seller admin" / "Platform admin"). */
  user: { name: string; initials: string; role?: string };
  counts?: Record<string, NavCount>;
  setup?: NavSetup;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Phone top bar (below 768px): a menu button that opens the side nav as a
 * drawer. It is a <details> element, so it opens and closes without JS; with
 * JS the button reports aria-expanded, Escape and a tap outside close it, and
 * Tab stays inside the open drawer.
 */
function TopBar(props: NavProps & { active: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const total = Object.values(props.counts ?? {}).reduce((n, c) => n + (c.tone === "human" ? c.value : 0), 0);

  const close = (focusButton: boolean) => {
    const el = ref.current;
    if (!el?.open) return;
    el.open = false;
    if (focusButton) el.querySelector("summary")?.focus();
  };

  // A new page closes the drawer (client navigation keeps this component mounted).
  useEffect(() => close(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (!ref.current?.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(`summary, .sas-drawer__panel :is(${FOCUSABLE})`)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <header className="sas-topbar">
      <details ref={ref} className="sas-drawer" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} onKeyDown={onKeyDown}>
        <summary className="sas-topbar__menu" aria-expanded={open} aria-controls="sas-drawer-panel">
          <Icon name={open ? "x" : "menu"} />
          <span className="sas-sr">{t(open ? "nav.menu_close" : "nav.menu")}</span>
          {total ? <span className="sas-nav__count sas-nav__count--human sas-topbar__count" aria-hidden="true">{total}</span> : null}
        </summary>
        <div className="sas-drawer__panel" id="sas-drawer-panel">
          <SideNav {...props} />
        </div>
      </details>
      <span className="sas-nav__mark" aria-hidden="true" />
      <span className="sas-topbar__title">{props.mode === "admin" ? t("nav.all_accounts") : props.accountName}</span>
    </header>
  );
}

/** SideNav with the active item taken from the current URL: a side column on wide screens, a top bar with a drawer on phones. */
export function SideNavForPath(props: NavProps) {
  const pathname = usePathname();
  const items = (props.mode === "admin" ? ADMIN_NAV : SELLER_NAV).flatMap((g) => g.items);
  const active = activeNavId(items, props.basePath, pathname, props.mode);
  return (
    <>
      <div className="sas-shell__nav"><SideNav {...props} active={active} /></div>
      <TopBar {...props} active={active} />
    </>
  );
}
