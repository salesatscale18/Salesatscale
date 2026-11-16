"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { llmConfigured } from "@/lib/agent/llm";
import { AnthropicPipelineLlm } from "@/lib/pipeline/llm";
import { executeAnalysis, PipelineRefused, planAnalysis, startAnalysis } from "@/lib/pipeline/service";

const str = (form: FormData, k: string) => String(form.get(k) ?? "");

function back(slug: string, to: string, q: Record<string, string>): never {
  const path = to === "draft" ? `/app/${slug}/setup/playbook/draft` : `/app/${slug}/setup/sources`;
  revalidatePath(`/app/${slug}/setup`, "layout");
  const s = new URLSearchParams(q).toString();
  redirect(`${path}${s ? `?${s}` : ""}#an-h`);
}

/**
 * Starts "Analyze sources" after the seller confirmed the estimate. The run
 * starts only if the sources are unchanged since that estimate (token), no
 * other run is active, the account is under its AI spend cap and an API key is
 * set. The model calls run after the response (`after`), updating the runs'
 * status; the page refreshes while they run. Results reused from an earlier
 * run with the same input make no call at all.
 */
export async function analyzeAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const to = str(form, "back");
  if (!llmConfigured()) back(a.account.slug, to, { analyze_error: "no_key" });
  const plan = await planAnalysis(appDb, a.account.id);
  if (!plan) back(a.account.slug, to, { analyze_error: "nothing" });
  let runs: Awaited<ReturnType<typeof startAnalysis>>;
  try {
    runs = await startAnalysis(appDb, a.account.id, plan, { token: str(form, "token") });
  } catch (e) {
    if (e instanceof PipelineRefused) back(a.account.slug, to, { analyze_error: e.reason });
    throw e;
  }
  await writeAudit(appDb, actorOf(a), {
    accountId: a.account.id, action: "pipeline.started", targetType: "account", targetId: a.account.id,
    details: { estimateMicros: plan.estimate.costMicros, sources: plan.sources.length, changed: plan.changed, facts: runs.factsRunId, playbook: runs.playbookRunId },
  });
  if (!runs.factsRunId && !runs.playbookRunId) {
    // Everything is reused: no model call, only the sources are marked analysed.
    await executeAnalysis(appDb, { create: async () => { throw new Error("no model call expected"); } }, a.account.id, plan, runs);
    back(a.account.slug, to, { analyzed: "1" });
  }
  const accountId = a.account.id;
  after(async () => {
    try {
      await executeAnalysis(appDb, new AnthropicPipelineLlm(), accountId, plan, runs);
    } catch (e) {
      console.error("[pipeline] analysis failed", e);
    }
  });
  back(a.account.slug, to, { analyzing: "1" });
}
