/**
 * W4 (board ConvSteps): the "Show agent steps" preference (defaults, per-user
 * cookie, URL wins, workspace and test lab apart, the safe return path) and
 * the thread markers built from existing data.
 */
import { describe, expect, it } from "vitest";
import { STEPS_COOKIE, readAgentSteps, safeBack, stepsCookieValue } from "@/lib/conversations/agent-steps";
import { threadMarkers } from "@/lib/agent/thread-markers";
import { markerText } from "@/app/app/[account]/leads/[leadId]/conversation";

const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

describe("readAgentSteps", () => {
  it("defaults: off in the workspace, on in the test lab", () => {
    expect(readAgentSteps("workspace", U, undefined)).toBe(false);
    expect(readAgentSteps("lab", U, undefined)).toBe(true);
  });

  it("uses this user's stored choice, per scope", () => {
    expect(readAgentSteps("workspace", U, stepsCookieValue(U, true))).toBe(true);
    expect(readAgentSteps("lab", U, stepsCookieValue(U, false))).toBe(false);
    // Separate cookie names: one choice never moves the other.
    expect(STEPS_COOKIE.workspace).not.toBe(STEPS_COOKIE.lab);
  });

  it("ignores another person's cookie on the same browser, and junk", () => {
    expect(readAgentSteps("workspace", U, stepsCookieValue(V, true))).toBe(false);
    expect(readAgentSteps("lab", U, stepsCookieValue(V, false))).toBe(true);
    expect(readAgentSteps("workspace", U, `${U}.yes`)).toBe(false);
    expect(readAgentSteps("workspace", U, "1")).toBe(false);
  });

  it("the URL parameter wins over the cookie and the default", () => {
    expect(readAgentSteps("workspace", U, stepsCookieValue(U, false), "1")).toBe(true);
    expect(readAgentSteps("lab", U, undefined, "0")).toBe(false);
    expect(readAgentSteps("lab", U, undefined, ["0", "1"])).toBe(false);
    expect(readAgentSteps("workspace", U, stepsCookieValue(U, true), "maybe")).toBe(true);
  });
});

describe("safeBack", () => {
  it("keeps a path in this account and drops the steps parameter", () => {
    expect(safeBack("acme", "/app/acme/conversations?c=1&steps=1&filter=human#thread")).toBe("/app/acme/conversations?c=1&filter=human#thread");
    expect(safeBack("acme", "/app/acme/leads/x#conversation")).toBe("/app/acme/leads/x#conversation");
    expect(safeBack("acme", "/app/acme/setup/test-lab?steps=0")).toBe("/app/acme/setup/test-lab");
  });

  it("sends anything else to the account home", () => {
    for (const bad of [null, "", "https://evil.test/app/acme/x", "//evil.test", "/app/other/leads", "/app/acmex/leads", "/app/acme\\@evil", "/app/acme/x\r\nSet-Cookie: a=b"]) {
      expect(safeBack("acme", bad)).toBe("/app/acme");
    }
  });
});

describe("threadMarkers", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 19, 9, m));
  const dana = { id: V, firstName: "Dana", lastName: "Levi", email: "dana@x.test" };
  const thread = [
    { message: { id: "m1", createdAt: at(1), actor: "buyer" }, calls: [] },
    { message: { id: "m2", createdAt: at(2), actor: "agent" }, calls: [{ name: "update_deal_state", outcome: "ok" }, { name: "hand_off_to_human", outcome: "ok" }] },
    { message: { id: "m3", createdAt: at(3), actor: "agent" }, calls: [{ name: "hand_off_to_human", outcome: "refused" }] },
  ];
  const events = [
    { type: "conversation.handed_back", createdAt: at(6), actorUserId: V, data: { conversationId: "c1" } },
    { type: "conversation.taken_over", createdAt: at(4), actorUserId: V, data: { conversationId: "c1" } },
    { type: "conversation.taken_over", createdAt: at(5), actorUserId: V, data: { conversationId: "other" } },
    { type: "conversation.taken_over", createdAt: at(7), actorUserId: null, data: { conversationId: "c1" } },
  ];

  it("hand-off from a successful hand_off_to_human call, after its reply; take-over and hand-back from this conversation's events, by time", () => {
    const m = threadMarkers("c1", thread, events, { [V]: dana });
    expect(m.map((x) => x.kind)).toEqual(["handoff", "taken_over", "handed_back", "taken_over"]);
    expect(m[0]).toMatchObject({ afterMessageId: "m2", at: at(2) });
    expect(m[1]).toMatchObject({ by: dana, at: at(4) });
    expect(m[3]).toMatchObject({ by: null });
  });

  it("names people by personName: you, their name, never a raw email", () => {
    const m = threadMarkers("c1", thread, events, { [V]: { ...dana, firstName: null, lastName: null } });
    expect(markerText(m[0], U)).toBe("The agent asked for a person");
    expect(markerText(m[1], U)).toContain("Chat taken over by");
    expect(markerText(m[1], U)).toContain("dana");
    expect(markerText(m[1], U)).not.toContain("@");
    expect(markerText(m[1], V)).toContain("you");
    expect(markerText(m[2], U)).toBe("Handed back to the agent");
    expect(markerText(m[3], U)).toBe("Chat taken over by a person");
  });
});
