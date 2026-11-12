import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type DB = NeonHttpDatabase<typeof schema>;

let _db: DB | undefined;

function getDb(): DB {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _db = drizzle({ client: neon(url), schema });
  }
  return _db;
}

/**
 * Drizzle client over Neon's HTTP driver. The connection is created lazily on
 * first use, so importing this module never fails at build time when
 * DATABASE_URL is absent.
 */
export const db = new Proxy({} as DB, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { schema };
