"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { parseFitRule } from "@/lib/catalog/fit";
import { parseItemEdit, type ItemEditErrors } from "@/lib/catalog/rules";
import {
  addDraftRule, catalogState, discardDraft, draftItemIdFor, itemTexts, publishDraft, removeDraftItem, removeDraftRule, replaceDraftRule, saveDraftItem,
} from "@/lib/catalog/service";
import { acceptCatalogSuggestionFromItem } from "@/lib/pipeline/service";
import { parseAutoAddRule } from "@/lib/pricing/auto-add";
import { isUuid } from "@/lib/security/ids";

const path = (slug: string) => `/app/${slug}/setup/catalog`;

async function access(form: FormData) {
  return requireAccount(String(form.get("slug") ?? ""));
}

/** Acting-as edits are audited; the seller's own draft edits are not (publishing always is). */
async function auditActing(a: Awaited<ReturnType<typeof access>>, action: string, details?: Record<string, unknown>) {
  if (a.actingAs) await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action, details });
}

export type ItemFormState = { status: "idle" } | { status: "error"; errors: ItemEditErrors; formError?: "sku_taken" | "not_found" };

/** Saves the item editor (canvas: ProductEditor) into the catalog draft. Items hold no price. */
export async function saveItemAction(_prev: ItemFormState, form: FormData): Promise<ItemFormState> {
  const a = await access(form);
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  raw.active = form.get("active") === "on" ? "on" : "off";
  const shownId = String(form.get("itemId") ?? "");
  if (shownId && !isUuid(shownId)) return { status: "error", errors: {}, formError: "not_found" };
  // The shown item as stored: a value line saved before the 140-character rule stays valid unchanged.
  const previous = shownId ? await itemTexts(appDb, a.account.id, shownId) : null;
  const parsed = parseItemEdit(raw, a.account.languages, previous);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const draftId = shownId ? await draftItemIdFor(appDb, a.account.id, shownId) : undefined;
  if (shownId && !draftId) return { status: "error", errors: {}, formError: "not_found" };
  const r = await saveDraftItem(appDb, a.account.id, parsed.value, draftId ?? undefined);
  if (!r.ok) return { status: "error", errors: r.reason === "sku_taken" ? { sku: "taken" } : {}, formError: r.reason };
  await auditActing(a, "catalog.item_saved", { sku: r.item.sku });
  // "Use the suggestion" on the item counts as accepting it (editing accepts, as in the playbook draft).
  const suggestionId = String(form.get("suggestionId") ?? "");
  if (suggestionId && isUuid(suggestionId)) await acceptCatalogSuggestionFromItem(appDb, actorOf(a), a.account.id, suggestionId, r.item.sku);
  revalidatePath(path(a.account.slug));
  // Saved: the panel closes and the list says so, with the row marked (?saved=<item id>).
  redirect(`${path(a.account.slug)}?saved=${r.item.id}`);
}

export async function removeItemAction(form: FormData) {
  const a = await access(form);
  const itemId = String(form.get("itemId") ?? "");
  if (isUuid(itemId) && (await removeDraftItem(appDb, a.account.id, itemId))) await auditActing(a, "catalog.item_removed");
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

const skus = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

export type RuleFormState = { status: "idle" } | { status: "error" };

/** Adds a fit rule or an "Add automatically with" rule to the draft. */
export async function addRuleAction(_prev: RuleFormState, form: FormData): Promise<RuleFormState> {
  const a = await access(form);
  const kind = String(form.get("kind") ?? "");
  const sku = String(form.get("sku") ?? "").trim().toUpperCase();
  const rule =
    kind === "auto_add"
      ? parseAutoAddRule({
          kind,
          sku,
          whenAnyOf: form.getAll("whenAnyOf").map((v) => String(v).trim().toUpperCase()).filter(Boolean),
          qty: String(form.get("qty") ?? ""),
          removable: form.get("removable") === "on",
        })
      : parseFitRule(
          kind === "requires" ? { kind, sku, oneOf: skus(form.get("oneOf")), perSite: form.get("perSite") === "on" }
          : kind === "max_per" ? { kind, sku, max: Number(form.get("max")), perOneOf: skus(form.get("perOneOf")) }
          : { kind: "advice", text: String(form.get("text") ?? ""), ...(sku ? { sku } : {}) },
        );
  if (!rule) return { status: "error" };
  // Every SKU a rule names must exist in the catalog being edited.
  const known = new Set((await catalogState(appDb, a.account.id)).items.map((i) => i.sku));
  const named =
    rule.kind === "requires" ? [rule.sku, ...rule.oneOf]
    : rule.kind === "max_per" ? [rule.sku, ...rule.perOneOf]
    : rule.kind === "auto_add" ? [rule.sku, ...rule.whenAnyOf]
    : rule.sku ? [rule.sku] : [];
  if (!named.every((s) => known.has(s))) return { status: "error" };
  // With a rule id (the rules card's Edit) the rule is changed in place.
  const ruleId = String(form.get("ruleId") ?? "");
  if (ruleId) {
    if (!isUuid(ruleId) || !(await replaceDraftRule(appDb, a.account.id, ruleId, rule))) return { status: "error" };
    await auditActing(a, "catalog.rule_changed", { kind: rule.kind });
  } else {
    await addDraftRule(appDb, a.account.id, rule);
    await auditActing(a, "catalog.rule_added", { kind: rule.kind });
  }
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

export async function removeRuleAction(form: FormData) {
  const a = await access(form);
  const ruleId = String(form.get("ruleId") ?? "");
  if (isUuid(ruleId) && (await removeDraftRule(appDb, a.account.id, ruleId))) await auditActing(a, "catalog.rule_removed");
  revalidatePath(path(a.account.slug));
}

export async function publishAction(form: FormData) {
  const a = await access(form);
  const r = await publishDraft(appDb, actorOf(a), a.account.id);
  revalidatePath(path(a.account.slug));
  redirect(r.ok ? `${path(a.account.slug)}?published=${r.version}` : `${path(a.account.slug)}?publish=${r.reason}`);
}

export async function discardAction(form: FormData) {
  const a = await access(form);
  await discardDraft(appDb, a.account.id);
  await auditActing(a, "catalog.draft_discarded");
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}
