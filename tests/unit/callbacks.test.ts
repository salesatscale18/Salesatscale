/**
 * O6, the last rung as a callback request: the time rules, the fold of the
 * lead events into the current request, the buyer's wording of the time, the
 * "Who takes calls" setting in the prompt, the tool definition and its voice
 * conversion, and the two "asks for a person" scenarios. Pure; no model calls.
 */
import { describe, expect, it } from "vitest";
import type { ContactHours, Playbook } from "@/db/schema";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign, objectionMethod, playsText } from "@/lib/agent/core/design";
import { callRoleOf, DEFAULT_CALL_ROLE, withCallRole } from "@/lib/agent/core/call-role";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { describeCall } from "@/lib/agent/trace";
import { appMessageKinds, isAppText, APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { checkScenario, nextBuyerText, scenarioById, type ScenarioRun } from "@/lib/agent/scenarios";
import { geminiSchema, realtimeTools, voiceToolDescription } from "@/lib/voice/tool-schema";
import { buyerCallTime, checkCallTime, cleanBrief, currentCallbackOf, currentCallbacks, parseCallTime, BRIEF_MAX } from "@/lib/callbacks/rules";
import { t } from "@/lib/i18n";

const TZ = "Asia/Jerusalem";
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const WEEKDAYS_9_17: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i >= 1 && i <= 5, from: "09:00", to: "17:00" }));
const pb: Playbook = defaultPlaybook("Acme", 500);
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en"] };
// Wednesday 18 Nov 2026, 10:00 in Jerusalem (UTC+2).
const NOW = new Date("2026-11-18T08:00:00Z");

describe("call time rules", () => {
  it("reads an ISO time with an offset, or a local date and time in the lead's zone", () => {
    expect(parseCallTime("2026-11-19T10:00:00+02:00", TZ)?.toISOString()).toBe("2026-11-19T08:00:00.000Z");
    expect(parseCallTime("2026-11-19T10:00", TZ)?.toISOString()).toBe("2026-11-19T08:00:00.000Z");
    expect(parseCallTime("2026-11-19 10:00", "Europe/London")?.toISOString()).toBe("2026-11-19T10:00:00.000Z");
    for (const bad of ["tomorrow at 10", "2026-11-19", "2026-11-19T25:00", 42, null]) expect(parseCallTime(bad, TZ)).toBeNull();
  });

  it("refuses a past time and offers the first allowed quarter hour from 15 minutes ahead", () => {
    const r = checkCallTime(ALL_DAY, TZ, new Date("2026-11-18T07:00:00Z"), NOW);
    expect(r).toMatchObject({ ok: false, why: "past" });
    expect(!r.ok && r.nearest?.toISOString()).toBe("2026-11-18T08:15:00.000Z");
    const soon = checkCallTime(ALL_DAY, TZ, new Date("2026-11-18T08:05:00Z"), NOW);
    expect(soon).toMatchObject({ ok: false, why: "too_soon" });
  });

  it("outside contact hours: the nearest allowed time, as schedule_follow_up offers it", () => {
    // Thursday 19 Nov 20:00 local: the last half hour before closing (16:30) is nearer than Friday 09:00.
    const r = checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-19T18:00:00Z"), NOW);
    expect(r).toMatchObject({ ok: false, why: "outside_hours" });
    expect(!r.ok && r.nearest?.toISOString()).toBe("2026-11-19T14:30:00.000Z");
    // Saturday: the next opening (Monday 09:00) or Friday 16:30, whichever is closer.
    const sat = checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-21T08:00:00Z"), NOW);
    expect(!sat.ok && sat.nearest).toBeTruthy();
    // A past time outside hours: the next allowed time, never one in the past.
    const night = checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-18T05:00:00Z"), new Date("2026-11-18T20:00:00Z"));
    expect(!night.ok && night.nearest?.toISOString()).toBe("2026-11-19T07:00:00.000Z");
    expect(checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-19T08:00:00Z"), NOW)).toEqual({ ok: true });
    expect(checkCallTime(ALL_DAY, TZ, new Date("2027-01-30T08:00:00Z"), NOW)).toMatchObject({ ok: false, why: "too_far", nearest: null });
  });

  it("a time the buyer named is accepted at any hour; one the agent proposed must be inside contact hours (owner, 20 Nov 2026)", () => {
    // Saturday 21 Nov 21:00 local: outside weekday 09:00-17:00.
    const sat = new Date("2026-11-21T19:00:00Z");
    expect(checkCallTime(WEEKDAYS_9_17, TZ, sat, NOW, { buyerNamed: true })).toEqual({ ok: true });
    const proposed = checkCallTime(WEEKDAYS_9_17, TZ, sat, NOW, { buyerNamed: false });
    expect(proposed).toMatchObject({ ok: false, why: "outside_hours" });
    // The nearest allowed time, inside contact hours: Friday 16:30 (14:30 UTC) is nearer than Monday 09:00.
    expect(!proposed.ok && proposed.nearest?.toISOString()).toBe("2026-11-20T14:30:00.000Z");
    expect(checkCallTime(WEEKDAYS_9_17, TZ, sat, NOW)).toMatchObject({ ok: false, why: "outside_hours" });
  });

  it("past and too-far times are refused either way", () => {
    for (const buyerNamed of [true, false]) {
      expect(checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-18T07:00:00Z"), NOW, { buyerNamed })).toMatchObject({ ok: false, why: "past" });
      expect(checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-11-18T08:05:00Z"), NOW, { buyerNamed })).toMatchObject({ ok: false, why: "too_soon" });
      expect(checkCallTime(WEEKDAYS_9_17, TZ, new Date("2026-12-19T19:00:00Z"), NOW, { buyerNamed })).toMatchObject({ ok: false, why: "too_far", nearest: null });
    }
  });

  it("the brief is one line, at most BRIEF_MAX characters", () => {
    expect(cleanBrief("  pricing\n for  3 sites ")).toBe("pricing for 3 sites");
    expect(cleanBrief("x".repeat(BRIEF_MAX + 50))).toHaveLength(BRIEF_MAX);
    expect(cleanBrief(undefined)).toBe("");
  });

  it("the buyer reads the time in their language and the lead's zone", () => {
    const at = new Date("2026-11-19T08:00:00Z");
    expect(buyerCallTime(at, TZ, "en")).toBe("Thursday 19 November at 10:00");
    expect(buyerCallTime(at, TZ, "he")).toBe("יום חמישי, 19 בנובמבר בשעה 10:00");
    expect(t("buyer.app.callback_confirmed", { time: buyerCallTime(at, TZ, "en") }, "en")).toBe("Your call is confirmed for Thursday 19 November at 10:00. Until then, I'm here for any question.");
    expect(t("buyer.app.callback_changed", { time: "x" }, "he")).toContain("הצוות העביר");
  });
});

describe("the current request, from lead events", () => {
  const ev = (type: string, minutes: number, data: Record<string, unknown>, leadId = "L1") =>
    ({ type, leadId, createdAt: new Date(NOW.getTime() + minutes * 60_000), data });

  it("the latest request wins; the seller's confirm and change apply to it only", () => {
    const events = [
      ev("callback.requested", 0, { callbackId: "a", at: "2026-11-19T08:00:00.000Z", timezone: TZ, brief: "price" }),
      ev("callback.confirmed", 1, { callbackId: "a", at: "2026-11-19T08:00:00.000Z" }),
      ev("callback.requested", 2, { callbackId: "b", at: "2026-11-20T08:00:00.000Z", timezone: TZ, brief: "fit" }),
      ev("callback.confirmed", 3, { callbackId: "a", at: "2026-11-19T09:00:00.000Z" }),
    ];
    expect(currentCallbackOf([...events].reverse())).toMatchObject({ id: "b", status: "requested", brief: "fit", at: new Date("2026-11-20T08:00:00.000Z") });
    const changed = currentCallbackOf([...events, ev("callback.changed", 4, { callbackId: "b", at: "2026-11-20T12:00:00.000Z", timezone: TZ })]);
    expect(changed).toMatchObject({ id: "b", status: "confirmed", changed: true, at: new Date("2026-11-20T12:00:00.000Z"), requestedFor: new Date("2026-11-20T08:00:00.000Z") });
    expect(currentCallbackOf([ev("lead.created", 0, {})])).toBeNull();
    expect(changed).toMatchObject({ buyerNamedTime: false, outsideHoursAsked: false });
    expect(currentCallbacks([...events, ev("callback.requested", 0, { callbackId: "c", at: "2026-11-19T08:00:00.000Z" }, "L2")]).map((c) => c.id).sort()).toEqual(["b", "c"]);
  });

  it("a buyer's time outside contact hours is noted until the seller sets another time", () => {
    const asked = ev("callback.requested", 0, { callbackId: "n", at: "2026-11-21T19:00:00.000Z", timezone: TZ, brief: "x", buyerNamedTime: true, outsideContactHours: true });
    expect(currentCallbackOf([asked])).toMatchObject({ buyerNamedTime: true, outsideHoursAsked: true });
    // Confirmed: still the buyer's time.
    expect(currentCallbackOf([asked, ev("callback.confirmed", 1, { callbackId: "n", at: "2026-11-21T19:00:00.000Z" })])).toMatchObject({ status: "confirmed", outsideHoursAsked: true });
    // Changed by the seller: their time, no note.
    expect(currentCallbackOf([asked, ev("callback.changed", 1, { callbackId: "n", at: "2026-11-21T20:00:00.000Z" })])).toMatchObject({ changed: true, outsideHoursAsked: false });
    // outsideContactHours without buyerNamedTime is never a note.
    expect(currentCallbackOf([ev("callback.requested", 0, { callbackId: "m", at: "2026-11-21T19:00:00.000Z", outsideContactHours: true })])).toMatchObject({ outsideHoursAsked: false });
  });
});

describe("Who takes calls (setting) in the prompt", () => {
  it("defaults to a member of our team; a custom role is used as written", () => {
    expect(callRoleOf(pb)).toBe(DEFAULT_CALL_ROLE);
    expect(callRoleOf({ callRole: "  " })).toBe("a member of our team");
    expect(callRoleOf({ callRole: "our sales manager" })).toBe("our sales manager");
    expect(withCallRole("a short call with our <role>, who", "our sales manager")).toBe("a short call with our sales manager, who");
    expect(withCallRole("talk to <role>", "Dana")).toBe("talk to Dana");
  });

  it("the editor saves it (trimmed, at most 60 characters); empty means the default", () => {
    const base: [string, string][] = [["agentName", "Maya"], ["goal", "Sell"], ["maxDiscount", "5"], ["offerMeetingWhen", ""], ["handOffWhen", ""]];
    const rows = (role: string) => playbookRowsFromForm([...base, ["callRole", role]]);
    const ok = parsePlaybookRows(rows("  our   sales manager "));
    expect(ok.ok && ok.value.callRole).toBe("our sales manager");
    const empty = parsePlaybookRows(rows(""));
    expect(empty.ok && "callRole" in empty.value).toBe(false);
    const long = parsePlaybookRows(rows("x".repeat(61)));
    expect(!long.ok && long.errors.callRole).toBe("Use 60 characters or fewer.");
    expect(playbookRowsFromForm(base).callRole).toBeUndefined();
  });

  it("the tools line names request_callback, keeps the chat with the agent and uses the role title", () => {
    const def = coreDesign({ tradeName: "Acme", meeting: false });
    expect(def).not.toContain('reason "call requested"');
    expect(def).not.toContain("one of our specialists");
    expect(def).not.toContain("a link to choose another");
    expect(def).toContain("- Call with a person. Framed as a help, with a proposed time the buyer can change; the team confirms it.");
    expect(def).toContain('I can set a short call with a member of our team. Does tomorrow at 10:00 work');
    expect(def).toContain("Then call request_callback with the time and a brief");
    expect(def).toContain("The chat stays with you: keep answering until the call, and never use hand_off_to_human for a call. Call the person \"a member of our team\".");
    expect(def).toContain('- Send the one approved item ("Send me information"): You cannot attach files. Give the summary in text; include a link only if it is listed in this play\'s facts.');
    expect(objectionMethod(2, "our sales manager")).toContain('Call the person "our sales manager".');
    const custom: Playbook = { ...pb, callRole: "our sales manager" };
    const p = stableSystemPrompt(custom, seller);
    expect(p).toContain("I can set a short call with our sales manager.");
    expect(p).toContain('Call the person "our sales manager".');
    // The play's <role> uses the setting ("A question with no approved answer", step 4).
    expect(playsText(custom)).toContain("I'll set a short call with our sales manager, who will have the exact answer.");
    expect(playsText(pb)).toContain("I'll set a short call with a member of our team, who will have the exact answer.");
    expect(playsText(pb)).not.toContain("<role>");
    // The voice prompt reads the same text.
    expect(stableSystemPrompt(custom, seller, null, { channel: "voice" })).toContain('Call the person "our sales manager".');
  });

  it("the turn context shows the open request, and that the agent keeps answering", () => {
    const ctx = turnContext({ ...pb, callRole: "our sales manager" }, null, { callback: { timeLocal: "Thu 19 Nov 10:00", confirmed: false } });
    expect(ctx).toContain("Call with our sales manager requested, waiting for the team to confirm: Thu 19 Nov 10:00. Keep answering until the call. If the buyer wants another time, call request_callback again.");
    expect(turnContext(pb, null, { callback: { timeLocal: "Thu 19 Nov 10:00", confirmed: true } })).toContain("Call with a member of our team confirmed by the team: Thu 19 Nov 10:00.");
    expect(turnContext(pb, null, {})).not.toContain("request_callback");
  });
});

describe("request_callback: definition, trace, voice", () => {
  const def = TOOL_DEFS.find((d) => d.name === "request_callback")!;

  it("is a strict tool with time, brief and buyer_named_time, and says the chat stays with the agent", () => {
    expect(def.strict).toBe(true);
    expect(def.input_schema).toEqual({
      type: "object",
      properties: { time: expect.objectContaining({ type: "string" }), brief: expect.objectContaining({ type: "string" }), buyer_named_time: expect.objectContaining({ type: "boolean" }) },
      required: ["time", "brief", "buyer_named_time"], additionalProperties: false,
    });
    expect(def.description).toContain("The conversation stays with you: keep answering until the call.");
    expect(def.description).toContain("A time the buyer named is accepted at any hour; a time you proposed yourself must be inside contact hours, otherwise it returns the nearest allowed time");
  });

  it("converts for both realtime dialects", () => {
    const gemini = realtimeTools("gemini").find((x) => x.name === "request_callback")!;
    expect(gemini.parameters).toEqual({
      type: "object",
      properties: {
        time: { type: "string", description: expect.any(String) }, brief: { type: "string", description: expect.any(String) },
        buyer_named_time: { type: "boolean", description: expect.any(String) },
      },
      required: ["time", "brief", "buyer_named_time"],
    });
    expect(geminiSchema(def.input_schema)).toEqual(gemini.parameters);
    expect(realtimeTools("openai").find((x) => x.name === "request_callback")!.parameters).toEqual(def.input_schema);
    expect(voiceToolDescription(def.description!)).not.toMatch(/\bin (the )?chat\b(?! below)/);
  });

  it("the seller's trace line and the app message kind", () => {
    expect(describeCall("request_callback", { time: "2026-11-19T10:00", brief: "price for 3 sites" }, { time_local: "Thu 19 Nov 10:00" }, "ok"))
      .toEqual({ label: "callback.request", sent: "2026-11-19T10:00: price for 3 sites", got: "Call requested for Thu 19 Nov 10:00; the team confirms it", missing: [] });
    const kinds = appMessageKinds([{ name: APP_MESSAGE_CALL, outcome: "ok", result: { message_id: "m1", kind: "callback" } }]);
    expect(kinds.get("m1")).toBe("callback");
    expect(isAppText("callback")).toBe(true);
  });
});

describe("the two asks-for-a-person scenarios", () => {
  const run = (over: Partial<ScenarioRun> = {}): ScenarioRun => ({ language: "en", conversationStatus: "open", leadStatus: "agent_handling", messages: [], calls: [], deal: null, ...over });
  const b = (body: string) => ({ actor: "buyer", body });
  const a = (body: string) => ({ actor: "agent", body });
  const call = (name: string, outcome: "ok" | "refused" = "ok") => ({ name, outcome, input: {}, result: {} });

  it("once: passes when the agent offers help, fails on a hand-off or a call request on the first ask", () => {
    expect(scenarioById("asks_for_person")!.title).toBe("Asks for a person once");
    const first = { messages: [b("I'd rather talk to a person"), a("Of course. What would you like to cover?")] };
    expect(checkScenario("asks_for_person", run(first))!.result).toBe("passed");
    expect(checkScenario("asks_for_person", run({ ...first, calls: [call("request_callback")] }))!.result).toBe("failed");
    expect(checkScenario("asks_for_person", run({ ...first, calls: [call("hand_off_to_human")], conversationStatus: "human" }))!.result).toBe("failed");
  });

  it("twice: passes on a call request at the second ask with the chat kept; fails on a hand-off or no call", () => {
    const s = scenarioById("asks_for_person_twice")!;
    expect(s.title).toBe("Asks for a person twice");
    expect(s.buyerTurns).toHaveLength(1);
    const twice = [b(s.opening), a("Of course. What would you like to cover?"), b(s.buyerTurns![0]), a("Done: a member of our team will call you tomorrow at 10:00.")];
    expect(checkScenario(s.id, run({ messages: twice.slice(0, 2) }))!.result).toBe("not_yet");
    expect(checkScenario(s.id, run({ messages: twice.slice(0, 3) }))!.result).toBe("not_yet");
    expect(checkScenario(s.id, run({ messages: twice, calls: [call("request_callback")] }))!.result).toBe("passed");
    expect(checkScenario(s.id, run({ messages: twice, calls: [call("request_callback", "refused")] }))!.result).toBe("failed");
    expect(checkScenario(s.id, run({ messages: twice.slice(0, 2), calls: [call("request_callback")] }))!.result).toBe("failed");
    expect(checkScenario(s.id, run({ messages: twice, calls: [call("hand_off_to_human")], conversationStatus: "human" }))!.result).toBe("failed");
    expect(checkScenario(s.id, run({ messages: twice, calls: [call("request_callback")], conversationStatus: "human" }))!.result).toBe("failed");
  });

  it("the test lab fills in the next buyer message after each agent reply", () => {
    const s = scenarioById("asks_for_person_twice")!;
    expect(nextBuyerText(s, [])).toBe(s.opening);
    expect(nextBuyerText(s, [{ actor: "buyer" }])).toBeUndefined();
    expect(nextBuyerText(s, [{ actor: "buyer" }, { actor: "agent" }])).toBe(s.buyerTurns![0]);
    expect(nextBuyerText(s, [{ actor: "buyer" }, { actor: "agent" }, { actor: "buyer" }, { actor: "agent" }])).toBeUndefined();
    // A one-turn scenario only fills in its opening.
    expect(nextBuyerText(scenarioById("asks_for_person")!, [{ actor: "buyer" }, { actor: "agent" }])).toBeUndefined();
  });
});
