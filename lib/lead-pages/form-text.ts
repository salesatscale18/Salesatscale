/**
 * The buyer-facing texts of the lead form, shared by the hosted form (/p/<key>)
 * and the snippet's config (/api/lp/<key>/config), so both show the same
 * approved wording. Pure: no database.
 */
import type { LeadPageTopic } from "@/db/schema";
import { textIn } from "@/lib/agent/core/opener";
import type { Locale, translator } from "@/lib/i18n";

/**
 * The "About: {topic}" line above "Leave your details" (UX polish, 25 Nov).
 * NEW buyer wording, pending the owner's approval: set to false to remove it
 * everywhere (hosted form and snippet) without touching anything else.
 */
export const SHOW_ABOUT_TOPIC = true;

type Tr = ReturnType<typeof translator>;

export type LeadFormText = {
  title: string; name: string; phone: string; company: string; email: string; sites: string; send: string; sending: string;
  errName: string; errPhone: string; errGeneric: string; errBusy: string; privacy: string; closed: string; continue: string;
};

/** The form's labels, buttons and errors in the form language. */
export function leadFormText(tr: Tr): LeadFormText {
  return {
    title: tr("buyer.lp.form.title"), name: tr("buyer.lp.form.name"), phone: tr("buyer.lp.form.phone"), company: tr("buyer.lp.form.company"),
    email: tr("buyer.lp.form.email"), sites: tr("buyer.lp.form.sites"), send: tr("buyer.lp.form.send"), sending: tr("buyer.lp.form.sending"),
    errName: tr("buyer.lp.form.err_name"), errPhone: tr("buyer.lp.form.err_phone"), errGeneric: tr("buyer.lp.form.err_generic"),
    errBusy: tr("buyer.lp.form.err_busy"), privacy: tr("buyer.lp.form.privacy"), closed: tr("buyer.lp.form.closed"),
    // The snippet's fallback link when it cannot move the top page (a sandboxed builder frame): the hand-over leads to the chat.
    continue: tr("buyer.lp.handover.continue_chat"),
  };
}

/** "About: {topic}" for a page with an opening topic in the form language, else null (and always null while the flag is off). */
export function aboutLine(tr: Tr, topic: LeadPageTopic | null | undefined, lang: Locale): string | null {
  if (!SHOW_ABOUT_TOPIC) return null;
  const text = textIn(topic, lang);
  return text ? tr("buyer.lp.form.about", { topic: text }) : null;
}
