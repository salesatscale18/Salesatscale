/**
 * Demo page for the list kit (not a route): renders every component with a
 * small fake list, driven by search params like a real page. Used by
 * tests/unit/list-kit-render.test.tsx and for the visual check.
 */
import { Icon } from "@/components/sas/icon";
import { Button, buttonClass } from "@/components/sas/primitives";
import {
  ConfirmDelete, ListTable, ListToolbar, RowMenu, SidePanel, SortableTh, SummaryStrip, TypeTiles,
} from "@/components/sas/list-kit";
import { DropFileInput } from "@/components/sas/list-kit-client";
import { firstParam, hrefWith, sortParams, sortRows, type SearchParamsLike } from "@/lib/list-kit";

export const DEMO_PATH = "/app/demo/setup/sources";

type Row = { id: string; title: string; detail: string; type: "website" | "file" | "note"; language: string; facts: number | null; updated: Date };

export const DEMO_ROWS: Row[] = [
  { id: "s1", title: "acme-sensors.com", detail: "12 pages", type: "website", language: "English", facts: 34, updated: new Date("2026-11-12T10:00:00Z") },
  { id: "s2", title: "Price list 2026.xlsx", detail: "Catalog spreadsheet", type: "file", language: "Hebrew", facts: 18, updated: new Date("2026-11-15T09:30:00Z") },
  { id: "s3", title: "Warranty terms", detail: "Note", type: "note", language: "English", facts: null, updated: new Date("2026-11-02T16:00:00Z") },
  { id: "s4", title: "Installation guide.pdf", detail: "24 pages", type: "file", language: "English", facts: 7, updated: new Date("2026-11-17T08:15:00Z") },
];

const SORTS = ["title", "facts", "updated"] as const;
const TYPE_LABEL = { website: "Website", file: "File", note: "Note" } as const;

/** Stands in for a server action. */
async function deleteSource(formData: FormData) {
  void formData;
}

export function ListKitDemo({ params }: { params: SearchParamsLike }) {
  const path = DEMO_PATH;
  const sort = sortParams(params, SORTS, { key: "updated", dir: "desc" });
  const type = firstParam(params, "type");
  const q = (firstParam(params, "q") ?? "").toLowerCase();
  const panel = firstParam(params, "panel");
  const tab = firstParam(params, "tab") ?? "details";
  const confirm = firstParam(params, "confirm");
  const filtered = DEMO_ROWS.filter((r) => (!type || r.type === type) && (!q || r.title.toLowerCase().includes(q)));
  const rows = sortRows(filtered, sort.key, sort.dir, { title: (r) => r.title, facts: (r) => r.facts, updated: (r) => r.updated });
  const count = (tp?: Row["type"]) => DEMO_ROWS.filter((r) => !tp || r.type === tp).length;
  const close = hrefWith(path, params, { panel: null, tab: null });
  const open = (id: string) => hrefWith(path, params, { panel: id });

  return (
    <div className="sas-stack-4" style={{ padding: 16 }}>
      <ListToolbar
        path={path}
        params={params}
        title="Sources"
        titleLevel={1}
        label="Find sources"
        actions={<a className={buttonClass("primary")} href={open("new")}><Icon name="plus" />Add source</a>}
        search={{ label: "Search sources", placeholder: "Search sources" }}
        chips={{
          param: "type",
          label: "Type",
          items: [
            { value: null, label: "All", count: count() },
            { value: "website", label: "Websites", count: count("website") },
            { value: "file", label: "Files", count: count("file") },
            { value: "note", label: "Notes", count: count("note") },
          ],
        }}
        selects={[
          { name: "status", label: "Status", value: firstParam(params, "status"), options: [{ value: "", label: "Any status" }, { value: "ready", label: "Ready for review" }, { value: "failed", label: "Failed" }] },
          { name: "lang", label: "Language", value: firstParam(params, "lang"), options: [{ value: "", label: "Any language" }, { value: "en", label: "English" }, { value: "he", label: "Hebrew" }] },
        ]}
        sort={{
          current: sort,
          options: [
            { key: "updated", dir: "desc", label: "Updated, newest first" },
            { key: "updated", dir: "asc", label: "Updated, oldest first" },
            { key: "title", dir: "asc", label: "Name, A to Z" },
            { key: "facts", dir: "desc", label: "Most facts first" },
          ],
        }}
      />

      <TypeTiles
        label="Add a source"
        pageDrop="files"
        tiles={[
          { id: "website", icon: "link-2", title: "Website", line: "Pages the agent may read", href: open("website"), current: panel === "website" },
          { id: "files", icon: "upload", title: "Files", line: "PDF, Word, CSV or Excel", href: open("files"), current: panel === "files", dropFiles: true },
          { id: "note", icon: "file-text", title: "Note", line: "Write facts by hand", href: open("note"), current: panel === "note" },
        ]}
      />

      <SummaryStrip
        label="Analysis"
        items={[
          { label: "Changed since last analysis", value: "2 sources" },
          { label: "Estimated cost", value: "$0.04" },
          { label: "Last run", value: "15 Nov, 10:02" },
        ]}
        editHref={open("settings")}
        actions={<Button size="sm" variant="primary">Analyze sources</Button>}
      />

      <ListTable caption="Your sources" foot={<><span>{rows.length} sources</span><span>1 needs you</span></>}>
        <thead>
          <tr>
            <SortableTh column="title" path={path} params={params} sort={sort}>Source</SortableTh>
            <th scope="col">Type</th>
            <th scope="col">Language</th>
            <SortableTh column="facts" path={path} params={params} sort={sort} firstDir="desc" align="end">Facts found</SortableTh>
            <SortableTh column="updated" path={path} params={params} sort={sort} firstDir="desc">Updated</SortableTh>
            <th scope="col"><span className="sas-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) => {
            const row = (
              <tr key={r.id} data-current={panel === r.id ? "" : undefined}>
                <td>
                  <a className="sas-row-link" href={open(r.id)}>
                    <strong>{r.title}</strong>
                    <span className="sas-small">{r.detail}</span>
                  </a>
                </td>
                <td data-label="Type">{TYPE_LABEL[r.type]}</td>
                <td data-label="Language">{r.language}</td>
                <td data-label="Facts found" className="sas-num" style={{ textAlign: "end" }}>{r.facts ?? "—"}</td>
                <td data-label="Updated" className="sas-when">{r.updated.toISOString().slice(0, 10)}</td>
                <td data-label="" className="sas-td-actions">
                  <RowMenu
                    label={`More actions for ${r.title}`}
                    items={[
                      { label: "Open", href: open(r.id), icon: "eye" },
                      { label: "Read again", kind: "form", action: deleteSource, fields: { id: r.id }, icon: "refresh-cw" },
                      { label: "Delete", href: hrefWith(path, params, { confirm: r.id }), icon: "x-circle", danger: true },
                    ]}
                  />
                </td>
              </tr>
            );
            if (confirm !== r.id) return [row];
            return [
              row,
              <tr key={`${r.id}-confirm`} className="sas-confirm-row">
                <td colSpan={6} data-label="">
                  <ConfirmDelete title={`Delete ${r.title}?`} action={deleteSource} fields={{ id: r.id }} cancelHref={hrefWith(path, params, { confirm: null })}>
                    Its facts stay in Knowledge until you remove them.
                  </ConfirmDelete>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </ListTable>

      {panel === "files" ? (
        <SidePanel title="Add files" closeHref={close} footer={<button type="submit" form="demo-files" className={buttonClass("primary")}>Upload</button>}>
          <form id="demo-files" className="sas-stack-4">
            <label className="sas-input-group">
              <span className="sas-input-label">Files</span>
              <DropFileInput dropKey="files" name="files" multiple accept=".pdf,.docx,.csv,.xlsx" />
              <span className="sas-hint">PDF, Word, CSV or Excel, up to 20 MB each.</span>
            </label>
          </form>
        </SidePanel>
      ) : null}

      {panel && DEMO_ROWS.some((r) => r.id === panel) ? (
        <SidePanel
          wide
          title={DEMO_ROWS.find((r) => r.id === panel)!.title}
          meta={<><span className="sas-nowrap">{panel.toUpperCase()}</span><span className="sas-pill sas-pill--success">Ready</span></>}
          closeHref={close}
          tabs={[
            { id: "details", label: "Details", href: hrefWith(path, params, { tab: null }, ["confirm"]) },
            { id: "facts", label: "Facts", href: hrefWith(path, params, { tab: "facts" }, ["confirm"]) },
            { id: "history", label: "History", href: hrefWith(path, params, { tab: "history" }, ["confirm"]) },
          ]}
          currentTab={tab}
          footer={
            <>
              <button type="submit" form="demo-item" className={buttonClass("primary")}>Save</button>
              <a className={buttonClass("ghost")} href={close}>Cancel</a>
              <span className="sas-small" style={{ marginInlineStart: "auto" }}>Saved to draft 3</span>
            </>
          }
        >
          <form id="demo-item" className="sas-stack-4">
            <label className="sas-input-group">
              <span className="sas-input-label">Name</span>
              <input className="sas-input" name="name" defaultValue={DEMO_ROWS.find((r) => r.id === panel)!.title} data-autofocus="" />
            </label>
            <label className="sas-input-group">
              <span className="sas-input-label">Description</span>
              <textarea className="sas-textarea" name="description" rows={6} />
            </label>
          </form>
        </SidePanel>
      ) : null}
    </div>
  );
}
