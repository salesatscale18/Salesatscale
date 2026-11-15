/**
 * All-or-nothing multi-row writes (decision D12).
 *
 * The Neon HTTP driver has no interactive transactions, but `db.batch()` runs
 * its statements in one transaction. `build` receives the handle to build the
 * statements on and returns them; IDs are generated in the app
 * (crypto.randomUUID) so rows in one batch can reference each other.
 * On PGlite (tests) the statements run inside `db.transaction()`.
 */
import type { Db } from "./types";

type Statement = PromiseLike<unknown>;

export async function atomic(db: Db, build: (q: Db) => Statement[]): Promise<void> {
  const withBatch = db as unknown as { batch?: (s: readonly unknown[]) => Promise<unknown> };
  if (typeof withBatch.batch === "function") {
    const statements = build(db);
    if (statements.length === 0) return;
    await withBatch.batch(statements);
    return;
  }
  await db.transaction(async (tx) => {
    for (const s of build(tx as unknown as Db)) await s;
  });
}
