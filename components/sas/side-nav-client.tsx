"use client";

import { usePathname } from "next/navigation";
import { ADMIN_NAV, SELLER_NAV, SideNav, type NavCount } from "./nav";

/** SideNav with the active item taken from the current URL (longest matching path wins). */
export function SideNavForPath(props: {
  mode: "seller" | "admin";
  basePath: string;
  accountName?: string;
  user: { name: string; initials: string };
  counts?: Record<string, NavCount>;
}) {
  const pathname = usePathname();
  const items = (props.mode === "admin" ? ADMIN_NAV : SELLER_NAV).flatMap((g) => g.items);
  let active = "";
  let best = -1;
  for (const it of items) {
    const href = `${props.basePath}${it.path}`;
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > best) {
      active = it.id;
      best = href.length;
    }
  }
  return <SideNav {...props} active={active} />;
}
