"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { isPlayKey, type PlaybookErrors, type PlayRowInput } from "@/lib/agent/playbook";
import { savePlayForm } from "@/lib/agent/playbook-save";
import { ensureDraftVersion } from "@/lib/agent/service";
import { adoptPlayCardSuggestion } from "@/lib/pipeline/service";

export type PlayFormState = { status: "idle" } | { status: "error"; errors: PlaybookErrors; values: PlayRowInput };

/**
 * Saves one play's facts and own card into the draft version ("Save to
 * draft"), or restores the default card ("Restore default", facts kept).
 * Every rule is checked on the server (savePlayForm).
 */
export async function savePlayAction(_prev: PlayFormState, form: FormData): Promise<PlayFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const key = String(form.get("play") ?? "");
  const restore = form.get("intent") === "restore";
  const entries = [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""] as [string, string]);
  const r = await savePlayForm(appDb, a.account.id, key, entries, { restore });
  if (!r.ok) return { status: "error", errors: r.errors, values: r.values };
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved", details: { play: key, ...(restore ? { restored: true } : {}) } });
  // "Edit first" from the playbook draft: the saved own card is the suggestion, accepted with changes.
  const from = String(form.get("fromSuggestion") ?? "");
  if (from && !restore && isPlayKey(key)) {
    const own = (await ensureDraftVersion(appDb, a.account.id)).playbook.plays?.[key]?.own;
    if (own) await adoptPlayCardSuggestion(appDb, actorOf(a), a.account.id, from, key, own);
  }
  const here = `/app/${a.account.slug}/setup/playbook/plays/${key}`;
  revalidatePath(`/app/${a.account.slug}/setup/playbook`, "layout");
  redirect(`${here}?saved=${restore ? "restored" : "1"}`);
}
