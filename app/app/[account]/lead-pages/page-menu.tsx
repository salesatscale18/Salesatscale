import Link from "next/link";
import { MenuEnhancer } from "@/components/sas/list-kit-client";
import { Icon, type IconName } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import type { LeadPage } from "@/db/schema";
import { t, type MessageKey } from "@/lib/i18n";
import { isArchived } from "@/lib/lead-pages/archive";
import { ConfirmBlock } from "./confirm-block";
import { archiveLeadPageAction, deleteLeadPageAction, setLeadPageStatusAction, unarchiveLeadPageAction } from "./actions";
import { PendingButton, PendingMenuItem } from "./pending-button";

type Where = { slug: string; back: "list" | "page"; showArchived?: boolean };

/** Notices after a ⋯ menu action (?done=) and its refusals (?way_error=), on the list and the page view. */
export const DONE: Record<string, MessageKey> = {
  deleted: "lead_pages.done.deleted", archived: "lead_pages.done.archived", unarchived: "lead_pages.done.unarchived",
  paused: "lead_pages.saved.paused", live: "lead_pages.saved.live",
};
export const WAY_ERROR: Record<string, MessageKey> = {
  has_submissions: "lead_pages.way_error.has_submissions", no_submissions: "lead_pages.way_error.no_submissions",
  not_archived: "lead_pages.way_error.not_archived", archived: "lead_pages.way_error.archived",
};

/**
 * A page's ⋯ menu (a list row and the page view; the list kit's <details> menu, MenuEnhancer
 * adds keys, Escape and click outside): Edit, Pause or Resume, then Delete (a page with no
 * real submissions: a link to the confirm step) or Archive (one with them); Edit and Unarchive
 * on an archived page. Which applies comes from `hasRealSubmissions`, read on the server;
 * every action checks it again when it runs.
 */
export function LeadPageMenu({ page, hasRealSubmissions, confirmHref, where }: { page: LeadPage; hasRealSubmissions: boolean; confirmHref: string; where: Where }) {
  const archived = isArchived(page);
  const base = `/app/${where.slug}/lead-pages`;
  const fields = (
    <>
      <input type="hidden" name="slug" value={where.slug} />
      <input type="hidden" name="pageId" value={page.id} />
      {where.back === "list" ? <input type="hidden" name="back" value="list" /> : null}
      {where.showArchived ? <input type="hidden" name="archived" value="1" /> : null}
    </>
  );
  const item = (action: (f: FormData) => Promise<void>, label: string, icon: IconName, op: string, extra?: Record<string, string>) => (
    <form action={action} data-menu-op={op}>
      {fields}
      {Object.entries(extra ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <PendingMenuItem className="sas-rowmenu__item" icon={<Icon name={icon} />}>{label}</PendingMenuItem>
    </form>
  );
  const label = t("lead_pages.menu.label", { name: page.name });
  return (
    <details className="sas-rowmenu lpg-menu" data-page-menu={page.id}>
      <summary className="sas-rowmenu__button" aria-haspopup="true" title={label}>
        <Icon name="ellipsis" />
        <span className="lpg-spin lpg-menu__spin" aria-hidden="true" />
        <span className="sas-sr">{label}</span>
      </summary>
      <div className="sas-rowmenu__list">
        <Link className="sas-rowmenu__item" href={`${base}/${page.id}/edit`} data-menu-op="edit"><Icon name="pencil" />{t("lead_pages.detail.edit")}</Link>
        {!archived && page.status === "live" ? item(setLeadPageStatusAction, t("lead_pages.detail.pause"), "pause", "pause", { op: "pause" }) : null}
        {!archived && page.status === "paused" ? item(setLeadPageStatusAction, t("lead_pages.detail.resume"), "play", "resume", { op: "resume" }) : null}
        {archived ? item(unarchiveLeadPageAction, t("lead_pages.menu.unarchive"), "rotate-ccw", "unarchive") : null}
        {!archived && hasRealSubmissions ? item(archiveLeadPageAction, t("lead_pages.menu.archive"), "archive", "archive") : null}
        {!archived && !hasRealSubmissions ? (
          <Link className="sas-rowmenu__item sas-rowmenu__item--danger" href={confirmHref} scroll={false} data-menu-op="delete"><Icon name="trash" />{t("lead_pages.menu.delete")}</Link>
        ) : null}
      </div>
      <MenuEnhancer />
    </details>
  );
}

/**
 * The delete confirm step (`?confirm=<pageId>`): names the page and what goes with it; test
 * leads stay in Leads. The button shows that it is working, and a second press is not sent.
 */
export function LeadPageDeleteConfirm({ page, testLeads, cancelHref, where }: { page: LeadPage; testLeads: number; cancelHref: string; where: Where }) {
  return (
    <ConfirmBlock
      title={t("lead_pages.delete.title", { name: page.name })}
      cancelHref={cancelHref}
      action={deleteLeadPageAction}
      fields={{ slug: where.slug, pageId: page.id, ...(where.back === "list" ? { back: "list" } : {}), ...(where.showArchived ? { archived: "1" } : {}) }}
      submit={<PendingButton className={`${buttonClass("danger", "sm")} sas-btn--danger-solid`} icon={<Icon name="trash" />}>{t("lead_pages.delete.confirm")}</PendingButton>}
    >
      {t("lead_pages.delete.body")}
      {testLeads > 0 ? <> <span data-confirm-test-leads={testLeads}>{t(testLeads === 1 ? "lead_pages.delete.test_leads_one" : "lead_pages.delete.test_leads", { count: testLeads })}</span></> : null}
    </ConfirmBlock>
  );
}
