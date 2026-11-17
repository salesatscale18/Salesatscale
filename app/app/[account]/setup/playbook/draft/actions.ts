"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { isUuid } from "@/lib/security/ids";
import { acceptAllSuggestions, decideSuggestion, EDITABLE, editSuggestion, saveSuggestionsToDraft } from "@/lib/pipeline/service";
import { suggestionSection, type SuggestionKind } from "@/lib/pipeline/validate";

const str = (form: FormData, k: string) => String(form.get(k) ?? "");
const KINDS: SuggestionKind[] = ["goal", "field", "objection", "limit", "tone", "never", "discovery_question", "opener", "play_content", "play_card", "catalog_item"];

/** Back to the draft page, or to the call the suggestion was reviewed on ("source:<id>"). */
function back(slug: string, to: string, q: Record<string, string>, anchor = ""): never {
  revalidatePath(`/app/${slug}/setup`, "layout");
  const s = new URLSearchParams(q).toString();
  const m = to.match(/^source:(.+)$/);
  const path = m && isUuid(m[1]) ? `/app/${slug}/setup/sources/${m[1]}` : `/app/${slug}/setup/playbook/draft`;
  redirect(`${path}${s ? `?${s}` : ""}${anchor}`);
}

/** Accept, remove (reject) or undo one suggestion. */
export async function decideSuggestionAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const to = str(form, "back");
  const status = str(form, "status");
  if (status !== "accepted" && status !== "rejected" && status !== "suggested") back(a.account.slug, to, { error: "missing" });
  const row = await decideSuggestion(appDb, actorOf(a), a.account.id, str(form, "id"), status);
  if (!row) back(a.account.slug, to, { error: "missing" });
  back(a.account.slug, to, { done: status }, `#sg-${suggestionSection(row.kind)}`);
}

/** Saves the edited text of one suggestion (it counts as accepted). */
export async function editSuggestionAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const to = str(form, "back");
  const id = str(form, "id");
  const kind = str(form, "kind") as SuggestionKind;
  if (!KINDS.includes(kind)) back(a.account.slug, to, { error: "missing" });
  const values: Record<string, string> = {};
  for (const f of EDITABLE[kind]) values[f.name] = str(form, f.name);
  if (kind === "field" || kind === "discovery_question") values.stage = str(form, "stage");
  if (kind === "play_card") values.do = String(form.get("do") ?? "");
  if (kind === "opener") values.topics = String(form.get("topics") ?? "");
  if (kind === "limit") {
    values.maxDiscountPercent = str(form, "maxDiscountPercent");
    values.qty = str(form, "qty");
    values.when = str(form, "when");
  }
  const res = await editSuggestion(appDb, actorOf(a), a.account.id, id, values);
  if (!res.ok) back(a.account.slug, to, { edit: id, error: res.error }, `#sg-${suggestionSection(kind)}`);
  back(a.account.slug, to, { done: "edited" }, `#sg-${suggestionSection(kind)}`);
}

/** "Accept all N" in one section. Limits always need one approval each. */
export async function acceptAllSuggestionsAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const kinds = str(form, "kinds").split(",").filter((k): k is SuggestionKind => KINDS.includes(k as SuggestionKind));
  const n = await acceptAllSuggestions(appDb, actorOf(a), a.account.id, kinds);
  back(a.account.slug, "draft", { done: "accepted_all", n: String(n) }, kinds[0] ? `#sg-${suggestionSection(kinds[0])}` : "");
}

/** "Save as agent draft vN": merges the accepted suggestions into the agent's draft playbook. */
export async function saveSuggestionsAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const { version, merged } = await saveSuggestionsToDraft(appDb, actorOf(a), a.account.id);
  back(a.account.slug, "draft", merged ? { done: "saved", n: String(merged), v: String(version) } : { error: "none_accepted" });
}
