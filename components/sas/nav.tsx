/**
 * Side navigation and setup-steps bar (canvas: SideNav, SetupSteps).
 * The nav config is exported so routes and tests use the same list.
 */
import { t, type MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icon";
import { Avatar } from "./primitives";

export type NavItem = { id: string; label: MessageKey; icon: IconName; path: string };
export type NavGroup = { label?: MessageKey; items: NavItem[] };

export const SELLER_NAV: NavGroup[] = [
  {
    items: [
      { id: "overview", label: "nav.overview", icon: "layout-grid", path: "" },
      { id: "leads", label: "nav.leads", icon: "user-plus", path: "/leads" },
      { id: "inbox", label: "nav.inbox", icon: "message-circle", path: "/inbox" },
      { id: "orders", label: "nav.orders", icon: "file-text", path: "/orders" },
      { id: "meetings", label: "nav.meetings", icon: "calendar", path: "/meetings" },
      { id: "reports", label: "nav.reports", icon: "chart", path: "/reports" },
    ],
  },
  {
    label: "nav.group.setup",
    items: [
      { id: "knowledge", label: "nav.knowledge", icon: "book-open", path: "/setup/knowledge" },
      { id: "catalog", label: "nav.catalog", icon: "package", path: "/setup/catalog" },
      { id: "playbook", label: "nav.playbook", icon: "sparkles", path: "/setup/playbook" },
      { id: "order-form", label: "nav.order_form", icon: "pen", path: "/setup/order-form" },
      { id: "follow-ups", label: "nav.follow_ups", icon: "clock", path: "/setup/follow-ups" },
      { id: "test-lab", label: "nav.test_lab", icon: "flask-conical", path: "/setup/test-lab" },
      { id: "go-live", label: "nav.go_live", icon: "rocket", path: "/setup/go-live" },
    ],
  },
  { items: [{ id: "settings", label: "nav.settings", icon: "sliders", path: "/settings" }] },
];

export const ADMIN_NAV: NavGroup[] = [
  {
    label: "nav.group.platform",
    items: [
      { id: "activity", label: "nav.activity", icon: "activity", path: "" },
      { id: "accounts", label: "nav.accounts", icon: "building", path: "/accounts" },
      { id: "operations", label: "nav.operations", icon: "layers", path: "/operations" },
    ],
  },
];

export type NavCount = { value: number; tone?: "human" };

export function SideNav({
  mode,
  basePath,
  active,
  accountName,
  user,
  counts = {},
}: {
  mode: "seller" | "admin";
  /** e.g. `/app/polar-monitoring` for a seller, `/sadmin` for the platform admin. */
  basePath: string;
  active: string;
  accountName?: string;
  user: { name: string; initials: string };
  counts?: Record<string, NavCount>;
}) {
  const groups = mode === "admin" ? ADMIN_NAV : SELLER_NAV;
  return (
    <nav className="sas-nav" aria-label={t("nav.main")}>
      <div className="sas-nav__brand">
        <span className="sas-nav__mark" aria-hidden="true" />
        Sales at Scale
      </div>
      <div className="sas-nav__account">
        <span className="sas-nav__account-text">
          <span className="sas-nav__account-name">{mode === "admin" ? t("nav.all_accounts") : accountName}</span>
          <span className="sas-nav__sub">{mode === "admin" ? t("nav.platform_admin_view") : t("nav.seller_account")}</span>
        </span>
        <Icon name="chevrons-up-down" />
      </div>
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label ? <div className="sas-label sas-nav__group-label">{t(g.label)}</div> : null}
          <ul className="sas-nav__group">
            {g.items.map((it) => {
              const count = counts[it.id];
              return (
                <li key={it.id}>
                  <a className="sas-nav__item" href={`${basePath}${it.path}`} aria-current={it.id === active ? "page" : undefined}>
                    <Icon name={it.icon} />
                    <span className="sas-nav__label">{t(it.label)}</span>
                    {count ? (
                      <span className={count.tone === "human" ? "sas-nav__count sas-nav__count--human" : "sas-nav__count"}>
                        {count.value}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="sas-nav__user">
        <Avatar actor="human" initials={user.initials} />
        <span className="sas-nav__user-text">
          <span className="sas-nav__user-name">{user.name}</span>
          <span className="sas-nav__sub">{t(mode === "admin" ? "nav.role.platform_admin" : "nav.role.seller_admin")}</span>
        </span>
      </div>
    </nav>
  );
}

export const SETUP_STEPS: { id: string; label: MessageKey; path: string }[] = [
  { id: "company", label: "setup.company", path: "/setup/company" },
  { id: "sources", label: "setup.sources", path: "/setup/sources" },
  { id: "knowledge", label: "setup.knowledge", path: "/setup/knowledge" },
  { id: "catalog", label: "setup.catalog", path: "/setup/catalog" },
  { id: "playbook", label: "setup.playbook", path: "/setup/playbook" },
  { id: "order-form", label: "setup.order_form", path: "/setup/order-form" },
  { id: "follow-ups", label: "setup.follow_ups", path: "/setup/follow-ups" },
  { id: "go-live", label: "setup.go_live", path: "/setup/go-live" },
];

/** Setup steps bar: completed steps show a check, any step can be reopened. */
export function SetupSteps({ basePath, current, completed }: { basePath: string; current: string; completed: ReadonlySet<string> }) {
  return (
    <nav aria-label={t("setup.steps")}>
      <ol className="sas-steps">
        {SETUP_STEPS.map((s, i) => {
          const done = completed.has(s.id);
          return (
            <li key={s.id}>
              <a
                className={done ? "sas-steps__step sas-steps__step--done" : "sas-steps__step"}
                href={`${basePath}${s.path}`}
                aria-current={s.id === current ? "step" : undefined}
              >
                <span className="sas-steps__dot">{done ? <Icon name="check" label="Done" /> : i + 1}</span>
                {t(s.label)}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
