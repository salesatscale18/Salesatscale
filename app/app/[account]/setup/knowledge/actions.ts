"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { isFactStatus, parseFactInput } from "@/lib/agent/knowledge";
import { addFact, answerQuestion, approveAllSuggested, removeFact, setFactStatus, updateFact } from "@/lib/agent/service";

const str = (form: FormData, k: string) => String(form.get(k) ?? "");

/** Back to the knowledge page, keeping the topic filter. */
function back(slug: string, topic: string, extra: Record<string, string> = {}): never {
  const q = new URLSearchParams({ ...(topic ? { topic } : {}), ...extra }).toString();
  revalidatePath(`/app/${slug}/setup/knowledge`);
  redirect(`/app/${slug}/setup/knowledge${q ? `?${q}` : ""}`);
}

/** Topic from the add form: a new topic typed in wins over the chosen one. */
function chosenTopic(form: FormData) {
  return str(form, "newTopic").trim() || str(form, "topic").trim();
}

export async function addFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const filter = str(form, "filter");
  const parsed = parseFactInput({ topic: chosenTopic(form), statement: str(form, "statement"), source: str(form, "source") });
  if (!parsed.ok) back(a.account.slug, filter, { error: Object.keys(parsed.errors)[0] });
  const f = await addFact(appDb, actorOf(a), a.account.id, { ...parsed.value, status: "approved" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_added", targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, filter, { done: "added" });
}

export async function updateFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const filter = str(form, "filter");
  const id = str(form, "factId");
  const parsed = parseFactInput({ topic: str(form, "topic"), statement: str(form, "statement"), source: str(form, "source") });
  if (!parsed.ok) back(a.account.slug, filter, { edit: id, error: Object.keys(parsed.errors)[0] });
  const f = await updateFact(appDb, a.account.id, id, parsed.value);
  if (!f) back(a.account.slug, filter, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_edited", targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, filter, { done: "saved" });
}

export async function setFactStatusAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const filter = str(form, "filter");
  const status = str(form, "status");
  if (!isFactStatus(status)) back(a.account.slug, filter, { error: "missing" });
  const f = await setFactStatus(appDb, a.account.id, str(form, "factId"), status);
  if (!f) back(a.account.slug, filter, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: `knowledge.fact_${status}`, targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, filter, { done: status });
}

export async function approveAllAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const topic = str(form, "filter");
  if (!topic) back(a.account.slug, "");
  const n = await approveAllSuggested(appDb, a.account.id, topic);
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.approved_all", details: { topic, count: n } });
  back(a.account.slug, topic, { done: "approved_all", n: String(n) });
}

export async function removeFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const filter = str(form, "filter");
  const id = str(form, "factId");
  if (!(await removeFact(appDb, a.account.id, id))) back(a.account.slug, filter, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_removed", targetType: "knowledge_fact", targetId: id });
  back(a.account.slug, filter, { done: "removed" });
}

/** Saves every filled-in answer as an approved fact; empty answers are skipped. */
export async function answerQuestionsAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const filter = str(form, "filter");
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const question = str(form, `q.${i}.question`);
    const answer = str(form, `q.${i}.answer`).trim().slice(0, 1000);
    if (!question || !answer) continue;
    const topic = str(form, `q.${i}.topic`).trim().slice(0, 60) || "General";
    if (await answerQuestion(appDb, actorOf(a), a.account.id, { question: question.slice(0, 300), answer, topic })) n++;
  }
  back(a.account.slug, filter, n ? { done: "answered", n: String(n) } : { error: "answer" });
}
