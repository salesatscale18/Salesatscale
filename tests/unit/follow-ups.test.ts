/**
 * Agreed follow-ups (P11 follow-up, decision 4): pure rules. Time window,
 * contact hours (nearest allowed time), the fixed template EN/HE with names
 * and gender, the scheduler's decision per due row, and the cron route's auth.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTACT_HOURS } from "@/lib/accounts/contact-hours";
import { cronAuthorized } from "@/lib/follow-ups/cron-auth";
import {
  cleanTopic, decideDue, dueWindow, followUpText, formatDueLocal, isoInZone, localNowLine, nearestAllowedTime, parseDueAt, reasonText, zonedInstant,
  type DueFacts,
} from "@/lib/follow-ups/rules";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { coreDesign } from "@/lib/agent/core/design";
import { turnContext } from "@/lib/agent/prompt";
import { describeCall } from "@/lib/agent/trace";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { isAppText, appMessageKinds } from "@/lib/agent/app-message";

const TZ = "Asia/Jerusalem";
// Tue 17 Nov 2026 12:00 in Jerusalem (UTC+2).
const NOW = new Date("2026-11-17T10:00:00Z");
const MIN = 60_000;

describe("due time", () => {
  it("needs an ISO date-time with an offset", () => {
    expect(parseDueAt("2026-11-18T10:00:00+02:00")?.toISOString()).toBe("2026-11-18T08:00:00.000Z");
    expect(parseDueAt("2026-11-18T10:00Z")?.toISOString()).toBe("2026-11-18T10:00:00.000Z");
    expect(parseDueAt("2026-11-18T10:00:00")).toBeNull();
    expect(parseDueAt("tomorrow at 10")).toBeNull();
    expect(parseDueAt(42)).toBeNull();
  });

  it("is between 15 minutes and 30 days ahead", () => {
    expect(dueWindow(new Date(NOW.getTime() + 14 * MIN), NOW)).toBe("too_soon");
    expect(dueWindow(new Date(NOW.getTime() - 60 * MIN), NOW)).toBe("too_soon");
    expect(dueWindow(new Date(NOW.getTime() + 15 * MIN), NOW)).toBe("ok");
    expect(dueWindow(new Date(NOW.getTime() + 30 * 24 * 60 * MIN), NOW)).toBe("ok");
    expect(dueWindow(new Date(NOW.getTime() + 30 * 24 * 60 * MIN + MIN), NOW)).toBe("too_far");
  });

  it("keeps the topic short and on one line", () => {
    expect(cleanTopic("  the  second\nkitchen ")).toBe("the second kitchen");
    expect(cleanTopic("")).toBeNull();
    expect(cleanTopic(null)).toBeNull();
    expect(cleanTopic("x".repeat(300))).toHaveLength(120);
  });
});

describe("time zones", () => {
  it("converts local wall-clock times and back", () => {
    expect(zonedInstant(TZ, "2026-11-18", "10:00").toISOString()).toBe("2026-11-18T08:00:00.000Z");
    // Summer time (UTC+3).
    expect(zonedInstant(TZ, "2026-07-01", "10:00").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(isoInZone(new Date("2026-11-18T08:00:00Z"), TZ)).toBe("2026-11-18T10:00:00+02:00");
    expect(isoInZone(new Date("2026-11-18T08:00:00Z"), "America/New_York")).toBe("2026-11-18T03:00:00-05:00");
    expect(formatDueLocal(new Date("2026-11-18T08:00:00Z"), TZ)).toBe("Wed 18 Nov 10:00");
    expect(localNowLine(NOW, TZ)).toBe("Tue 17 Nov 2026 12:00 (Asia/Jerusalem, UTC+02:00)");
  });
});

describe("nearest allowed time (default hours Sun–Thu 08:30–20:00, Fri 08:30–13:00, Sat off)", () => {
  const at = (iso: string) => new Date(iso);
  it("late evening: the last half hour before closing is nearer than tomorrow's opening", () => {
    // Tue 21:00 local → Tue 19:30.
    const n = nearestAllowedTime(DEFAULT_CONTACT_HOURS, TZ, at("2026-11-17T19:00:00Z"), NOW);
    expect(formatDueLocal(n!, TZ)).toBe("Tue 17 Nov 19:30");
  });
  it("early morning: today's opening", () => {
    // Wed 06:00 local → Wed 08:30.
    const n = nearestAllowedTime(DEFAULT_CONTACT_HOURS, TZ, at("2026-11-18T04:00:00Z"), NOW);
    expect(formatDueLocal(n!, TZ)).toBe("Wed 18 Nov 08:30");
  });
  it("Saturday (off): Friday before closing or Sunday's opening, whichever is nearer", () => {
    // Sat 10:00 local: Fri 12:30 is 21.5 h before, Sun 08:30 is 22.5 h after.
    const n = nearestAllowedTime(DEFAULT_CONTACT_HOURS, TZ, at("2026-11-21T08:00:00Z"), NOW);
    expect(formatDueLocal(n!, TZ)).toBe("Fri 20 Nov 12:30");
    // Sat 20:00 local: Sun 08:30 is nearer.
    const m = nearestAllowedTime(DEFAULT_CONTACT_HOURS, TZ, at("2026-11-21T18:00:00Z"), NOW);
    expect(formatDueLocal(m!, TZ)).toBe("Sun 22 Nov 08:30");
  });
  it("never offers a time less than 15 minutes ahead", () => {
    // Now Tue 19:50 local, wanted Tue 21:00: 19:30 is past, so Wed 08:30.
    const now = at("2026-11-17T17:50:00Z");
    const n = nearestAllowedTime(DEFAULT_CONTACT_HOURS, TZ, at("2026-11-17T19:00:00Z"), now);
    expect(formatDueLocal(n!, TZ)).toBe("Wed 18 Nov 08:30");
  });
});

describe("the follow-up message (fixed template, no model call)", () => {
  const playbook = { agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" as const };
  const account = { tradeName: "Polar Demo", tradeNameLocal: { he: "פולאר" } };
  it("English, with the buyer's first name, the agent and the seller", () => {
    expect(followUpText({ language: "en", leadName: "Rina Cohen", playbook, account, topic: "the quote for the second kitchen" }))
      .toBe("Hi Rina, it's Maya from Polar Demo. You asked me to check back today about the quote for the second kitchen. Is now a good time?");
    expect(followUpText({ language: "en", leadName: "Rina", playbook, account, topic: null }))
      .toBe("Hi Rina, it's Maya from Polar Demo. You asked me to check back today. Is now a good time?");
  });
  it("Hebrew follows the agent's gender, with the local names", () => {
    expect(followUpText({ language: "he", leadName: "רינה כהן", playbook, account, topic: "ההצעה למטבח השני" }))
      .toBe("היי רינה, זו מאיה מפולאר. ביקשת שאחזור אליך היום לגבי ההצעה למטבח השני. זה זמן טוב לדבר?");
    expect(followUpText({ language: "he", leadName: "רינה", playbook: { agentName: "Dan", agentNameLocal: { he: "דן" }, agentGender: "male" }, account, topic: null }))
      .toBe("היי רינה, זה דן מפולאר. ביקשת שאחזור אליך היום. זה זמן טוב לדבר?");
  });
  it("falls back to the main names and a neutral form", () => {
    const text = followUpText({ language: "he", leadName: "רינה", playbook: { agentName: "Maya" }, account: { tradeName: "Polar" }, topic: null });
    expect(text).toBe("היי רינה, כאן Maya מ-Polar. ביקשת שאחזור אליך היום. זה זמן טוב לדבר?");
    expect(text).not.toContain("/");
  });
});

describe("what the scheduler does with a due follow-up", () => {
  const ok: DueFacts = {
    leadOptedOut: false, accountStatus: "live", needsLiveAccount: true, conversationStatus: "open", paid: false,
    buyerWroteAfterScheduling: false, withinContactHours: true,
  };
  it.each([
    [{ leadOptedOut: true }, "opted_out"],
    [{ accountStatus: "paused" }, "account_paused"],
    [{ accountStatus: "setting_up" }, "account_not_live"],
    [{ conversationStatus: "closed" }, "conversation_closed"],
    [{ conversationStatus: "human" }, "taken_over"],
    [{ paid: true }, "paid"],
    [{ buyerWroteAfterScheduling: true }, "buyer_replied"],
  ] as [Partial<DueFacts>, string][])("%j → cancelled (%s)", (patch, reason) => {
    expect(decideDue({ ...ok, ...patch, withinContactHours: false })).toEqual({ action: "cancel", reason });
  });
  it("a simulated or test chat may run while the account is setting up", () => {
    expect(decideDue({ ...ok, accountStatus: "setting_up", needsLiveAccount: false })).toEqual({ action: "send" });
  });
  it("outside contact hours it waits; inside, it sends", () => {
    expect(decideDue({ ...ok, withinContactHours: false })).toEqual({ action: "defer" });
    expect(decideDue(ok)).toEqual({ action: "send" });
  });
  it("reasons read as plain words", () => {
    expect(reasonText("buyer_replied")).toBe("the buyer wrote first");
    expect(reasonText("whatsapp_window_closed")).toContain("24-hour window");
    expect(reasonText(null)).toBe("");
  });
});

describe("cron route authorization", () => {
  const secret = "s3cret-s3cret-s3cret";
  it("refuses without a configured secret", () => {
    expect(cronAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer short", "short")).toBe(false);
  });
  it("needs exactly Bearer <secret>", () => {
    expect(cronAuthorized(null, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
    expect(cronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronAuthorized("Bearer wrong", secret)).toBe(false);
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });
});

describe("agent side", () => {
  it("schedule_follow_up has a strict { due_at, topic } schema", () => {
    const def = TOOL_DEFS.find((d) => d.name === "schedule_follow_up");
    expect(def).toMatchObject({ strict: true, input_schema: { type: "object", required: ["due_at", "topic"], additionalProperties: false } });
  });
  it("the core design and the two play cards offer to come back yourself, never the sales team", () => {
    const core = coreDesign({ tradeName: "Polar", meeting: true });
    expect(core).toContain("### When the buyer needs time");
    expect(core).toContain("call schedule_follow_up");
    expect(core).toContain('Never say "our sales team will come back to you"');
    for (const key of ["need_to_think", "not_now"] as const) {
      const card = DEFAULT_PLAYS[key];
      expect(card.do.join(" ")).toContain("schedule_follow_up");
      expect(card.example).toMatch(/tomorrow at 10|Tuesday at 10/);
      expect(card.example.toLowerCase()).not.toContain("sales team");
    }
    expect(DEFAULT_PLAYS.need_to_think.notThis).toContain("sales team");
  });
  it("the per-turn context shows the scheduled follow-up and the local time", () => {
    const pb = { agentName: "Maya", goal: "g", tone: "t", outcomes: { orderForm: true, bankTransfer: false, meeting: false }, fields: [], objections: [], maxDiscountBp: 0, offerMeetingWhen: "", handOffWhen: "", neverDo: [] } as never;
    const ctx = turnContext(pb, null, { agentMessages: 2, followUp: { dueLocal: "Wed 18 Nov 10:00", topic: "the second kitchen" }, localNow: localNowLine(NOW, TZ) });
    expect(ctx).toContain("Follow-up scheduled: you write to the buyer on Wed 18 Nov 10:00 about the second kitchen.");
    expect(ctx).toContain("Local time now: Tue 17 Nov 2026 12:00 (Asia/Jerusalem, UTC+02:00)");
    expect(turnContext(pb, null, { agentMessages: 2 })).not.toContain("Follow-up scheduled");
  });
  it("the trace and the seller views name it", () => {
    expect(describeCall("schedule_follow_up", { due_at: "2026-11-18T10:00:00+02:00", topic: "kitchen" }, { due_local: "Wed 18 Nov 10:00" }, "ok"))
      .toEqual({ label: "follow_up.schedule", sent: "2026-11-18T10:00:00+02:00: kitchen", got: "Follow-up set for Wed 18 Nov 10:00", missing: [] });
    expect(isAppText("follow_up")).toBe(true);
    expect(appMessageKinds([{ name: "app_message", outcome: "ok", result: { message_id: "m1", kind: "follow_up" } }]).get("m1")).toBe("follow_up");
  });
});
