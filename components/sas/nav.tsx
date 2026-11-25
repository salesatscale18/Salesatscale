/**
 * Side navigation and setup-steps bar (canvas: SideNav, SetupSteps).
 * The nav config is exported so routes and tests use the same list.
 */
import { t, type MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icon";
import { Avatar } from "./primitives";

/** `hidden`: the route exists (a "not built yet" placeholder) but the nav does not list it. */
export type NavItem = { id: string; label: MessageKey; icon: IconName; path: string; hidden?: true };
export type NavGroup = { label?: MessageKey; items: NavItem[] };

export const SELLER_NAV: NavGroup[] = [
  {
    items: [
      { id: "overview", label: "nav.overview", icon: "layout-grid", path: "" },
      { id: "leads", label: "nav.leads", icon: "user-plus", path: "/leads" },
      { id: "lead-pages", label: "nav.lead_pages", icon: "panel-top", path: "/lead-pages" },
      { id: "inbox", label: "nav.inbox", icon: "message-circle", path: "/conversations" },
      { id: "orders", label: "nav.orders", icon: "file-text", path: "/orders" },
      { id: "meetings", label: "nav.meetings", icon: "calendar", path: "/meetings", hidden: true },
      { id: "reports", label: "nav.reports", icon: "chart", path: "/reports", hidden: true },
    ],
  },
  {
    label: "nav.group.setup",
    items: [
      { id: "company", label: "nav.company", icon: "building", path: "/setup/company" },
      { id: "sources", label: "nav.sources", icon: "upload", path: "/setup/sources" },
      { id: "knowledge", label: "nav.knowledge", icon: "book-open", path: "/setup/knowledge" },
      { id: "catalog", label: "nav.catalog", icon: "package", path: "/setup/catalog" },
      { id: "price-lists", label: "nav.price_lists", icon: "tags", path: "/setup/price-lists" },
      { id: "markets", label: "nav.markets", icon: "globe", path: "/markets" },
      { id: "playbook", label: "nav.playbook", icon: "scroll-text", path: "/setup/playbook" },
      { id: "order-form", label: "nav.order_form", icon: "file-signature", path: "/setup/order-form" },
      { id: "follow-ups", label: "nav.follow_ups", icon: "alarm-clock", path: "/setup/follow-ups", hidden: true },
      { id: "test-lab", label: "nav.test_lab", icon: "flask-conical", path: "/setup/test-lab" },
      { id: "go-live", label: "nav.go_live", icon: "rocket", path: "/setup/go-live" },
    ],
  },
  { items: [{ id: "settings", label: "nav.settings", icon: "sliders", path: "/settings" }] },
];

/** The nav items a seller sees (hidden placeholders left out). */
export const visibleNavItems = (groups: NavGroup[]) => groups.flatMap((g) => g.items).filter((it) => !it.hidden);

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
  setup,
}: {
  mode: "seller" | "admin";
  /** e.g. `/app/polar-monitoring` for a seller, `/sadmin` for the platform admin. */
  basePath: string;
  active: string;
  accountName?: string;
  /** `role`: the footer line under the name; defaults to the mode's role ("Seller admin" / "Platform admin"). */
  user: { name: string; initials: string; role?: string };
  counts?: Record<string, NavCount>;
  /** Setup progress while the account is not live: the menu shows the bar, the checks and "Next". */
  setup?: NavSetup;
}) {
  const groups = mode === "admin" ? ADMIN_NAV : SELLER_NAV;
  const done = new Set(setup?.done ?? []);
  const doneCount = SETUP_STEPS.filter((s) => done.has(s.id)).length;
  const next = setup ? SETUP_STEPS.find((s) => !done.has(s.id))?.id : undefined;
  return (
    <nav className="sas-nav" aria-label={t("nav.main")}>
      <div className="sas-nav__brand">
        <span className="sas-nav__mark" aria-hidden="true" />
        Sales at Scale
      </div>
      {mode === "admin" ? null : (
        <div className="sas-nav__account">
          <span className="sas-nav__account-text">
            <span className="sas-nav__account-name">{accountName}</span>
            <span className="sas-nav__sub">{t("nav.seller_account")}</span>
          </span>
          <Icon name="chevrons-up-down" />
        </div>
      )}
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label ? <div className="sas-label sas-nav__group-label">{t(g.label)}</div> : null}
          {setup && g.label === "nav.group.setup" ? (
            <div className="sas-nav__progress" data-setup-done={doneCount}>
              <ProgressBar done={doneCount} total={SETUP_STEPS.length} />
              <span className="sas-nav__sub">{t("nav.setup.done", { done: doneCount, total: SETUP_STEPS.length })}</span>
            </div>
          ) : null}
          <ul className="sas-nav__group">
            {g.items.filter((it) => !it.hidden).map((it) => {
              const count = counts[it.id];
              const step = setup ? NAV_STEP[it.id] : undefined;
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
                    {step && done.has(step) ? <span className="sas-nav__done" data-step-done={step}><Icon name="check-circle" label={t("nav.setup.step_done")} /></span> : null}
                    {step && step === next ? <span className="sas-nav__next" data-step-next={step}>{t("nav.setup.next")}</span> : null}
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
          <span className="sas-nav__user-name" title={user.name}>{user.name}</span>
          <span className="sas-nav__sub">{user.role ?? t(mode === "admin" ? "nav.role.platform_admin" : "nav.role.seller_admin")}</span>
        </span>
      </div>
    </nav>
  );
}

/** Every setup step, including ones whose page is still a "not built yet" placeholder (`hidden`). */
export const ALL_SETUP_STEPS: { id: string; label: MessageKey; path: string; hidden?: true }[] = [
  { id: "company", label: "setup.company", path: "/setup/company" },
  { id: "sources", label: "setup.sources", path: "/setup/sources" },
  { id: "knowledge", label: "setup.knowledge", path: "/setup/knowledge" },
  { id: "catalog", label: "setup.catalog", path: "/setup/catalog" },
  { id: "prices", label: "setup.prices", path: "/setup/price-lists" },
  { id: "playbook", label: "setup.playbook", path: "/setup/playbook" },
  { id: "order-form", label: "setup.order_form", path: "/setup/order-form" },
  { id: "follow-ups", label: "setup.follow_ups", path: "/setup/follow-ups", hidden: true },
  { id: "go-live", label: "setup.go_live", path: "/setup/go-live" },
];

/** The steps the step bar, the Overview and the admin page show and count: a hidden step is never an unfinished one. */
export const SETUP_STEPS = ALL_SETUP_STEPS.filter((s) => !s.hidden);

/** Nav item id → setup step id (the menu shows step state on these items). */
const NAV_STEP: Record<string, string | undefined> = Object.fromEntries(
  SETUP_STEPS.map((s) => [SELLER_NAV.flatMap((g) => g.items).find((it) => it.path === s.path)?.id ?? s.id, s.id]),
);

export type NavSetup = { done: readonly string[] };

/** Thin progress bar (decorative: the text next to it says the same). */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <span className="sas-progress" aria-hidden="true"><span className="sas-progress__fill" style={{ width: `${pct}%` }} /></span>;
}

/**
 * Setup step line under a setup page's title: "Step 4 of 8", a done mark, a
 * thin progress bar and a link to the next step. The full list of steps, with
 * their checks, is in the side menu (Agent setup). One source of state: pages
 * pass setupProgress (lib/overview/setup.ts). A sub-page (a price list, a
 * source) marks its step as current; Test lab is no step, so it shows the
 * overall count and the first open step instead.
 */
export function SetupSteps({ basePath, current, completed }: { basePath: string; current: string; completed: ReadonlySet<string> }) {
  const total = SETUP_STEPS.length;
  const doneCount = SETUP_STEPS.filter((s) => completed.has(s.id)).length;
  const at = SETUP_STEPS.findIndex((s) => s.id === current);
  const next = at >= 0 ? SETUP_STEPS[at + 1] : SETUP_STEPS.find((s) => !completed.has(s.id));
  const currentDone = at >= 0 && completed.has(current);
  return (
    <nav className="sas-stepline" aria-label={t("setup.steps")} data-step={at >= 0 ? current : undefined} data-step-done={currentDone ? "" : undefined} data-done={doneCount}>
      <span className="sas-stepline__label">
        {at >= 0 ? t("setup.step_of", { n: at + 1, total }) : t("overview.setup.count", { done: doneCount, total })}
      </span>
      {currentDone ? <span className="sas-stepline__done"><Icon name="check-circle" />{t("nav.setup.step_done")}</span> : null}
      <ProgressBar done={doneCount} total={total} />
      {next ? (
        <a className="sas-stepline__next" href={`${basePath}${next.path}`} data-next={next.id}>
          {t("setup.next_step", { step: t(next.label) })}
          <Icon name="arrow-right" />
        </a>
      ) : null}
    </nav>
  );
}
