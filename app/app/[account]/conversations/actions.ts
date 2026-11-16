"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { publicBaseUrl, sendTemplateMessage, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { defaultTransport } from "@/lib/channels/twilio";

// Server actions are public endpoints: access is re-checked with requireAccount(), ids are checked to be UUIDs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inbox composer outside the 24-hour window: a person sends one approved template. */
export async function sendTemplateAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const conversationId = String(form.get("conversationId") ?? "");
  const templateId = String(form.get("templateId") ?? "");
  const base = `/app/${access.account.slug}/conversations`;
  if (!UUID.test(conversationId)) redirect(base);
  const r = UUID.test(templateId)
    ? await sendTemplateMessage(appDb, defaultTransport(), { ...actorOf(access), userId: access.user.id }, access.account.id, conversationId, templateId, {
      statusCallback: statusCallbackUrl(publicBaseUrl()),
    })
    : { ok: false as const, reason: "template_not_found" as const };
  revalidatePath(base);
  redirect(`${base}?c=${conversationId}&${r.ok ? "notice=template_sent" : `template_error=${r.reason}`}#thread`);
}
