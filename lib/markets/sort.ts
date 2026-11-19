/**
 * Sorting lists by market name (Leads, Quotes and orders: the "Market" column).
 * A row with no market id belongs to the home market, so it sorts under the
 * home market's name, not as an empty name.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { markets } from "@/db/schema";

/**
 * The lower-cased market name of a row for ORDER BY. `marketName` is the name
 * column of the markets table joined on the row's market id (left join), and
 * `accountId` the row's account column (for the home market of null rows).
 */
export function marketNameSort(marketName: AnyPgColumn, accountId: AnyPgColumn): SQL {
  return sql`lower(coalesce(${marketName}, (select h.name from ${markets} h where h.account_id = ${accountId} and h.is_home limit 1), ''))`;
}
