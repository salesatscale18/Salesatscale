"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { parseFitRule } from "@/lib/catalog/fit";
import { parseCatalogItem, parseTaxRate, type CatalogItemErrors } from "@/lib/catalog/rules";
import {
  addDraftRule, catalogState, discardDraft, draftItemIdFor, publishDraft, removeDraftItem, removeDraftRule, saveDraftItem, saveDraftSettings,
} from "@/lib/catalog/service";

const path = (slug: string) => `/app/${slug}/setup/catalog`;

async function access(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  return a;
}

/** Acting-as edits are audited; the seller's own draft edits are not (publishing always is). */
async function auditActing(a: Awaited<ReturnType<typeof access>>, action: string, details?: Record<string, unknown>) {
  if (a.actingAs) await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action, details });
}

export type ItemFormState = { status: "idle" } | { status: "saved"; itemId: string } | { status: "error"; errors: CatalogItemErrors; formError?: string };

export async function saveItemAction(_prev: ItemFormState, form: FormData): Promise<ItemFormState> {
  const a = await access(form);
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  raw.active = form.get("active") === "on" ? "on" : "off";
  const parsed = parseCatalogItem(raw, a.account.currency);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const shownId = String(form.get("itemId") ?? "");
  const draftId = shownId ? await draftItemIdFor(appDb, a.account.id, shownId) : undefined;
  if (shownId && !draftId) return { status: "error", errors: {}, formError: "not_found" };
  const r = await saveDraftItem(appDb, a.account.id, parsed.value, draftId ?? undefined);
  if (!r.ok) return { status: "error", errors: r.reason === "sku_taken" ? { sku: "taken" } : {}, formError: r.reason };
  await auditActing(a, "catalog.item_saved", { sku: r.item.sku });
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?item=${r.item.id}&saved=1`);
}

export async function removeItemAction(form: FormData) {
  const a = await access(form);
  await removeDraftItem(appDb, a.account.id, String(form.get("itemId") ?? ""));
  await auditActing(a, "catalog.item_removed");
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

const skus = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

export type RuleFormState = { status: "idle" } | { status: "error" };

export async function addRuleAction(_prev: RuleFormState, form: FormData): Promise<RuleFormState> {
  const a = await access(form);
  const kind = String(form.get("kind") ?? "");
  const sku = String(form.get("sku") ?? "").trim().toUpperCase();
  const raw =
    kind === "requires" ? { kind, sku, oneOf: skus(form.get("oneOf")), perSite: form.get("perSite") === "on" }
    : kind === "max_per" ? { kind, sku, max: Number(form.get("max")), perOneOf: skus(form.get("perOneOf")) }
    : { kind: "advice", text: String(form.get("text") ?? ""), ...(sku ? { sku } : {}) };
  const rule = parseFitRule(raw);
  if (!rule) return { status: "error" };
  // Every SKU a rule names must exist in the catalog being edited.
  const known = new Set((await catalogState(appDb, a.account.id)).items.map((i) => i.sku));
  const named = rule.kind === "requires" ? [rule.sku, ...rule.oneOf] : rule.kind === "max_per" ? [rule.sku, ...rule.perOneOf] : rule.sku ? [rule.sku] : [];
  if (!named.every((s) => known.has(s))) return { status: "error" };
  await addDraftRule(appDb, a.account.id, rule);
  await auditActing(a, "catalog.rule_added");
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

export async function removeRuleAction(form: FormData) {
  const a = await access(form);
  await removeDraftRule(appDb, a.account.id, String(form.get("ruleId") ?? ""));
  await auditActing(a, "catalog.rule_removed");
  revalidatePath(path(a.account.slug));
}

export async function saveTaxAction(form: FormData) {
  const a = await access(form);
  const rate = parseTaxRate(String(form.get("taxRate") ?? ""));
  if (rate === null) redirect(`${path(a.account.slug)}?tax=invalid`);
  await saveDraftSettings(appDb, a.account.id, { pricesIncludeTax: form.get("pricesIncludeTax") === "on", taxRateBp: rate });
  await auditActing(a, "catalog.tax_saved");
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
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
