"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { isFactStatus, parseFactInput } from "@/lib/agent/knowledge";
import { addFact, answerQuestion, removeFact, setFactStatus, updateFact } from "@/lib/agent/service";
import { approveAllSuggestedFacts, resolveContradiction, resolveFactConflict } from "@/lib/pipeline/service";
import { listQuery } from "@/lib/knowledge/facts-list";

const str = (form: FormData, k: string) => String(form.get(k) ?? "");

/**
 * Back to the knowledge page, keeping the list as the seller left it: the
 * hidden "list" field carries the topic, search, chips, source and sort (only
 * those keys survive); older forms send just the topic as "filter".
 */
function back(slug: string, form: FormData, extra: Record<string, string> = {}): never {
  const list = form.has("list") ? listQuery(str(form, "list")) : (str(form, "filter") ? { topic: str(form, "filter") } : {});
  const q = new URLSearchParams({ ...list, ...extra }).toString();
  revalidatePath(`/app/${slug}/setup/knowledge`);
  redirect(`/app/${slug}/setup/knowledge${q ? `?${q}` : ""}`);
}

/** Topic from the fact panel (one field: pick a topic or type a new one); an older form's "newTopic" still wins. */
function chosenTopic(form: FormData) {
  return str(form, "newTopic").trim() || str(form, "topic").trim();
}

export async function addFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const parsed = parseFactInput({ topic: chosenTopic(form), statement: str(form, "statement"), source: str(form, "source") });
  if (!parsed.ok) back(a.account.slug, form, { panel: "new", error: Object.keys(parsed.errors)[0] });
  const f = await addFact(appDb, actorOf(a), a.account.id, { ...parsed.value, status: "approved" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_added", targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, form, { done: "added" });
}

export async function updateFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const id = str(form, "factId");
  const parsed = parseFactInput({ topic: str(form, "topic"), statement: str(form, "statement"), source: str(form, "source") });
  if (!parsed.ok) back(a.account.slug, form, { panel: id, error: Object.keys(parsed.errors)[0] });
  const f = await updateFact(appDb, a.account.id, id, parsed.value);
  if (!f) back(a.account.slug, form, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_edited", targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, form, { done: "saved" });
}

export async function setFactStatusAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const status = str(form, "status");
  if (!isFactStatus(status)) back(a.account.slug, form, { error: "missing" });
  const f = await setFactStatus(appDb, a.account.id, str(form, "factId"), status);
  if (!f) back(a.account.slug, form, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: `knowledge.fact_${status}`, targetType: "knowledge_fact", targetId: f.id });
  back(a.account.slug, form, { done: status });
}

export async function approveAllAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const topic = str(form, "filter");
  // No topic: every topic ("Approve all suggested" on All topics). Facts in an open contradiction wait for the seller's choice.
  if (!topic && str(form, "scope") !== "all") back(a.account.slug, form);
  const n = await approveAllSuggestedFacts(appDb, a.account.id, topic || undefined);
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.approved_all", details: { topic, count: n } });
  back(a.account.slug, form, { done: "approved_all", n: String(n) });
}

export async function removeFactAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const id = str(form, "factId");
  if (!(await removeFact(appDb, a.account.id, id))) back(a.account.slug, form, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_removed", targetType: "knowledge_fact", targetId: id });
  back(a.account.slug, form, { done: "removed" });
}

/** Saves every filled-in answer as an approved fact; empty answers are skipped. */
export async function answerQuestionsAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const question = str(form, `q.${i}.question`);
    const answer = str(form, `q.${i}.answer`).trim().slice(0, 1000);
    if (!question || !answer) continue;
    const topic = str(form, `q.${i}.topic`).trim().slice(0, 60) || "General";
    if (await answerQuestion(appDb, actorOf(a), a.account.id, { question: question.slice(0, 300), answer, topic })) n++;
  }
  // From the Answer panel (one question): an empty answer reopens it. "Save and answer next" opens the next open question.
  const single = str(form, "q.0.question");
  const next = form.has("panel") ? str(form, "next").slice(0, 300) : "";
  back(a.account.slug, form, n ? { done: "answered", n: String(n), ...(next && next !== single ? { panel: "answer", question: next } : {}) } : { error: "answer", ...(form.has("panel") && single ? { panel: "answer", question: single.slice(0, 300) } : {}) });
}

/** A contradiction: the chosen side is approved and the others rejected, or a typed answer becomes the approved fact. */
export async function resolveContradictionAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const choice = str(form, "choice");
  if (!choice) back(a.account.slug, form, { error: "choice" });
  const ok = await resolveContradiction(appDb, actorOf(a), a.account.id, {
    runId: str(form, "runId"), index: Number(str(form, "index")) || 0, choice, other: str(form, "other").slice(0, 1000),
  });
  back(a.account.slug, form, ok ? { done: "resolved" } : { error: choice === "other" ? "other" : "missing" });
}

/**
 * A suggestion that differs from an approved fact: "replace" approves it and
 * retires the approved fact, "keep" rejects it (checked on the server: only
 * while the suggestion is still open for this account).
 */
export async function resolveFactConflictAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const choice = str(form, "choice");
  if (choice !== "replace" && choice !== "keep") back(a.account.slug, form, { error: "missing" });
  const ok = await resolveFactConflict(appDb, actorOf(a), a.account.id, { factId: str(form, "factId"), choice: choice as "replace" | "keep" });
  back(a.account.slug, form, ok ? { done: choice === "replace" ? "replaced" : "kept" } : { error: "missing" });
}
