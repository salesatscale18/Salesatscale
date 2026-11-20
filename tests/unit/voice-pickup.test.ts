/** UX fixes: the pick-up re-ask is said once per open question; a short call with nothing from the buyer is one row. */
import { describe, expect, it } from "vitest";
import { pickUpReAsk, type PickUpMessage } from "@/lib/voice/instructions";
import { EMPTY_CALL_MAX_SEC, isEmptyShortCall, voiceMarkers } from "@/lib/agent/thread-markers";

const chat = (actor: string, body: string): PickUpMessage => ({ actor, body, voiceSessionId: null });
const said = (actor: string, body: string, call = "call-1"): PickUpMessage => ({ actor, body, voiceSessionId: call });
/** Oldest first in the test, newest first for the function (as loaded). */
const pick = (oldestFirst: PickUpMessage[]) => pickUpReAsk([...oldestFirst].reverse());

describe("re-ask once", () => {
  const opener = chat("agent", "Hi Dana, this is Maya from Acme. What made you get in touch today?");

  it("the first call re-asks the agent's open question", () => {
    expect(pick([opener])).toBe("So, what made you get in touch today?");
  });

  it("a second call with still no answer opens with the fallback", () => {
    expect(pick([opener, said("agent", "So, what made you get in touch today?")])).toBeNull();
    // The model's re-ask in other words around the same question still counts.
    expect(pick([opener, said("agent", "So — what made you get in touch today?")])).toBeNull();
    // A call that ended before it said anything did not re-ask: the next one does.
    expect(pick([opener, chat("system", "Voice call ended · 0:03")])).toBe("So, what made you get in touch today?");
  });

  it("after the buyer answered and the agent asked something new, the new question is re-asked once", () => {
    const thread = [opener, said("agent", "So, what made you get in touch today?"), chat("buyer", "We need sensors for 3 kitchens."), chat("agent", "Got it. How many fridges per kitchen?")];
    expect(pick(thread)).toBe("So, how many fridges per kitchen?");
    expect(pick([...thread, said("agent", "So, how many fridges per kitchen?", "call-2")])).toBeNull();
    // The buyer spoke last: the fallback.
    expect(pick([...thread, said("buyer", "About ten.", "call-2")])).toBeNull();
  });

  it("Hebrew: re-asked once too (the Hebrew fallback follows)", () => {
    const he = chat("agent", "היי דנה, כאן מאיה. מה גרם לך לפנות אלינו היום?");
    expect(pick([he])).toBe("אז, מה גרם לך לפנות אלינו היום?");
    expect(pick([he, said("agent", "אז, מה גרם לך לפנות אלינו היום?")])).toBeNull();
  });
});

describe("a short call with nothing from the buyer is one row", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 11, 13, s));
  it(`under ${EMPTY_CALL_MAX_SEC} s and no buyer line: only the summary; otherwise the start and the summary`, () => {
    expect(isEmptyShortCall(4, 0)).toBe(true);
    expect(isEmptyShortCall(4, 1)).toBe(false);
    expect(isEmptyShortCall(15, 0)).toBe(false);
    expect(voiceMarkers([{ connectedAt: at(0), endedAt: at(4), status: "ended", durationSec: 4, buyerTurns: 0 }]).map((m) => m.kind)).toEqual(["voice_ended"]);
    expect(voiceMarkers([{ connectedAt: at(0), endedAt: at(4), status: "ended", durationSec: 4, buyerTurns: 1 }]).map((m) => m.kind)).toEqual(["voice_started", "voice_ended"]);
    expect(voiceMarkers([{ connectedAt: at(0), endedAt: at(40), status: "ended", durationSec: 40, buyerTurns: 0 }]).map((m) => m.kind)).toEqual(["voice_started", "voice_ended"]);
    // Still running: its start only.
    expect(voiceMarkers([{ connectedAt: at(0), endedAt: null, status: "live", durationSec: null, buyerTurns: 0 }]).map((m) => m.kind)).toEqual(["voice_started"]);
  });
});
