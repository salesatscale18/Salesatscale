/**
 * The realtime model's session instructions (live voice), built from the SAME
 * source as the chat prompt: the stable prompt and the per-turn context with
 * channel "voice" (lib/agent/core/voice.ts replaces the chat lines), computed
 * once when the call starts. The model does not need a refresh tool:
 * update_deal_state already returns the stage as it is now.
 *
 * The opener is the chat opener (lib/agent/core/opener.ts, the same text the
 * simulator sends), which already says the agent is an automated assistant;
 * in a call the agent speaks it first.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { messages, type AgentVersion, type Conversation, type DealState, type Lead, type SellerAccount } from "@/db/schema";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { openerText } from "@/lib/agent/core/opener";
import { buyerNames } from "@/lib/agent/core/names";
import { loadStageFacts } from "@/lib/agent/core/stage-facts";
import type { StageFacts } from "@/lib/agent/core/stage";
import type { ExampleCatalogItem } from "@/lib/agent/core/examples";
import type { PlainItem } from "@/lib/agent/prompt";
import { publishedCatalog } from "@/lib/catalog/service";
import { scheduledFollowUp } from "@/lib/follow-ups/schedule";
import { formatDueLocal, localNowLine } from "@/lib/follow-ups/rules";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { maskCardNumbers } from "./safety";
import { paceInstruction, resolveVoiceSettings } from "./settings";

/** Most earlier conversation lines given to the model (a recap, not the whole history). */
export const RECAP_LINES = 10;

export type TranscriptLine = { role: "buyer" | "agent" | "human"; text: string };

export type VoiceInstructionInput = {
  playbook: AgentVersion["playbook"];
  voiceSettings: AgentVersion["voiceSettings"];
  seller: { tradeName: string; currency: string; languages: string[] };
  catalog: (ExampleCatalogItem & PlainItem)[] | null;
  deal: Pick<DealState, "fields" | "objections" | "nextStep" | "summary"> | null;
  stage: StageFacts;
  /** Agent messages already in the conversation, before the opener. */
  agentMessages: number;
  names: ReturnType<typeof buyerNames>;
  opener: string;
  localNow: string | null;
  followUp: { dueLocal: string; topic: string | null } | null;
  /** The conversation so far (oldest first): earlier chat, or the call before a reconnect. */
  recap: TranscriptLine[];
  /** After a reconnect: the opener was already spoken. */
  resumed?: boolean;
};

const ROLE: Record<TranscriptLine["role"], string> = { buyer: "Buyer", agent: "You", human: "A person from the team" };

/** The session instructions (pure). */
export function buildVoiceInstructions(i: VoiceInstructionInput): string {
  const settings = resolveVoiceSettings(i.voiceSettings);
  const stable = stableSystemPrompt(i.playbook, { ...i.seller, languages: ["en"] }, i.catalog, { channel: "voice", fillers: settings.fillers });
  // The opener counts as an agent turn: the stage moves on once the buyer answers it.
  const context = turnContext(i.playbook, i.deal, {
    stage: i.stage, agentMessages: i.agentMessages + 1, opener: i.resumed ? null : i.opener, catalog: i.catalog, names: i.names,
    followUp: i.followUp, localNow: i.localNow, channel: "voice",
  });
  const recap = i.recap.slice(-RECAP_LINES).map((l) => `- ${ROLE[l.role]}: ${maskCardNumbers(l.text.replace(/\s+/g, " ").trim()).text.slice(0, 400)}`);
  const call = [
    "## This call",
    i.resumed
      ? "The call dropped for a moment and is connected again. Do not introduce yourself again and do not repeat the opening. Wait for the buyer, or carry on where you were."
      : "When the call connects, say your opening line, then listen.",
    paceInstruction(settings.pace),
    i.deal?.summary ? `Summary so far: ${i.deal.summary}` : "",
    recap.length ? `Conversation so far (latest last):\n${recap.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return `${stable}\n\n${context}\n${call}\nConversation language: en.`;
}

/** The instruction that makes the model speak the opener. */
export function openerInstruction(opener: string): string {
  return `The call has just connected. Say your opening line now, in your own voice: "${opener}"`;
}

export type VoiceCallContext = { instructions: string; opener: string };

/** Loads what the instructions need for this conversation and builds them. */
export async function loadVoiceInstructions(
  db: Db,
  a: { account: SellerAccount; version: AgentVersion; conv: Conversation; lead: Lead; deal: DealState | null; now: Date },
  opts: { recap?: TranscriptLine[]; resumed?: boolean } = {},
): Promise<VoiceCallContext> {
  const { account, version, conv, lead } = a;
  const [stage, catalog, followUp, contact, earlier, agentCount] = await Promise.all([
    loadStageFacts(db, account.id, lead.id),
    publishedCatalog(db, account.id).catch(() => null),
    scheduledFollowUp(db, account.id, lead.id),
    leadContactSettings(db, account, lead.marketId),
    db.select({ actor: messages.actor, body: messages.body }).from(messages)
      .where(and(eq(messages.accountId, account.id), eq(messages.conversationId, conv.id))).orderBy(desc(messages.createdAt)).limit(RECAP_LINES),
    db.select({ id: messages.id }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.conversationId, conv.id), eq(messages.actor, "agent"))),
  ]);
  // A call is English only (decision: release 1).
  const names = buyerNames(version.playbook, account, "en");
  const firstName = lead.fullName.trim().split(/\s+/)[0] || "there";
  const opener = openerText({ name: firstName, agent: names.agent, company: names.seller, gender: names.gender, language: "en", opener: version.playbook.opener });
  const recap = opts.recap ?? earlier.reverse()
    .filter((m) => m.actor === "buyer" || m.actor === "agent" || m.actor === "human")
    .map((m) => ({ role: m.actor as TranscriptLine["role"], text: m.body }));
  const activeItems = catalog?.items.filter((x) => x.active) ?? null;
  const instructions = buildVoiceInstructions({
    playbook: version.playbook, voiceSettings: version.voiceSettings,
    seller: { tradeName: account.tradeName, currency: account.currency, languages: contact.languages },
    catalog: activeItems, deal: a.deal, stage, agentMessages: agentCount.length, names, opener,
    localNow: localNowLine(a.now, contact.timezone),
    followUp: followUp ? { dueLocal: formatDueLocal(followUp.dueAt, contact.timezone), topic: followUp.topic } : null,
    recap, resumed: opts.resumed,
  });
  return { instructions, opener };
}
