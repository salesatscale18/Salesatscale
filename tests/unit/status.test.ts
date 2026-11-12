import { describe, expect, it } from "vitest";
import { STATUS } from "@/lib/domain/status";
import { t, type MessageKey } from "@/lib/i18n";

/**
 * Copied from the design system README, "Status language" table.
 * Tone in brackets there; one pill per object.
 */
const DESIGN_SYSTEM: Record<string, [string, string][]> = {
  lead: [["New", "neutral"], ["Waiting for reply", "neutral"], ["Agent handling", "agent"], ["Human handling", "human"], ["Meeting booked", "success"], ["Won", "success"], ["Lost", "neutral"], ["Opted out", "danger"]],
  quote: [["Draft", "neutral"], ["Awaiting approval", "warning"], ["Sent", "neutral"], ["Expires today", "warning"], ["Expired", "neutral"], ["Replaced", "neutral"]],
  order_form: [["Sent", "neutral"], ["Opened", "neutral"], ["Signed", "success"], ["Link expired", "neutral"]],
  payment: [["Not started", "neutral"], ["Pending", "warning"], ["Paid", "success"], ["Failed", "danger"], ["Refunded", "neutral"], ["Bank transfer expected", "warning"]],
  agent_version: [["Draft", "neutral"], ["Testing", "warning"], ["Live", "success"], ["Retired", "neutral"]],
  account: [["Setting up", "warning"], ["Live", "success"], ["Paused", "neutral"]],
  tool_call: [["Refused", "warning"], ["Failed", "danger"]],
  intake_result: [["Created", "success"], ["Updated", "neutral"], ["Rejected", "danger"]],
  channel: [["Connected", "success"], ["Template pending", "warning"], ["Template rejected", "danger"], ["Disconnected", "danger"]],
};

describe("status language", () => {
  it("covers exactly the design system's objects", () => {
    expect(Object.keys(STATUS).sort()).toEqual(Object.keys(DESIGN_SYSTEM).sort());
  });

  for (const [object, expected] of Object.entries(DESIGN_SYSTEM)) {
    it(`${object}: words and tones match the design system, in order`, () => {
      const states = Object.entries(STATUS[object as keyof typeof STATUS]);
      const actual = states.map(([state, def]) => [t(`status.${object}.${state}` as MessageKey), def.tone]);
      expect(actual).toEqual(expected);
    });
  }
});
