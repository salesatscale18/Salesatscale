/**
 * Demo seed: one finished buyer voice call (live voice, release 2), so the
 * seller views show a call without anyone calling. No model call and no
 * network: the rows are written with the same fields the real flow writes.
 *
 * The lead (Gal Demo, a new English buyer in the Israel market) chatted with
 * the agent on the web chat page, then pressed "Talk to us". As a real buyer
 * call does, the call joins that same conversation (channel "simulator"):
 * - the chat: the agent's opener, as startSimulatorConversation writes it,
 *   and one exchange;
 * - the buyer's voice consent (recordVoiceConsent, the same service);
 * - a `voice_sessions` row as createVoiceSession creates it and the engine
 *   (lib/voice/engine.ts) connects and ends it: mode "scripted", cost 0,
 *   ended by the buyer (user_hangup), with its answer time average;
 * - the spoken lines as the engine stores them (handleBuyerFinal,
 *   finalizeAgentTurn): `voice_session_id`, `spoken_at_ms` (offset in the
 *   call), `answer_ms` on agent lines, one line typed during the call, and the
 *   tool call of an agent turn linked to its message. The agent opens with the
 *   fixed disclosure line of a call that continues a chat (continuingLine);
 * - the engine's closing system message "Voice call ended · m:ss", from which
 *   the thread shows the call's summary row.
 *
 * Needs you is unchanged: the lead is agent-handled, nothing waits for a person.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, conversations, dealStates, leadEvents, leads, messages, sellerAccounts, toolCalls, voiceSessions } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { buyerNames } from "@/lib/agent/core/names";
import { openerText } from "@/lib/agent/core/opener";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { ensureChatLink } from "@/lib/simulator/service";
import { recordVoiceConsent } from "@/lib/voice/buyer";
import { continuingLine } from "@/lib/voice/instructions";
import { DEFAULT_VOICE_MODEL, maxCallSeconds } from "@/lib/voice/settings";
import { DEMO_SOURCE_REF_PREFIX, demoPhone } from "./phones";

/** The lead with the finished call (demo phone 13: 1–3 are the seed's new leads, 4–12 the review states). */
export const VOICE_CALL_LEAD = { n: 13, fullName: "Gal Demo", company: "Gym Demo Netanya", email: "gal@gym-demo.example", language: "en" } as const;

/** The chat before the call (minutes before `now`). */
export const VOICE_CALL_CHAT = {
  buyer: "Hi, we run two gyms with juice bars. The fridges there keep failing on weekends.",
  agent: "That sounds costly. How many fridges do you have across both gyms?",
} as const;

/** The call: started CALL_AGO_MIN minutes before `now`, DURATION_SEC long. */
export const VOICE_CALL = { agoMin: 30, durationSec: 64 } as const;

type CallLine = {
  actor: "buyer" | "agent";
  /** Offset in the call when the line started (ms). */
  atMs: number;
  /** How long it took to say (ms): the engine stores a line once it is finished. */
  lenMs: number;
  body: string;
  answerMs?: number | null;
  typed?: boolean;
  calls?: { name: string; input: Record<string, unknown>; result: Record<string, unknown> }[];
};

/** The spoken lines after the disclosure line (see callLines). */
export const VOICE_CALL_LINES = {
  pickUp: "You were telling me about the fridges at your two gyms.",
  fridges: "Right. We have five fridges in total, three here in Netanya and two in the second gym.",
  plan: "Got it, five fridges at two sites. Each fridge gets a small wireless sensor and each site one gateway, so you hear about a warm fridge on WhatsApp right away.",
  typed: "The second gym is in Kfar Yona",
  install: "Thanks. Installation is included, and we can do both sites in one visit. Would you like a quote for the two sites?",
  run: "Yes, but I have to run to a class now. I'll read it in the chat later.",
  bye: "No problem. Everything we said stays in the chat, so you can pick it up there any time. Have a good class, Gal!",
} as const;

function callLines(disclosure: string): CallLine[] {
  const L = VOICE_CALL_LINES;
  return [
    // The agent speaks first when the call connects (no buyer turn before it: answerMs null).
    { actor: "agent", atMs: 1_200, lenMs: 6_800, body: `${disclosure} ${L.pickUp}`, answerMs: null },
    { actor: "buyer", atMs: 9_400, lenMs: 5_000, body: L.fridges },
    {
      actor: "agent", atMs: 15_300, lenMs: 9_500, body: L.plan, answerMs: 850,
      calls: [{ name: "update_deal_state", input: { updates: [{ key: "sites", value: "2", provenance: "buyer" }] }, result: { ok: true, saved: ["sites"] } }],
    },
    { actor: "buyer", atMs: 31_000, lenMs: 0, body: L.typed, typed: true },
    { actor: "agent", atMs: 33_800, lenMs: 7_400, body: L.install, answerMs: 700 },
    { actor: "buyer", atMs: 45_600, lenMs: 4_200, body: L.run },
    { actor: "agent", atMs: 50_700, lenMs: 7_800, body: L.bye, answerMs: 900 },
  ];
}

/** The engine's closing note (lib/voice/engine.ts CALL_ENDED_TEXT, not exported there). */
export const callEndedText = (sec: number) => `Voice call ended · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

const minAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

export type VoiceCallSeed = { leadId: string; conversationId: string; voiceSessionId: string };

/** Seeds the lead, its web chat and its finished call. `now` anchors every timestamp. */
export async function seedVoiceCall(
  db: Db, actor: Actor & { userId: string }, accountId: string, opts: { liveVersionId: string; now: Date },
): Promise<VoiceCallSeed> {
  const { now, liveVersionId } = opts;
  const l = VOICE_CALL_LEAD;

  // The lead: fictional number and demo source ID, never contacted (as the other state leads).
  const parsed = parseLead(
    { fullName: l.fullName, company: l.company, email: l.email, language: l.language, phone: demoPhone(l.n), consent: "on", consentSource: "Demo data: fictional lead", sourceLabel: "Demo seed", sourceRef: `${DEMO_SOURCE_REF_PREFIX}${l.n}` },
    "IL", { language: "en", now, consentNeedsTick: true },
  );
  if (!parsed.ok) throw new Error(`Demo seed: lead ${l.fullName} is invalid: ${JSON.stringify(parsed.errors)}`);
  const added = minAgo(now, 60);
  const r = await upsertLead(db, accountId, actor, parsed.value, "manual", { now: added, createOnly: true });
  if (!r.ok) throw new Error(`Demo seed: lead ${l.fullName} not saved: ${r.reason}`);
  const leadId = r.lead.id;
  await db.update(leads).set({ createdAt: added }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  // The buyer's chat link (the call is started from the chat page).
  await ensureChatLink(db, actor, accountId, leadId);

  // The web chat, as startSimulatorConversation opens it, then one exchange.
  const [[account], [version]] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select().from(agentVersions).where(and(eq(agentVersions.id, liveVersionId), eq(agentVersions.accountId, accountId))),
  ]);
  if (!account || !version) throw new Error("Demo seed: voice call account or version not found");
  const names = buyerNames(version.playbook, account, "en");
  const firstName = l.fullName.split(/\s+/)[0];
  const opener = openerText({ name: firstName, agent: names.agent, company: names.seller, gender: names.gender, language: "en", opener: version.playbook.opener });
  const conversationId = randomUUID();
  const chatStart = minAgo(now, 45);
  await db.insert(conversations).values({
    id: conversationId, accountId, leadId, channel: SIMULATOR_CHANNEL, agentVersionId: liveVersionId, language: "en", createdByUserId: actor.userId,
    createdAt: chatStart, updatedAt: chatStart,
  });
  await db.insert(messages).values([
    { accountId, conversationId, actor: "agent", body: opener, language: "en", agentVersionId: liveVersionId, deliveryStatus: "delivered", createdAt: chatStart },
    { accountId, conversationId, actor: "buyer", body: VOICE_CALL_CHAT.buyer, language: "en", createdAt: minAgo(now, 43) },
    { accountId, conversationId, actor: "agent", body: VOICE_CALL_CHAT.agent, language: "en", agentVersionId: liveVersionId, createdAt: minAgo(now, 42) },
  ]);
  await db.insert(leadEvents).values({
    accountId, leadId, type: "conversation.started", actor: "human", actorUserId: actor.userId,
    data: { conversationId, channel: SIMULATOR_CHANNEL }, createdAt: chatStart,
  });

  // The buyer agreed to talk by voice (the sheet's Start call), then the call.
  const created = minAgo(now, VOICE_CALL.agoMin);
  await recordVoiceConsent(db, accountId, leadId, created);
  const connectedAt = new Date(created.getTime() + 2_000);
  const endedAt = new Date(connectedAt.getTime() + VOICE_CALL.durationSec * 1000);
  const lines = callLines(continuingLine({ firstName, agent: names.agent, seller: names.seller }));
  const answers = lines.map((x) => x.answerMs).filter((x): x is number => typeof x === "number");
  const voiceSessionId = randomUUID();
  await db.insert(voiceSessions).values({
    id: voiceSessionId, accountId, conversationId, agentVersionId: liveVersionId, startedByUserId: null, isTest: false,
    status: "ended", createdAt: created, connectedAt, endedAt, endReason: "user_hangup", errorCode: null,
    model: DEFAULT_VOICE_MODEL, mode: "scripted", durationSec: VOICE_CALL.durationSec,
    answerMsAvg: Math.round(answers.reduce((a, b) => a + b, 0) / answers.length), usage: null, costMicros: 0,
    settings: { ...version.voiceSettings, maxCallSec: maxCallSeconds({ settings: version.voiceSettings, deadlineSec: null, env: {} }) },
    // A used one-time ticket (only its hash is ever stored).
    ticketHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"), ticketUsedAt: new Date(created.getTime() + 1_000),
  });
  for (const x of lines) {
    const id = randomUUID();
    const at = new Date(connectedAt.getTime() + x.atMs + x.lenMs);
    await db.insert(messages).values(x.actor === "agent"
      ? { id, accountId, conversationId, actor: "agent", body: x.body, language: "en", agentVersionId: liveVersionId, voiceSessionId, spokenAtMs: x.atMs, answerMs: x.answerMs ?? null, createdAt: at }
      : { id, accountId, conversationId, actor: "buyer", body: x.body, language: "en", voiceSessionId, spokenAtMs: x.atMs, typedInCall: !!x.typed, createdAt: at });
    if (x.calls?.length) {
      await db.insert(toolCalls).values(x.calls.map((c, i) => ({
        accountId, conversationId, messageId: id, sequence: i + 1, name: c.name, input: c.input, result: c.result, outcome: "ok" as const, createdAt: at,
      })));
    }
  }
  // The engine's closing note, at the end of the call.
  await db.insert(messages).values({ accountId, conversationId, actor: "system", body: callEndedText(VOICE_CALL.durationSec), language: "en", createdAt: endedAt });
  await db.insert(dealStates).values({ accountId, leadId, fields: { sites: { value: "2", provenance: "buyer", updatedAt: new Date(connectedAt.getTime() + 24_800).toISOString() } } });
  await db.update(conversations).set({ updatedAt: endedAt }).where(and(eq(conversations.accountId, accountId), eq(conversations.id, conversationId)));
  await db.update(leads).set({ status: "agent_handling", lastActivityAt: endedAt }).where(and(eq(leads.accountId, accountId), eq(leads.id, leadId)));
  return { leadId, conversationId, voiceSessionId };
}
