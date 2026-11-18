import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./icon";
import { t } from "@/lib/i18n";
import { ariaSort, nextSort, type SortDir, type TableSort } from "@/lib/domain/table-sort";

/**
 * A sortable column heading: a link that sorts on the server (the sort is in
 * the URL), with aria-sort on the <th>. `href` builds the link for a sort.
 */
export function SortHeader<K extends string>({
  label, column, sort, firstDir = "asc", href, style,
}: {
  label: ReactNode;
  column: K;
  sort: TableSort<K>;
  firstDir?: SortDir;
  href: (s: TableSort<K>) => string;
  style?: CSSProperties;
}) {
  const state = ariaSort(sort, column);
  return (
    <th scope="col" aria-sort={state} style={style} data-sort-col={column}>
      <a className="sas-sort" href={href(nextSort(sort, column, firstDir))} title={typeof label === "string" ? t("table.sort_by", { column: label }) : undefined}>
        {label}
        <span className="sas-sort__icon" aria-hidden="true" data-dir={state === "none" ? undefined : state}>
          {/* Ascending is the down chevron turned (sas.css), so no new icon meaning. */}
          {state === "none" ? <Icon name="chevrons-up-down" /> : <Icon name="chevron-down" />}
        </span>
      </a>
    </th>
  );
}
