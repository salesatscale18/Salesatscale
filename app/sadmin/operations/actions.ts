"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";
import { appDb, requireSuperAdmin } from "@/lib/auth/account";
import { llmConfigured } from "@/lib/agent/llm";
import { runModelsCheck } from "@/lib/ai/availability";

/**
 * "Check models": asks the Models API about each configured model id. Free
 * (no tokens). Super admin only, checked here: actions are public endpoints.
 * A check from the last 10 minutes is reused; each real check is audited.
 */
export async function checkModelsAction() {
  const me = await requireSuperAdmin();
  if (!llmConfigured()) redirect("/sadmin/operations?error=no_key");
  await runModelsCheck(appDb, new Anthropic(), me.id);
  revalidatePath("/sadmin/operations");
  redirect("/sadmin/operations#ai");
}
