import { NextResponse } from "next/server";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listRuns, runningRun } from "@/lib/pipeline/service";

export const dynamic = "force-dynamic";

/**
 * The source analysis status for the on-screen notice (components/sas/analysis-notice.tsx):
 * whether a run is going, and how the latest one ended. Read only; any member of the account.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  const [running, [last]] = await Promise.all([runningRun(appDb, account.id), listRuns(appDb, account.id, 1)]);
  return NextResponse.json(
    { running: !!running, last: last ? { id: last.id, status: last.status, error: last.error, finishedAt: last.finishedAt?.toISOString() ?? null } : null },
    { headers: { "cache-control": "no-store" } },
  );
}
