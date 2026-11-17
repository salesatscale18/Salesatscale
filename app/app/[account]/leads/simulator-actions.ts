"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { createSimulatedBuyer, ensureChatLink, resetChatLink, startSimulatorConversation, type SimBuyerErrors } from "@/lib/simulator/service";

// Server actions are public endpoints: every one re-checks access with requireAccount()
// and passes only that account's id to the service. Lead ids are checked to be UUIDs first.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddSimBuyerState = { status: "idle" } | { status: "error"; errors: SimBuyerErrors; values: Record<string, string> };

/** Leads › Add simulated buyer. Opens the new lead's card. */
export async function addSimulatedBuyerAction(_prev: AddSimBuyerState, form: FormData): Promise<AddSimBuyerState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const values: Record<string, string> = {};
  for (const k of ["fullName", "company", "language", "country"]) values[k] = String(form.get(k) ?? "");
  const r = await createSimulatedBuyer(appDb, actorOf(access), access.account, {
    fullName: values.fullName, company: values.company, language: values.language, country: values.country,
  });
  if (!r.ok) return { status: "error", errors: r.errors, values };
  revalidatePath(`/app/${access.account.slug}/leads`);
  redirect(`/app/${access.account.slug}/leads/${r.lead.id}?sim=added#simulator`);
}

async function leadForm(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  if (!UUID.test(leadId)) redirect(`/app/${access.account.slug}/leads`);
  return { access, leadId, back: `/app/${access.account.slug}/leads/${leadId}` };
}

/** Lead card: a buyer chat link for this lead (any lead; simulated chats run on their own channel). */
export async function createChatLinkAction(form: FormData) {
  const { access, leadId, back } = await leadForm(form);
  const r = await ensureChatLink(appDb, actorOf(access), access.account.id, leadId);
  revalidatePath(back);
  redirect(`${back}?sim=${r ? "link" : "error"}#simulator`);
}

/** Lead card: Reset link. The old link stops working at once. */
export async function resetChatLinkAction(form: FormData) {
  const { access, leadId, back } = await leadForm(form);
  const r = await resetChatLink(appDb, actorOf(access), access.account.id, leadId);
  revalidatePath(back);
  redirect(`${back}?sim=${r ? "reset" : "error"}#simulator`);
}

/** Lead card: Start conversation. The agent sends its opening message on the simulator channel (no model call). */
export async function startSimulatorAction(form: FormData) {
  const { access, leadId, back } = await leadForm(form);
  const r = await startSimulatorConversation(appDb, actorOf(access), access.account.id, leadId);
  revalidatePath(back);
  revalidatePath(`/app/${access.account.slug}/conversations`);
  redirect(r.ok ? `${back}?notice=started_sim#conversation` : `${back}?sim_error=${r.reason}#simulator`);
}
