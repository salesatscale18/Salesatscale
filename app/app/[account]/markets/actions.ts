"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { isUuid } from "@/lib/security/ids";
import { createMarket, getMarket, setMarketPriceList, setMarketStatus, updateMarket } from "@/lib/markets/service";
import { overrideSetting, resetSetting } from "@/lib/markets/settings";
import type { MarketStatus } from "@/db/schema";
import { isSettingKey, parseOverride, parseWhere, reader } from "./form";
import { autoNameModel, refreshAgentNameAuto } from "@/lib/agent/names-auto";

// Server actions are public endpoints: each one re-checks access with
// requireAccount() and passes only that account's id to the market services,
// which look every market up inside the account.

const path = (slug: string) => `/app/${slug}/markets`;
const at = (slug: string, marketId: string, extra = "") => `${path(slug)}?m=${marketId}${extra ? `&${extra}` : ""}`;
const err = (msg: string) => `error=${encodeURIComponent(msg)}`;
const firstError = (errors: Record<string, string | undefined>) => Object.values(errors).find(Boolean) ?? "Check the fields and try again.";

/** Loads the caller's access and the market named in the form (this account only). */
async function marketForm(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const marketId = String(form.get("marketId") ?? "");
  const market = isUuid(marketId) ? await getMarket(appDb, access.account.id, marketId) : null;
  if (!market) redirect(`${path(access.account.slug)}?${err("This market was not found.")}`);
  return { access, market, slug: access.account.slug };
}

/**
 * A market's languages decide which agent-name rows exist (UX, 18 Nov): make
 * the missing automatic versions right after a market change, so a new
 * language row is not empty until the next playbook save. Nothing is called
 * when no language is missing; a failure never blocks the market save.
 */
async function refreshAgentNames(access: Awaited<ReturnType<typeof requireAccount>>) {
  try {
    await refreshAgentNameAuto(appDb, access.account.id, autoNameModel(), { actor: actorOf(access) });
  } catch (e) {
    console.error("[markets] automatic agent names failed", e instanceof Error ? e.message : e);
  }
}

function done(slug: string, marketId: string, extra: string): never {
  revalidatePath(path(slug));
  redirect(at(slug, marketId, extra));
}

export async function addMarketAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const slug = access.account.slug;
  const where = parseWhere(reader(form), { fillFromCountries: true });
  const r = await createMarket(appDb, actorOf(access), access.account.id, { ...where, intakeKeyIds: [] });
  if (!r.ok) redirect(`${path(slug)}?add=1&${err(firstError(r.errors))}`);
  await refreshAgentNames(access);
  done(slug, r.market.id, "saved=added");
}

/** Name, countries and how leads reach the market (phone prefixes, form values, intake keys). */
export async function updateWhereAction(form: FormData) {
  const { access, market, slug } = await marketForm(form);
  const where = parseWhere(reader(form), { fillFromCountries: false });
  const r = await updateMarket(appDb, actorOf(access), access.account.id, market.id, where);
  if (!r.ok) redirect(at(slug, market.id, `edit=where&${err(firstError(r.errors))}`));
  done(slug, market.id, "saved=where");
}

export async function overrideSettingAction(form: FormData) {
  const { access, market, slug } = await marketForm(form);
  const key = String(form.get("key") ?? "");
  if (!isSettingKey(key)) redirect(at(slug, market.id));
  const parsed = parseOverride(key, reader(form));
  if (!parsed.ok) redirect(at(slug, market.id, `override=${key}&${err(parsed.error)}`));
  const r = await updateMarket(appDb, actorOf(access), access.account.id, market.id, { overrides: overrideSetting(market.overrides, key, parsed.value) });
  if (!r.ok) redirect(at(slug, market.id, `override=${key}&${err(firstError(r.errors))}`));
  if (key === "languages") await refreshAgentNames(access);
  done(slug, market.id, `saved=${key}`);
}

export async function resetSettingAction(form: FormData) {
  const { access, market, slug } = await marketForm(form);
  const key = String(form.get("key") ?? "");
  if (!isSettingKey(key)) redirect(at(slug, market.id));
  const r = await updateMarket(appDb, actorOf(access), access.account.id, market.id, { overrides: resetSetting(market.overrides, key) });
  if (!r.ok) redirect(at(slug, market.id, err(firstError(r.errors))));
  if (key === "languages") await refreshAgentNames(access);
  done(slug, market.id, `reset=${key}`);
}

export async function setPriceListAction(form: FormData) {
  const { access, market, slug } = await marketForm(form);
  const raw = String(form.get("lineageId") ?? "");
  if (raw && !isUuid(raw)) redirect(at(slug, market.id, err("Choose a price list from the list.")));
  const r = await setMarketPriceList(appDb, actorOf(access), access.account.id, market.id, raw || null);
  if (!r.ok) redirect(at(slug, market.id, err(firstError(r.errors))));
  done(slug, market.id, "saved=price_list");
}

const STATUSES: readonly MarketStatus[] = ["live", "paused"];

/** Live needs every blocking go-live check to pass; the service checks them again here. */
export async function setMarketStatusAction(form: FormData) {
  const { access, market, slug } = await marketForm(form);
  const status = String(form.get("status") ?? "") as MarketStatus;
  if (!STATUSES.includes(status)) redirect(at(slug, market.id));
  const r = await setMarketStatus(appDb, actorOf(access), access.account.id, market.id, status);
  if (!r.ok) redirect(at(slug, market.id, `status_error=${r.reason}`));
  revalidatePath(`/app/${slug}`, "layout");
  done(slug, market.id, `saved=status_${status}`);
}
