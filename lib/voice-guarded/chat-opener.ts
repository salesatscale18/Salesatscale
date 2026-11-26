/**
 * The written opener the chat would post for this lead (lib/simulator/service.ts startSimulatorConversation, via
 * lib/chat/start.ts): the approved opening template when the lead's language has one, else the fixed opener
 * (lib/agent/core/opener.ts) with what the lead asked about on the form or lead page. A call on a conversation with no
 * agent message speaks exactly this line first (owner, 26 Nov 2026: "Talk now" opens an empty chat and the spoken
 * opener is its first message), so the spoken and the written opener never differ.
 *
 * Null for a lead the chat would not open for (a test-lab lead, no live agent): the caller keeps its own opener.
 * No model call. Imports are lazy: lib/simulator/service imports lib/voice (no import cycle at load).
 */
import type { Db } from "@/db/types";
import type { AgentVersion, Lead, SellerAccount } from "@/db/schema";
import { openerText } from "@/lib/agent/core/opener";
import { buyerNames } from "@/lib/agent/core/names";
import { renderTemplate, templateVariables } from "@/lib/channels/rules";
import { isLocale } from "@/lib/i18n";

export async function chatOpenerText(
  db: Db, a: { account: SellerAccount; version: Pick<AgentVersion, "playbook">; lead: Lead }, language: string, now = new Date(),
): Promise<string | null> {
  if (a.lead.isTest) return null;
  const [{ simulatorOpenerFacts }, { leadInterest }] = await Promise.all([import("@/lib/simulator/service"), import("@/lib/chat/start")]);
  const facts = await simulatorOpenerFacts(db, a.account.id, a.lead.id, now);
  if (!facts?.live) return null;
  const lang = isLocale(language) ? language : isLocale(a.lead.language) ? a.lead.language : "en";
  const vars = templateVariables(a.lead, a.account);
  if (facts.template) return renderTemplate(facts.template.body, vars);
  const names = buyerNames(a.version.playbook, a.account, lang);
  return openerText({
    name: vars["1"], agent: names.agent, company: names.seller, gender: names.gender, language: lang, opener: a.version.playbook.opener,
    leadInterest: await leadInterest(db, a.account.id, a.lead.id),
  });
}
