"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { catalogState, publishedCatalog } from "@/lib/catalog/service";
import { ensureHomeMarket, setMarketPriceList } from "@/lib/markets/service";
import {
  copyAndAdjust, createPriceList, deletePriceList, discardDraft, entriesOf, ensureDraft, lineageExists, listPriceLists, priceListVersion, publishPriceList, removeEntry,
  saveDraftMeta, setEntry,
} from "@/lib/pricing/price-lists";
import { isUuid } from "@/lib/security/ids";
import { parseCopyForm, parseEntryForm, parseMetaForm, type CopyFormErrors, type EntryFormErrors, type MetaFormErrors } from "./rules";

const base = (slug: string) => `/app/${slug}/setup/price-lists`;
const fields = (form: FormData) => Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));

async function access(form: FormData) {
  return requireAccount(String(form.get("slug") ?? ""));
}

/** The lineage id from the form, only when it is a price list of this account. */
async function ownLineage(form: FormData, accountId: string): Promise<string | null> {
  const id = String(form.get("lineageId") ?? "");
  return isUuid(id) && (await lineageExists(appDb, accountId, id)) ? id : null;
}

export type MetaFormState = { status: "idle" } | { status: "saved" } | { status: "error"; errors: MetaFormErrors; formError?: string };

/**
 * New price list (draft v1). The account's first price list is also given to
 * the home market, so a new account can quote as soon as it is published.
 */
export async function createPriceListAction(_prev: MetaFormState, form: FormData): Promise<MetaFormState> {
  const a = await access(form);
  const parsed = parseMetaForm(fields(form), true);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const first = (await listPriceLists(appDb, a.account.id)).length === 0;
  const actor = actorOf(a);
  const r = await createPriceList(appDb, actor, a.account.id, parsed.value);
  if (!r.ok) return { status: "error", errors: {}, formError: r.error };
  if (first) {
    const home = await ensureHomeMarket(appDb, a.account.id, actor);
    if (home && !home.priceListLineageId) await setMarketPriceList(appDb, actor, a.account.id, home.id, r.list.lineageId);
  }
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}/${r.list.lineageId}?created=1`);
}

/** Name, VAT handling, tax rate and valid-from date of the draft. */
export async function saveMetaAction(_prev: MetaFormState, form: FormData): Promise<MetaFormState> {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) return { status: "error", errors: {}, formError: "This price list was not found." };
  const parsed = parseMetaForm(fields(form), false);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const { name, pricesIncludeTax, taxRateBp, validFrom } = parsed.value;
  const r = await saveDraftMeta(appDb, actorOf(a), a.account.id, lineageId, { name, pricesIncludeTax, taxRateBp, validFrom });
  if (!r.ok) return { status: "error", errors: {}, formError: r.error };
  revalidatePath(`${base(a.account.slug)}/${lineageId}`);
  return { status: "saved" };
}

export type EntryFormState = { status: "idle" } | { status: "error"; errors: EntryFormErrors; formError?: string };

/** One row of the editor: "Sold here: no" removes the entry; otherwise its prices are saved to the draft. */
export async function saveEntryAction(_prev: EntryFormState, form: FormData): Promise<EntryFormState> {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) return { status: "error", errors: {}, formError: "This price list was not found." };
  const actor = actorOf(a);
  const draft = await ensureDraft(appDb, actor, a.account.id, lineageId);
  if (!draft) return { status: "error", errors: {}, formError: "This price list was not found." };
  const parsed = parseEntryForm(fields(form), draft.currency);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const sku = parsed.sold ? parsed.entry.sku.trim().toUpperCase() : parsed.sku;
  const [entries, shown, live] = await Promise.all([entriesOf(appDb, a.account.id, draft.id), catalogState(appDb, a.account.id), publishedCatalog(appDb, a.account.id)]);
  const has = entries.some((e) => e.sku === sku);
  // Prices are only for items in the catalog (live or draft); an entry left from a removed item can still be removed.
  const inCatalog = [...shown.items, ...(live?.items ?? [])].some((i) => i.sku === sku);
  if (!inCatalog && !(has && !parsed.sold)) return { status: "error", errors: {}, formError: "This item is not in the catalog." };
  if (!parsed.sold) {
    if (has) {
      const r = await removeEntry(appDb, actor, a.account.id, lineageId, parsed.sku);
      if (!r.ok) return { status: "error", errors: {}, formError: r.error };
    }
  } else {
    const r = await setEntry(appDb, actor, a.account.id, lineageId, parsed.entry);
    if (!r.ok) return { status: "error", errors: {}, formError: r.error };
  }
  revalidatePath(`${base(a.account.slug)}/${lineageId}`);
  redirect(`${base(a.account.slug)}/${lineageId}?saved=1`);
}

export async function publishPriceListAction(form: FormData) {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) redirect(base(a.account.slug));
  const r = await publishPriceList(appDb, actorOf(a), a.account.id, lineageId);
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}/${lineageId}?${r.ok ? `published=${r.list.version}` : `publish=${r.reason}`}`);
}

export async function discardPriceListDraftAction(form: FormData) {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) redirect(base(a.account.slug));
  const r = await discardDraft(appDb, actorOf(a), a.account.id, lineageId);
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}/${lineageId}${r.ok ? "?discarded=1" : ""}`);
}

export type RenameFormState = { status: "idle" } | { status: "error"; error: string };

/** ⋯ › Rename on the list page: the name goes into the list's draft, like every setting. */
export async function renamePriceListAction(_prev: RenameFormState, form: FormData): Promise<RenameFormState> {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) return { status: "error", error: "This price list was not found." };
  const name = String(form.get("name") ?? "").trim();
  if (!name || name.length > 80) return { status: "error", error: "Enter a name of up to 80 characters." };
  const r = await saveDraftMeta(appDb, actorOf(a), a.account.id, lineageId, { name });
  if (!r.ok) return { status: "error", error: r.error };
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}?renamed=${lineageId}`);
}

/**
 * ⋯ › Delete on the list page (after the in-page confirm). Refused while a
 * market sells from the list, or when quotes were priced from it.
 */
export async function deletePriceListAction(form: FormData) {
  const a = await access(form);
  const lineageId = await ownLineage(form, a.account.id);
  if (!lineageId) redirect(base(a.account.slug));
  const r = await deletePriceList(appDb, actorOf(a), a.account.id, lineageId);
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}?${r.ok ? "deleted=1" : `delete=${r.reason}&list=${lineageId}`}`);
}

export type CopyFormState ={ status: "idle" } | { status: "error"; errors: CopyFormErrors; formError?: string };

/** "Copy and adjust": a new draft price list from an existing version, converted by percent or factor. */
export async function copyPriceListAction(_prev: CopyFormState, form: FormData): Promise<CopyFormState> {
  const a = await access(form);
  const parsed = parseCopyForm(fields(form));
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  if (!isUuid(parsed.sourceId) || !(await priceListVersion(appDb, a.account.id, parsed.sourceId))) {
    return { status: "error", errors: { source: "Choose the price list to copy." } };
  }
  const r = await copyAndAdjust(appDb, actorOf(a), a.account.id, parsed.sourceId, parsed.options);
  if (!r.ok) return { status: "error", errors: {}, formError: r.error };
  revalidatePath(base(a.account.slug));
  redirect(`${base(a.account.slug)}/${r.list.lineageId}?copied=${r.entries}&problems=${r.problems.length}`);
}
