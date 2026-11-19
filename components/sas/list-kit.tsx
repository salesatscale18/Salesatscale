/**
 * List kit: the shared parts of the setup "list pages" pattern (toolbar,
 * sortable headings, row menu, delete confirm, side panel, summary strip,
 * add tiles). Server components: every state lives in the URL (search
 * params), so each part works without JS; the small client enhancers in
 * list-kit-client.tsx add auto-submit, keyboard support and the focus trap.
 * Tables use the existing `sas-table sas-table--stack` + td data-label
 * pattern to become cards on a phone.
 */
import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { hrefWith, sortHref, TRANSIENT_PARAMS, type SearchParamsLike, type SortDir, type SortState, paramEntries } from "@/lib/list-kit";
import { Icon, type IconName } from "./icon";
import { buttonClass } from "./primitives";
import { AutoSubmit, FocusOnMount, MenuEnhancer, PanelFocus, TileDrop } from "./list-kit-client";

/* ------------------------------------------------------------------------- */
/* ListToolbar                                                               */
/* ------------------------------------------------------------------------- */

export type FilterChip = { value: string | null; label: string; count?: number };
export type FilterSelect = { name: string; label: string; value?: string; options: { value: string; label: string }[] };
export type SortOption = { key: string; dir: SortDir; label: string };

export type ListToolbarProps = {
  /** The list's path (the form's action and every chip link's base). */
  path: string;
  /** The page's awaited searchParams. */
  params: SearchParamsLike;
  title?: ReactNode;
  /** Heading level for the title (default 2). */
  titleLevel?: 1 | 2;
  /** Right side of the title row, e.g. an Add button. */
  actions?: ReactNode;
  /** Accessible name of the whole toolbar form, e.g. "Find sources". */
  label?: string;
  search?: { label: string; placeholder?: string; name?: string };
  /** Chips that set one param (null value = "All"). The active chip has aria-current. */
  chips?: { param: string; label: string; items: FilterChip[] };
  /** One or two selects; each auto-submits on change. An empty option value means "any". */
  selects?: FilterSelect[];
  /** A sort select shown on phones only (the table headings are hidden there). */
  sort?: { current: SortState; options: SortOption[] };
  /** Params never carried over (default: panel, tab, confirm, page). */
  drop?: readonly string[];
};

/**
 * The list toolbar: title row, then a GET form with the search box and the
 * filter selects (auto-submit with JS, an Apply button without), and the
 * filter chips as links. Params the form does not own (the chip param, sort)
 * ride along as hidden inputs, so a search keeps the current chip and sort.
 */
export function ListToolbar({ path, params, title, titleLevel = 2, actions, label, search, chips, selects = [], sort, drop = TRANSIENT_PARAMS }: ListToolbarProps) {
  const qName = search?.name ?? "q";
  const owned = new Set<string>([qName, ...selects.map((s) => s.name), ...(sort ? ["sort", "dir"] : [])]);
  const hidden = paramEntries(params).filter(([k]) => !owned.has(k) && !drop.includes(k));
  const q = paramEntries(params).find(([k]) => k === qName)?.[1] ?? "";
  const H = titleLevel === 1 ? "h1" : "h2";
  const chipValue = chips ? (paramEntries(params).find(([k]) => k === chips.param)?.[1] ?? null) : null;
  const sortValue = sort ? `${sort.current.key}:${sort.current.dir}` : "";
  const sortOptions = sort
    ? sort.options.some((o) => `${o.key}:${o.dir}` === sortValue)
      ? sort.options
      : [{ ...sort.current, label: sort.current.key }, ...sort.options]
    : [];

  return (
    <div className="sas-listbar">
      {title || actions ? (
        <div className="sas-listbar__head">
          {title ? <H className="sas-title">{title}</H> : null}
          {actions ? <div className="sas-listbar__actions">{actions}</div> : null}
        </div>
      ) : null}
      {search || selects.length || sort ? (
        <Form action={path} replace scroll={false} className="sas-listbar__form" role="search" aria-label={label}>
          {hidden.map(([k, v], i) => (
            <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
          ))}
          {search ? (
            <label className="sas-search sas-listbar__search">
              <Icon name="search" />
              <span className="sas-sr">{search.label}</span>
              <input type="search" name={qName} defaultValue={q} placeholder={search.placeholder ?? search.label} autoComplete="off" />
            </label>
          ) : null}
          {selects.map((s) => (
            <label key={s.name} className="sas-listbar__select">
              <span className="sas-sr">{s.label}</span>
              <select className="sas-select" name={s.name} defaultValue={s.value ?? ""}>
                {s.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          ))}
          {sort ? (
            <label className="sas-listbar__select sas-listbar__sort">
              <span className="sas-sr">{t("kit.sort")}</span>
              <select className="sas-select" name="sort" defaultValue={sortValue}>
                {sortOptions.map((o) => (
                  <option key={`${o.key}:${o.dir}`} value={`${o.key}:${o.dir}`}>{o.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="submit" className={`${buttonClass("secondary", "sm")} sas-listbar__apply`}>{t("kit.apply")}</button>
          <AutoSubmit />
        </Form>
      ) : null}
      {chips ? (
        <div className="sas-listbar__chips" role="group" aria-label={chips.label}>
          {chips.items.map((c) => {
            const active = (c.value ?? null) === chipValue;
            return (
              <Link
                key={c.value ?? "_all"}
                className="sas-fchip"
                href={hrefWith(path, params, { [chips.param]: c.value }, drop)}
                aria-current={active ? "true" : undefined}
                replace
                scroll={false}
              >
                {c.label}
                {c.count !== undefined ? <span className="sas-fchip__count sas-num">{c.count}</span> : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* SortableTh                                                                */
/* ------------------------------------------------------------------------- */

/**
 * A table heading that sorts by its column: a link to the same page with
 * sort/dir set (clicking again flips the direction), aria-sort on the th and
 * an arrow. Use inside a `sas-table`.
 */
export function SortableTh({
  column,
  children,
  path,
  params,
  sort,
  firstDir = "asc",
  align,
}: {
  column: string;
  children: ReactNode;
  path: string;
  params: SearchParamsLike;
  sort: SortState;
  /** Direction on the first click (e.g. "desc" for dates and counts). */
  firstDir?: SortDir;
  align?: "end";
}) {
  const active = sort.key === column;
  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
  return (
    <th scope="col" aria-sort={ariaSort} className={align === "end" ? "sas-th-sort sas-th-sort--end" : "sas-th-sort"}>
      <Link href={sortHref(path, params, column, sort, firstDir)} replace scroll={false} className="sas-th-sort__link" data-active={active ? "" : undefined}>
        {children}
        <Icon name={active ? (sort.dir === "asc" ? "arrow-up" : "arrow-down") : "chevrons-up-down"} />
      </Link>
    </th>
  );
}

/* ------------------------------------------------------------------------- */
/* RowMenu                                                                   */
/* ------------------------------------------------------------------------- */

type FormAction = string | ((formData: FormData) => void | Promise<void>);
export type RowMenuItem =
  | { kind?: "link"; label: string; href: string; icon?: IconName; danger?: boolean }
  | { kind: "form"; label: string; action: FormAction; fields?: Record<string, string>; icon?: IconName; danger?: boolean };

/**
 * The ⋯ button with a row's actions. A <details> menu (opens without JS);
 * with JS: aria-expanded, Arrow/Home/End keys, Escape and click outside.
 * Items are links or one-button forms (server actions); `danger` styles a
 * Delete, with the trash icon (x-circle means Failed, never Delete). Delete
 * should be a link to the confirm step (see ConfirmDelete), never a direct form.
 */
export function RowMenu({ label, items }: { /** e.g. "More actions for acme.com" */ label: string; items: RowMenuItem[] }) {
  return (
    <details className="sas-rowmenu">
      <summary className="sas-rowmenu__button" aria-haspopup="true" title={label}>
        <Icon name="ellipsis" />
        <span className="sas-sr">{label}</span>
      </summary>
      <div className="sas-rowmenu__list">
        {items.map((it, i) => {
          const cls = it.danger ? "sas-rowmenu__item sas-rowmenu__item--danger" : "sas-rowmenu__item";
          const icon = it.danger ? "trash" : it.icon;
          const inner = (
            <>
              {icon ? <Icon name={icon} /> : null}
              {it.label}
            </>
          );
          if (it.kind === "form") {
            return (
              <form key={i} action={it.action} method={typeof it.action === "string" ? "post" : undefined}>
                {Object.entries(it.fields ?? {}).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                <button type="submit" className={cls}>{inner}</button>
              </form>
            );
          }
          return (
            <Link key={i} href={it.href} className={cls} scroll={false}>
              {inner}
            </Link>
          );
        })}
      </div>
      <MenuEnhancer />
    </details>
  );
}

/* ------------------------------------------------------------------------- */
/* ConfirmDelete                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The in-page confirm step for a delete (never window.confirm). The page
 * shows it when `?confirm=<id>` is set (the row menu's Delete links there):
 * a danger button that submits the real delete form and a Cancel link back to
 * the URL without the param. Focus moves to it when it appears. Inside a
 * table, render it as `<tr className="sas-confirm-row"><td colSpan={n} data-label="">…`.
 */
export function ConfirmDelete({
  title,
  children,
  action,
  fields,
  cancelHref,
  confirmLabel = t("kit.delete"),
}: {
  /** e.g. "Delete acme.com?" */
  title: string;
  /** What deleting does, in one or two short lines. */
  children?: ReactNode;
  action: FormAction;
  fields?: Record<string, string>;
  cancelHref: string;
  confirmLabel?: string;
}) {
  return (
    <div className="sas-confirm" role="alertdialog" aria-labelledby="sas-confirm-title" tabIndex={-1} data-focus-on-mount="">
      <Icon name="alert-triangle" className="sas-confirm__icon" />
      <div className="sas-confirm__text">
        <strong id="sas-confirm-title">{title}</strong>
        {children ? <span className="sas-small">{children}</span> : null}
      </div>
      <form action={action} method={typeof action === "string" ? "post" : undefined} className="sas-confirm__actions">
        {Object.entries(fields ?? {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <Link href={cancelHref} className={buttonClass("secondary", "sm")} replace scroll={false}>{t("common.cancel")}</Link>
        <button type="submit" className={`${buttonClass("danger", "sm")} sas-btn--danger-solid`}><Icon name="trash" />{confirmLabel}</button>
      </form>
      <FocusOnMount />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* SidePanel                                                                 */
/* ------------------------------------------------------------------------- */

export type PanelTab = { id: string; label: string; href: string };

/**
 * A panel over the list from the end side (400px, or 760px when `wide`),
 * opened by a search param: the page renders it when the param is set, and
 * the X (and Escape, and a click on the light scrim) go to `closeHref`, the
 * URL without it. Header with title and X, optional tabs (links, so they work
 * without JS), a scrolling body and a footer pinned at the bottom for the
 * primary button. A dialog: focus moves in and stays in while it is open.
 * On a phone it is a full-height sheet.
 *
 * A form in the body can be submitted from the footer with `form="<id>"` on
 * the button.
 */
export function SidePanel({
  id = "sas-sidepanel",
  title,
  meta,
  closeHref,
  wide = false,
  tabs,
  currentTab,
  tabsLabel,
  footer,
  children,
}: {
  id?: string;
  title: ReactNode;
  /** Extra header content under the title, e.g. a code and a status pill. */
  meta?: ReactNode;
  closeHref: string;
  wide?: boolean;
  tabs?: PanelTab[];
  currentTab?: string;
  tabsLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <div className={wide ? "sas-sp sas-sp--wide" : "sas-sp"}>
      <Link href={closeHref} className="sas-sp__scrim" aria-hidden="true" tabIndex={-1} replace scroll={false} />
      <section id={id} className="sas-sp__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-sidepanel="">
        <header className="sas-sp__head">
          <div className="sas-sp__titles">
            <h2 id={titleId} className="sas-heading">{title}</h2>
            {meta ? <div className="sas-sp__meta">{meta}</div> : null}
          </div>
          <Link href={closeHref} className="sas-sp__close" aria-label={t("kit.close")} data-sidepanel-close="" replace scroll={false}>
            <Icon name="x" />
          </Link>
        </header>
        {tabs?.length ? (
          <nav className="sas-sp__tabs" aria-label={tabsLabel ?? t("kit.sections")}>
            {tabs.map((tab) => (
              <Link key={tab.id} href={tab.href} className="sas-sp__tab" aria-current={tab.id === currentTab ? "page" : undefined} replace scroll={false}>
                {tab.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="sas-sp__body">{children}</div>
        {footer ? <footer className="sas-sp__foot">{footer}</footer> : null}
        <PanelFocus />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* SummaryStrip                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Rarely changed settings as one row of label/value pairs with an Edit
 * button (a link that opens a SidePanel), plus optional extra actions.
 */
export function SummaryStrip({
  label,
  items,
  editHref,
  editLabel = t("kit.edit"),
  actions,
}: {
  /** Accessible name, e.g. "Price list settings". */
  label: string;
  items: { label: string; value: ReactNode }[];
  editHref?: string;
  editLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <section className="sas-summary" aria-label={label}>
      <dl className="sas-summary__items">
        {items.map((it) => (
          <div key={it.label} className="sas-summary__item">
            <dt>{it.label}</dt>
            <dd>{it.value}</dd>
          </div>
        ))}
      </dl>
      {editHref || actions ? (
        <div className="sas-summary__actions">
          {actions}
          {editHref ? (
            <Link href={editHref} className={buttonClass("secondary", "sm")} scroll={false}>
              <Icon name="pencil" />
              {editLabel}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* TypeTiles                                                                 */
/* ------------------------------------------------------------------------- */

export type TypeTile = {
  id: string;
  icon: IconName;
  title: string;
  /** One short line. */
  line: string;
  /** Opens the tile's panel. */
  href: string;
  /** This tile's panel is open. */
  current?: boolean;
  /** Accepts dropped files (with JS): they go to the DropFileInput with dropKey = id. */
  dropFiles?: boolean;
};

/**
 * A row of compact tiles (icon, title, one line) that open panels. Tiles
 * with `dropFiles` take dropped files and hand them to the DropFileInput
 * (list-kit-client.tsx) in the panel they open; `pageDrop` names the tile
 * that also takes files dropped anywhere on the page. Without JS a tile is
 * just a link.
 */
export function TypeTiles({ label, tiles, pageDrop }: { label: string; tiles: TypeTile[]; pageDrop?: string }) {
  const anyDrop = tiles.some((tile) => tile.dropFiles);
  return (
    <nav className="sas-typetiles" aria-label={label} data-tiles="">
      {tiles.map((tile) => (
        <Link
          key={tile.id}
          href={tile.href}
          className="sas-typetile"
          aria-current={tile.current ? "true" : undefined}
          data-drop-key={tile.dropFiles ? tile.id : undefined}
          scroll={false}
        >
          <span className="sas-typetile__icon"><Icon name={tile.icon} /></span>
          <span className="sas-typetile__text">
            <span className="sas-typetile__title">{tile.title}</span>
            <span className="sas-typetile__line">{tile.line}</span>
          </span>
          {tile.dropFiles ? <span className="sas-typetile__drop" aria-hidden="true">{t("kit.drop_here")}</span> : null}
        </Link>
      ))}
      {anyDrop ? <TileDrop pageDropKey={pageDrop} /> : null}
    </nav>
  );
}

/* ------------------------------------------------------------------------- */
/* ListTable                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The list's table frame: a panel that scrolls sideways on narrow desktops,
 * a `sas-table sas-table--stack` table (cards on a phone; give every td a
 * data-label, the first cell none, the actions cell data-label=""), and an
 * optional footer (totals). Mark the row whose panel is open with
 * data-current on its <tr>. `toolbar` (a ListToolbar without a title: search,
 * chips, selects) sits inside the card above the table, so the rows start higher.
 */
export function ListTable({ caption, children, foot, toolbar }: { caption: string; children: ReactNode; foot?: ReactNode; toolbar?: ReactNode }) {
  return (
    <div className="sas-panel sas-listtable">
      {toolbar ? <div className="sas-listtable__bar">{toolbar}</div> : null}
      <div className="sas-listtable__scroll">
        <table className="sas-table sas-table--stack">
          <caption className="sas-sr">{caption}</caption>
          {children}
        </table>
      </div>
      {foot ? <div className="sas-table-foot">{foot}</div> : null}
    </div>
  );
}
