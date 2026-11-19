import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDelete, ListToolbar, RowMenu, SidePanel, SortableTh, SummaryStrip, TypeTiles } from "@/components/sas/list-kit";
import { DropFileInput } from "@/components/sas/list-kit-client";
import { DEMO_PATH, ListKitDemo } from "../fixtures/list-kit-demo";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const amp = (s: string) => s.replace(/&/g, "&amp;");

describe("list kit: ListToolbar", () => {
  const params = { q: "acme", type: "file", status: "failed", sort: "title", dir: "asc", panel: "s1" };
  const out = html(
    <ListToolbar
      path="/p"
      params={params}
      title="Sources"
      label="Find sources"
      search={{ label: "Search sources" }}
      chips={{ param: "type", label: "Type", items: [{ value: null, label: "All", count: 4 }, { value: "file", label: "Files", count: 2 }] }}
      selects={[{ name: "status", label: "Status", value: "failed", options: [{ value: "", label: "Any" }, { value: "failed", label: "Failed" }] }]}
    />,
  );

  it("is a GET search form with the query, a no-JS Apply button and the auto-submit hook", () => {
    expect(out).toMatch(/<form class="sas-listbar__form" role="search" aria-label="Find sources" action="\/p">/);
    expect(out).not.toMatch(/<form[^>]*method="post"/i);
    expect(out).toMatch(/<input type="search"[^>]* name="q" value="acme"\/>/);
    expect(out).toContain('class="sas-btn sas-btn--secondary sas-btn--sm sas-listbar__apply"');
    expect(out).toContain("data-autosubmit");
  });

  it("carries the chip and sort params as hidden inputs, but not the open panel or what the form owns", () => {
    expect(out).toContain('<input type="hidden" name="type" value="file"/>');
    expect(out).toContain('<input type="hidden" name="sort" value="title"/>');
    expect(out).toContain('<input type="hidden" name="dir" value="asc"/>');
    expect(out).not.toContain('name="panel"');
    expect(out).not.toMatch(/type="hidden" name="(q|status)"/);
  });

  it("labels each select and keeps its value", () => {
    expect(out).toMatch(/<span class="sas-sr">Status<\/span><select class="sas-select" name="status">/);
    expect(out).toMatch(/<option value="failed" selected="">Failed<\/option>/);
  });

  it("renders chips as links that set the param, the current one with aria-current and counts", () => {
    expect(out).toContain('role="group" aria-label="Type"');
    expect(out).toContain(`href="${amp("/p?q=acme&status=failed&sort=title&dir=asc")}"`);
    expect(out).toMatch(/aria-current="true" href="\/p\?q=acme&amp;type=file&amp;status=failed&amp;sort=title&amp;dir=asc"/);
    expect(out.match(/aria-current/g)).toHaveLength(1);
    expect(out).toMatch(/>All<span class="sas-fchip__count sas-num">4<\/span>/);
  });

  it("with a phone sort select, sort and dir are owned by the select (key:dir)", () => {
    const withSort = html(
      <ListToolbar path="/p" params={{ sort: "title", dir: "desc" }} search={{ label: "Search" }} sort={{ current: { key: "title", dir: "desc" }, options: [{ key: "title", dir: "desc", label: "Name, Z to A" }] }} />,
    );
    expect(withSort).not.toContain('type="hidden" name="sort"');
    expect(withSort).not.toContain('type="hidden" name="dir"');
    expect(withSort).toMatch(/<select class="sas-select" name="sort"><option value="title:desc" selected="">/);
  });
});

describe("list kit: SortableTh", () => {
  it("links to the same page with sort/dir, sets aria-sort on the active column and flips it", () => {
    const sort = { key: "title", dir: "asc" } as const;
    const active = html(<table><thead><tr><SortableTh column="title" path="/p" params={{ q: "x" }} sort={sort}>Source</SortableTh></tr></thead></table>);
    expect(active).toMatch(/<th scope="col" aria-sort="ascending"/);
    expect(active).toContain(`href="${amp("/p?q=x&sort=title&dir=desc")}"`);
    expect(active).toContain("lucide-arrow-up");

    const other = html(<table><thead><tr><SortableTh column="updated" path="/p" params={{}} sort={sort} firstDir="desc">Updated</SortableTh></tr></thead></table>);
    expect(other).not.toContain("aria-sort");
    expect(other).toContain(`href="${amp("/p?sort=updated&dir=desc")}"`);
  });
});

describe("list kit: RowMenu and ConfirmDelete", () => {
  it("is a details menu (works without JS) with a labelled button, links, forms and a danger item", () => {
    const out = html(
      <RowMenu
        label="More actions for acme.com"
        items={[
          { label: "Open", href: "/p?panel=s1" },
          { kind: "form", label: "Read again", action: "/api/x", fields: { id: "s1" } },
          { label: "Delete", href: "/p?confirm=s1", danger: true },
        ]}
      />,
    );
    expect(out).toMatch(/^<details class="sas-rowmenu"><summary class="sas-rowmenu__button" aria-haspopup="true"/);
    expect(out).toContain('<span class="sas-sr">More actions for acme.com</span>');
    expect(out).toMatch(/<form action="\/api\/x" method="post"><input type="hidden" name="id" value="s1"\/><button type="submit" class="sas-rowmenu__item">Read again/);
    expect(out).toMatch(/class="sas-rowmenu__item sas-rowmenu__item--danger" href="\/p\?confirm=s1"/);
    expect(out).toContain("data-menu-enhancer");
  });

  it("confirm step: an alertdialog with a delete form and a Cancel link back, focused on mount; no window.confirm", () => {
    const out = html(<ConfirmDelete title="Delete acme.com?" action="/api/del" fields={{ id: "s1" }} cancelHref="/p">Gone for good.</ConfirmDelete>);
    expect(out).toMatch(/role="alertdialog" aria-labelledby="sas-confirm-title" tabindex="-1" data-focus-on-mount=""/);
    expect(out).toContain('<strong id="sas-confirm-title">Delete acme.com?</strong>');
    expect(out).toMatch(/<form class="sas-confirm__actions" action="\/api\/del" method="post"><input type="hidden" name="id" value="s1"\/>/);
    expect(out).toMatch(/href="\/p"[^>]*>Cancel<\/a><button type="submit"[^>]*><svg[^>]*lucide-trash[\s\S]*?<\/svg>Delete<\/button>/); // R4 B1: trash icon
    expect(out).not.toContain("confirm(");
  });
});

describe("list kit: SidePanel", () => {
  const out = html(
    <SidePanel
      wide
      title="Gateway"
      meta="GW-10"
      closeHref="/p?q=a"
      tabs={[{ id: "details", label: "Details", href: "/p?panel=x" }, { id: "facts", label: "Facts", href: "/p?panel=x&tab=facts" }]}
      currentTab="facts"
      footer={<button type="submit" form="f">Save</button>}
    >
      <form id="f"><input name="n" /></form>
    </SidePanel>,
  );

  it("is a labelled modal dialog with the focus-trap hook", () => {
    expect(out).toContain('class="sas-sp sas-sp--wide"');
    expect(out).toMatch(/role="dialog" aria-modal="true" aria-labelledby="sas-sidepanel-title" tabindex="-1" data-sidepanel=""/);
    expect(out).toContain('<h2 id="sas-sidepanel-title" class="sas-heading">Gateway</h2>');
    expect(out).toContain("data-panel-focus");
  });

  it("closes by links to the URL without the param (X and scrim), so it works without JS", () => {
    expect(out).toMatch(/<a class="sas-sp__scrim" aria-hidden="true" tabindex="-1" href="\/p\?q=a"/);
    expect(out).toMatch(/<a class="sas-sp__close" aria-label="Close" data-sidepanel-close="" href="\/p\?q=a"/);
  });

  it("renders tabs as links with aria-current and pins the footer after the body", () => {
    expect(out).toMatch(/<nav class="sas-sp__tabs" aria-label="Sections">/);
    expect(out).toMatch(/class="sas-sp__tab" aria-current="page" href="\/p\?panel=x&amp;tab=facts"/);
    expect(out).toMatch(/<div class="sas-sp__body">.*<\/div><footer class="sas-sp__foot"><button type="submit" form="f">Save<\/button><\/footer>/);
  });

  it("is 400px by default (no wide class) and has no tabs or footer unless given", () => {
    const plain = html(<SidePanel title="Add a note" closeHref="/p">Body</SidePanel>);
    expect(plain).toContain('<div class="sas-sp">');
    expect(plain).not.toContain("sas-sp__tabs");
    expect(plain).not.toContain("sas-sp__foot");
  });
});

describe("list kit: SummaryStrip and TypeTiles", () => {
  it("summary strip lists label/value pairs and an Edit link", () => {
    const out = html(<SummaryStrip label="Price list settings" items={[{ label: "Currency", value: "ILS" }]} editHref="/p?panel=settings" />);
    expect(out).toMatch(/<section class="sas-summary" aria-label="Price list settings"><dl/);
    expect(out).toContain("<dt>Currency</dt><dd>ILS</dd>");
    expect(out).toMatch(/href="\/p\?panel=settings"[^>]*>.*Edit<\/a>/);
  });

  it("tiles are links to their panels; file tiles are drop targets with the drop hook", () => {
    const out = html(
      <TypeTiles
        label="Add a source"
        pageDrop="files"
        tiles={[
          { id: "website", icon: "link-2", title: "Website", line: "Pages", href: "/p?panel=website", current: true },
          { id: "files", icon: "upload", title: "Files", line: "PDF", href: "/p?panel=files", dropFiles: true },
        ]}
      />,
    );
    expect(out).toMatch(/<nav class="sas-typetiles" aria-label="Add a source" data-tiles="">/);
    expect(out).toMatch(/class="sas-typetile" aria-current="true" href="\/p\?panel=website"/);
    expect(out).toMatch(/class="sas-typetile" data-drop-key="files" href="\/p\?panel=files"/);
    expect(out).toContain("data-tile-drop");
    const noDrop = html(<TypeTiles label="x" tiles={[{ id: "a", icon: "plus", title: "A", line: "a", href: "/a" }]} />);
    expect(noDrop).not.toContain("data-tile-drop");
  });

  it("the drop input is a plain file input without JS", () => {
    expect(html(<DropFileInput dropKey="files" name="files" multiple />)).toBe('<input type="file" data-drop-input="files" multiple="" name="files"/>');
  });
});

describe("list kit: demo page", () => {
  it("renders the list with sorted rows, stacked-card labels and no panel by default", () => {
    const out = html(<ListKitDemo params={{}} />);
    expect(out).toContain('class="sas-table sas-table--stack"');
    expect(out).toContain('data-label="Facts found"');
    expect(out).not.toContain('role="dialog"');
    // Default sort: updated, newest first.
    const order = ["Installation guide.pdf", "Price list 2026.xlsx", "acme-sensors.com", "Warranty terms"].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toMatch(/aria-sort="descending"[^>]*><a[^>]*>Updated/);
  });

  it("opens the wide panel from ?panel and highlights the row; confirm=<id> shows the confirm row", () => {
    const out = html(<ListKitDemo params={{ panel: "s2", tab: "facts", confirm: "s1" }} />);
    expect(out).toContain('class="sas-sp sas-sp--wide"');
    expect(out).toMatch(/<tr data-current="">/);
    expect(out).toMatch(/class="sas-sp__tab" aria-current="page"[^>]*>Facts</);
    expect(out).toContain('class="sas-confirm-row"');
    expect(out).toContain(`href="${DEMO_PATH}?panel=s2&amp;tab=facts"`);
  });

  it("filters by chip and search", () => {
    const out = html(<ListKitDemo params={{ type: "file", q: "price" }} />);
    expect(out).toContain("Price list 2026.xlsx");
    expect(out).not.toContain("Installation guide.pdf</strong>");
  });
});
