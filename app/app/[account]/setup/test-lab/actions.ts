"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { AnthropicLlm, llmConfigured } from "@/lib/agent/llm";
import { getConversation, publishDraftVersion, rollbackTo, startTestConversation } from "@/lib/agent/service";
import { runBuyerTurn } from "@/lib/agent/turn";
import { scenarioById } from "@/lib/agent/scenarios";

const path = (slug: string) => `/app/${slug}/setup/test-lab`;
const access = (form: FormData) => requireAccount(String(form.get("slug") ?? ""));

export async function publishAction(form: FormData) {
  const a = await access(form);
  const v = await publishDraftVersion(appDb, actorOf(a), a.account.id);
  revalidatePath(path(a.account.slug));
  redirect(v ? `${path(a.account.slug)}?published=${v}` : path(a.account.slug));
}

export async function rollbackAction(form: FormData) {
  const a = await access(form);
  const v = await rollbackTo(appDb, actorOf(a), a.account.id, String(form.get("versionId") ?? ""));
  revalidatePath(path(a.account.slug));
  redirect(v ? `${path(a.account.slug)}?rolledback=${v}` : path(a.account.slug));
}

export async function startChatAction(form: FormData) {
  const a = await access(form);
  // A scenario brings its own buyer language, if the account speaks it.
  const scenario = scenarioById(String(form.get("scenario") ?? ""));
  const wanted = scenario?.language ?? String(form.get("language"));
  const language = a.account.languages.includes(wanted) ? wanted : a.account.languages[0] ?? "en";
  const r = await startTestConversation(appDb, a.account.id, a.user.id, {
    language, scenario: scenario && scenario.language === language ? scenario.id : null, versionId: String(form.get("versionId") ?? "") || undefined,
  });
  redirect(r ? `${path(a.account.slug)}?c=${r.conversationId}` : path(a.account.slug));
}

export async function sendTestMessageAction(form: FormData) {
  const a = await access(form);
  const conversationId = String(form.get("conversationId") ?? "");
  const text = String(form.get("text") ?? "").trim();
  const conv = await getConversation(appDb, a.account.id, conversationId);
  if (!conv || !conv.isTest) redirect(path(a.account.slug));
  const back = `${path(a.account.slug)}?c=${conversationId}`;
  if (!text) redirect(back);
  // While a person handles the chat the model is not called, so no key is needed.
  if (conv.status !== "human" && !llmConfigured()) redirect(`${back}&error=no_key`);
  const r = await runBuyerTurn(appDb, new AnthropicLlm(), { accountId: a.account.id, conversationId, text });
  redirect(r.status === "error" ? `${back}&error=model` : `${back}#end`);
}
