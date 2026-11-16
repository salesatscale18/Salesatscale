"use server";

import { redirect } from "next/navigation";
import { startWhatsAppConversation, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { defaultTransport } from "@/lib/channels/twilio";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { CONSENT_WORDING_DEFAULT, parseLead, type LeadFieldErrors } from "@/lib/leads/rules";
import { importLeadsCsv, optOutLead, setLeadMarket, upsertLead, type ImportResult } from "@/lib/leads/service";
import { getMarket } from "@/lib/markets/service";
import type { Locale } from "@/lib/i18n";
import { currentPlaybook, getConversation, verifyField } from "@/lib/agent/service";
import { addHumanReply, handBack, takeOver } from "@/lib/agent/conversation";

// Server actions are public endpoints: every one re-checks access with requireAccount().
// Ids from forms are checked to be UUIDs before any query (a bad id is refused, not a 500).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddLeadState =
  | { status: "idle" }
  | { status: "error"; errors: LeadFieldErrors; formError?: "consent_required" | "phone_conflict" | "opted_out" | "market"; values: Record<string, string> };

export async function addLeadAction(_prev: AddLeadState, form: FormData): Promise<AddLeadState> {
  const slug = String(form.get("slug") ?? "");
  const access = await requireAccount(slug);
  const { account } = access;
  const values: Record<string, string> = {};
  for (const k of ["fullName", "company", "email", "phone", "language", "sourceLabel", "consent", "consentSource", "after", "marketId"]) {
    values[k] = String(form.get(k) ?? "");
  }
  const parsed = parseLead(values, account.market, { language: (account.languages[0] ?? "en") as Locale, now: new Date() });
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values };
  if (!parsed.value.consent) return { status: "error", errors: {}, formError: "consent_required", values };
  // Optional market chosen by the seller; empty means "choose from the phone number".
  if (values.marketId && (!UUID.test(values.marketId) || !(await getMarket(appDb, account.id, values.marketId)))) {
    return { status: "error", errors: {}, formError: "market", values };
  }
  if (values.marketId) parsed.value.marketId = values.marketId;

  const actor = actorOf(access);
  const result = await upsertLead(appDb, account.id, actor, parsed.value, "manual", {
    ownerUserId: values.after === "me" ? access.user.id : null,
  });
  // A manual add is never refused for a paused account (only intake is).
  if (!result.ok) return { status: "error", errors: {}, formError: result.reason === "account_paused" ? undefined : result.reason, values };
  if (actor.actingAs) {
    await writeAudit(appDb, actor, { accountId: account.id, action: result.created ? "lead.created" : "lead.updated", targetType: "lead", targetId: result.lead.id });
  }
  revalidatePath(`/app/${account.slug}/leads`);
  redirect(`/app/${account.slug}/leads/${result.lead.id}${result.created ? "" : "?existing=1"}`);
}

/** Lead card: moves the lead to another market of this account (audited in setLeadMarket). */
export async function setLeadMarketAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const marketId = String(form.get("marketId") ?? "");
  if (!UUID.test(leadId)) redirect(`/app/${access.account.slug}/leads`);
  const back = `/app/${access.account.slug}/leads/${leadId}`;
  const ok = UUID.test(marketId) ? await setLeadMarket(appDb, actorOf(access), access.account.id, leadId, marketId) : null;
  revalidatePath(back);
  redirect(`${back}?${ok ? "market=1" : "market_error=1"}`);
}

export async function optOutLeadAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  if (!UUID.test(leadId)) return;
  await optOutLead(appDb, actorOf(access), access.account.id, leadId);
  revalidatePath(`/app/${access.account.slug}/leads/${leadId}`);
}

export type ImportState =
  | { status: "idle" }
  | { status: "bad_file" }
  | { status: "missing_file_consent" }
  | { status: "done"; result: ImportResult; fileName: string; fileConsent: string | null; at: string };

const MAX_BYTES = 1024 * 1024;

export async function importLeadsAction(_prev: ImportState, form: FormData): Promise<ImportState> {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) return { status: "bad_file" };
  const wholeFile = form.get("fileConsent") === "yes";
  const statement = String(form.get("fileConsentSource") ?? "").trim().slice(0, 300);
  if (wholeFile && !statement) return { status: "missing_file_consent" };
  const fileConsent = wholeFile ? { source: statement, wording: CONSENT_WORDING_DEFAULT } : null;
  const text = await file.text();
  const result = await importLeadsCsv(appDb, access.account, actorOf(access), text, { fileConsent });
  revalidatePath(`/app/${access.account.slug}/leads`);
  return { status: "done", result, fileName: file.name.slice(0, 120), fileConsent: fileConsent?.source ?? null, at: new Date().toISOString() };
}

/** A person sets a deal-state field; it becomes Verified and the agent will not change it. */
export async function verifyFieldAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const key = String(form.get("key") ?? "");
  const value = String(form.get("value") ?? "").trim().slice(0, 300);
  const playbook = await currentPlaybook(appDb, access.account.id);
  if (!UUID.test(leadId)) redirect(`/app/${access.account.slug}/leads`);
  const back = `/app/${access.account.slug}/leads/${leadId}`;
  if (!value || !playbook?.fields.some((f) => f.key === key)) redirect(back);
  const ok = await verifyField(appDb, actorOf(access), access.account.id, leadId, key, value);
  revalidatePath(back);
  redirect(ok ? `${back}?verified=1` : back);
}

// ---------------------------------------------------------------------------
// Conversation: take over, hand back, reply as a person (lead card and test lab)
// ---------------------------------------------------------------------------

/** Where to go after a conversation action: the lead card, or the test-lab chat. */
function conversationBack(slug: string, from: string, conv: { id: string; leadId: string } | null, notice?: string) {
  if (from === "lab") {
    const base = `/app/${slug}/setup/test-lab`;
    return conv ? `${base}?c=${conv.id}${notice ? `&notice=${notice}` : ""}#end` : base;
  }
  return conv ? `/app/${slug}/leads/${conv.leadId}${notice ? `?notice=${notice}` : ""}#conversation` : `/app/${slug}/leads`;
}

/** Access first, then the conversation, looked up inside the caller's account only. */
async function conversationForm(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const conversationId = String(form.get("conversationId") ?? "");
  const conv = UUID.test(conversationId) ? await getConversation(appDb, access.account.id, conversationId) : null;
  return { access, conv, from: String(form.get("from") ?? "") };
}

export async function takeOverAction(form: FormData) {
  const { access, conv, from } = await conversationForm(form);
  const r = conv ? await takeOver(appDb, actorOf(access), access.account.id, conv.id) : null;
  if (conv) revalidatePath(`/app/${access.account.slug}/leads/${conv.leadId}`);
  redirect(conversationBack(access.account.slug, from, conv, r && !r.ok ? r.reason : undefined));
}

export async function handBackAction(form: FormData) {
  const { access, conv, from } = await conversationForm(form);
  const r = conv ? await handBack(appDb, actorOf(access), access.account.id, conv.id) : null;
  if (conv) revalidatePath(`/app/${access.account.slug}/leads/${conv.leadId}`);
  redirect(conversationBack(access.account.slug, from, conv, r && !r.ok ? r.reason : undefined));
}

/** Start on WhatsApp: sends the approved opening template after re-checking every gate on the server. */
export async function startWhatsAppAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const base = `/app/${access.account.slug}/leads`;
  if (!UUID.test(leadId)) redirect(base);
  const r = await startWhatsAppConversation(appDb, defaultTransport(), actorOf(access), access.account.id, leadId, {
    statusCallback: statusCallbackUrl(publicBaseUrl()),
  });
  revalidatePath(`${base}/${leadId}`);
  redirect(r.ok ? `${base}/${leadId}?notice=started#conversation` : `${base}/${leadId}?wa_error=${r.reason}`);
}

export async function humanReplyAction(form: FormData) {
  const { access, conv, from } = await conversationForm(form);
  const text = String(form.get("text") ?? "");
  const r = conv ? await addHumanReply(appDb, { ...actorOf(access), userId: access.user.id }, access.account.id, conv.id, text) : null;
  const notice = !r ? undefined
    : !r.ok ? r.reason
    : !r.delivery ? undefined
    : r.delivery.delivered ? "sent"
    : r.delivery.reason === "window_closed" ? "window_closed" : "saved_not_sent";
  if (conv) revalidatePath(`/app/${access.account.slug}/leads/${conv.leadId}`);
  redirect(conversationBack(access.account.slug, from, conv, notice));
}
