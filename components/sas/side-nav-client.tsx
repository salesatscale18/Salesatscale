"use client";

import { usePathname } from "next/navigation";
import { ADMIN_NAV, SELLER_NAV, SideNav, type NavCount } from "./nav";

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
  // Markets live under Settings (its subnav links there).
  if (!active && mode !== "admin" && (pathname === `${basePath}/markets` || pathname.startsWith(`${basePath}/markets/`))) active = "settings";
  return active;
}

/** SideNav with the active item taken from the current URL. */
export function SideNavForPath(props: {
  mode: "seller" | "admin";
  basePath: string;
  accountName?: string;
  user: { name: string; initials: string };
  counts?: Record<string, NavCount>;
}) {
  const pathname = usePathname();
  const items = (props.mode === "admin" ? ADMIN_NAV : SELLER_NAV).flatMap((g) => g.items);
  return <SideNav {...props} active={activeNavId(items, props.basePath, pathname, props.mode)} />;
}
