/**
 * The live preview on Lead pages › Add a page / Edit: everything the buyer
 * screens need in both form languages, worked out once on the server for the
 * page render, so the preview switches on the client without any network call
 * while the seller edits. The texts come from the same code the buyer pages
 * use (form texts, consent line, hand-over lines, the agent's opener); no
 * model call anywhere.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, orderFormSettings, type LeadPage, type LeadPageTopic, type SellerAccount } from "@/db/schema";
import { openerText, textIn } from "@/lib/agent/core/opener";
import { buyerNames, tg } from "@/lib/agent/core/names";
import { currentPlaybook } from "@/lib/agent/service";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { t, translator } from "@/lib/i18n";
import { approvedTemplate } from "@/lib/channels/connections";
import { renderTemplate, templateVariables } from "@/lib/channels/rules";
import { leadPageConsentParts } from "@/lib/leads/consent-line";
import { marketOfLead } from "@/lib/markets/lead-settings";
import { marketContactSettings } from "@/lib/markets/settings";
import { chatNames } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor, safeBrand } from "@/lib/simulator/rules";
import { voiceMode } from "@/lib/voice/settings";
import { aboutLine, leadFormText, type LeadFormText } from "./form-text";
import { handoverConnectingLine } from "./handover-text";
import { bannerUrlPath, initialsOf } from "./rules";
import { privacyNotice } from "./service";

export const PREVIEW_LANGS = ["en", "he"] as const;
export type PreviewLang = (typeof PREVIEW_LANGS)[number];

/** The sample buyer's first name in a form language ("Dana" / "דנה"). */
export function sampleBuyerName(lang: PreviewLang): string {
  return t(lang === "he" ? "lead_pages.preview.sample_name_he" : "lead_pages.preview.sample_name");
}

export type PreviewTexts = {
  lang: PreviewLang;
  dir: "ltr" | "rtl";
  seller: string;
  initials: string;
  form: LeadFormText;
  /** The consent line in parts (names at odd indexes, isolated when shown). */
  consentLine: string[];
  thanks: string;
  connecting: string;
  buttons: { talkNow: string; chatWriting: string; continueChat: string };
  byLine: string;
  /** The agent's first message for each opening-topic choice of the form ("" none, "0".., "keep"). */
  openers: Record<string, string>;
  /** The form's "About" line for each topic choice (always null while SHOW_ABOUT_TOPIC is off). */
  about: Record<string, string | null>;
  /** The buyer chat's header: initials, and "{agent} · automated assistant". */
  chat: { initials: string; automated: string };
};

export type LeadPagePreviewData = {
  texts: Record<PreviewLang, PreviewTexts>;
  /** brandVars of the account's brand colour (Order form settings), as the hosted form uses it. */
  formStyle: Record<string, string>;
  /** The hand-over's root style (brand colour and the buyer bubble colour). */
  handoverStyle: Record<string, string>;
  /** Talk now + Chat in writing (true) or Continue to the chat. */
  voiceOffered: boolean;
  /** `${marketId}|${lang}` for every market choice ("" = any market) and language with a privacy notice. */
  privacy: string[];
  /** The saved banner (edit). */
  savedBanner: { src: string; width: number; height: number } | null;
  /**
   * `${marketId}|${lang}` → the account's approved opening template as the chat would send it to the sample
   * buyer, for every market choice and language that has one: the chat start sends it in place of the opener
   * whatever the topic (previewOpenerTemplate).
   */
  openerTemplates: Record<string, string>;
};

/** The topic choices of the form: "" (none), each playbook topic by index, and "keep" (a page's earlier topic). */
function topicChoices(topics: readonly LeadPageTopic[], page: Pick<LeadPage, "openingTopic"> | null): Record<string, LeadPageTopic | null> {
  const out: Record<string, LeadPageTopic | null> = { "": null };
  topics.forEach((tp, i) => { out[String(i)] = tp; });
  if (page?.openingTopic) out.keep = page.openingTopic;
  return out;
}

/**
 * Whether a new lead from this page would be offered "Talk now": the account-level parts of the buyer voice
 * gate for a chat that has not started (lib/voice/buyer.ts buyerVoiceGate, no lead yet): voice is on for the
 * platform, the account lets buyers call, the account is live with a published agent, and it is not at its spend
 * cap (nor the platform at its budget, for live voice). Read only.
 */
export async function previewVoiceOffered(db: Db, account: Pick<SellerAccount, "id" | "status" | "voiceBuyerCallsOff">, now = new Date()): Promise<boolean> {
  const mode = voiceMode();
  if (mode === "off" || account.voiceBuyerCallsOff || account.status !== "live") return false;
  const [live] = await db.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
  if (!live) return false;
  if (await spendCapped(db, account.id, now)) return false;
  if (mode === "live" && (await platformBudget(db, now)).exceeded) return false;
  return true;
}

/**
 * The approved opening template a new lead from a page in this market and language would get as the chat's
 * first message, filled in for the sample buyer, or null (the opener then). The same decision as the chat
 * start (lib/chat/start.ts → lib/simulator/service.ts simulatorOpenerFacts and startSimulatorConversation):
 * an approved "opener" template in the lead's language, else in the market's languages in order, with the
 * lead's first name and the trade name in that language. A page for any market ("") uses the account's
 * languages (the buyer's market is only known from the phone). Read only.
 */
export async function previewOpenerTemplate(db: Db, account: SellerAccount, marketId: string, lang: PreviewLang): Promise<string | null> {
  const contact = marketContactSettings(account, await marketOfLead(db, account.id, marketId || null));
  const template = await approvedTemplate(db, account.id, "opener", lang, contact.languages);
  return template ? renderTemplate(template.body, templateVariables({ fullName: sampleBuyerName(lang), language: lang }, account)) : null;
}

export async function leadPagePreviewData(
  db: Db,
  account: SellerAccount,
  input: { page: LeadPage | null; topics: readonly LeadPageTopic[]; markets: readonly { id: string }[] },
): Promise<LeadPagePreviewData> {
  const { page, topics, markets } = input;
  const [settings] = await db.select({ brandColor: orderFormSettings.brandColor }).from(orderFormSettings).where(eq(orderFormSettings.accountId, account.id));
  const brand = safeBrand(settings?.brandColor);
  const playbook = await currentPlaybook(db, account.id);
  const choices = topicChoices(topics, page);
  const texts = {} as Record<PreviewLang, PreviewTexts>;
  for (const lang of PREVIEW_LANGS) {
    const tr = translator(lang);
    // The buyer pages' names (the live agent's); the opener uses the playbook the agent opens with (live, else the draft).
    const names = await chatNames(db, account, lang);
    const openerNames = buyerNames(playbook, account, lang);
    const name = sampleBuyerName(lang);
    const openers: Record<string, string> = {};
    const about: Record<string, string | null> = {};
    for (const [value, topic] of Object.entries(choices)) {
      about[value] = aboutLine(tr, topic, lang);
      // As lib/lead-pages/intake.ts stores it and lib/chat/start.ts reads it back: the topic in the form language, else none.
      const leadInterest = textIn(topic, lang) || null;
      openers[value] = openerText({ name, agent: openerNames.agent, company: openerNames.seller, gender: openerNames.gender, language: lang, opener: playbook?.opener, leadInterest });
    }
    texts[lang] = {
      lang, dir: lang === "he" ? "rtl" : "ltr",
      seller: names.seller, initials: initialsOf(names.seller),
      form: leadFormText(tr),
      consentLine: leadPageConsentParts(lang, names.seller, names.agent),
      thanks: tr("buyer.lp.handover.thanks", { name }),
      connecting: handoverConnectingLine(names, lang),
      buttons: { talkNow: tr("buyer.lp.handover.talk_now"), chatWriting: tr("buyer.lp.handover.chat_writing"), continueChat: tr("buyer.lp.handover.continue_chat") },
      byLine: tr("buyer.lp.handover.by_line"),
      openers,
      about,
      // As the buyer chat's header (app/chat/[token]/load.ts chatFrame, strings.ts).
      chat: {
        initials: names.seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
        automated: tg("buyer.sim.automated", names.gender, { agent: names.agent }, lang),
      },
    };
  }
  const privacy: string[] = [];
  const openerTemplates: Record<string, string> = {};
  for (const marketId of ["", ...markets.map((m) => m.id)]) {
    for (const lang of PREVIEW_LANGS) {
      if (await privacyNotice(db, { accountId: account.id, marketId: marketId || null, language: lang })) privacy.push(`${marketId}|${lang}`);
      const template = await previewOpenerTemplate(db, account, marketId, lang);
      if (template !== null) openerTemplates[`${marketId}|${lang}`] = template;
    }
  }
  return {
    texts,
    formStyle: brandVars(brand),
    handoverStyle: { ...brandVars(brand), "--bubble": buyerBubbleColor(brand) },
    voiceOffered: await previewVoiceOffered(db, account),
    privacy,
    savedBanner: page?.banner ? { src: bannerUrlPath(page.publicKey, page.banner), width: page.banner.width, height: page.banner.height } : null,
    openerTemplates,
  };
}
