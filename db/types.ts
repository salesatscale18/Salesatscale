import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database with our schema: the Neon HTTP client in the
 * app, PGlite in tests. Data-access functions take a `Db` instead of
 * importing the global `db`, so integration tests can run them in-process.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
