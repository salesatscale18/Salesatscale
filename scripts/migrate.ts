/**
 * Runs Drizzle migrations during the Vercel build — PRODUCTION ONLY.
 *
 * Preview deployments currently share the Production database (no separate
 * Neon branch for Preview yet), so running migrations from a preview build
 * would apply unreviewed schema changes to production. Anything other than
 * VERCEL_ENV === "production" is skipped.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const env = process.env.VERCEL_ENV;

  if (env !== "production") {
    console.log(`[migrate] VERCEL_ENV=${env ?? "(unset)"} — skipping migrations (they only run on production builds).`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[migrate] DATABASE_URL is not set on a production build.");
  }

  console.log("[migrate] Running migrations from ./drizzle ...");
  const db = drizzle({ client: neon(url) });
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] Done.");
}

main().catch((err) => {
  console.error("[migrate] Migration failed:", err);
  process.exit(1);
});
