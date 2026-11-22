/**
 * RB3: the booking card shows right under the agent's line that offered it
 * (the card is stored while the turn runs, the line when it ends), and the
 * buyer page's poll cursor is the newest message, not the last one shown.
 */
import { describe, expect, it } from "vitest";
import { cursorOf, placeBookingCards } from "@/lib/chat/booking-order";

type M = { id: string; from: string; card?: boolean; offers?: boolean };
const place = (ms: M[]) => placeBookingCards(ms, (m) => ({ id: m.id, actor: m.from, isCard: !!m.card, offersCard: !!m.offers })).map((m) => m.id);

describe("placeBookingCards", () => {
  it("moves the card right under its turn's line", () => {
    expect(place([
      { id: "b1", from: "buyer" }, { id: "card", from: "agent", card: true }, { id: "line", from: "agent", offers: true }, { id: "b2", from: "buyer" },
    ])).toEqual(["b1", "line", "card", "b2"]);
  });

  it("skips other agent messages of the same turn (a quote message) to find the line", () => {
    expect(place([{ id: "card", from: "agent", card: true }, { id: "q", from: "agent" }, { id: "line", from: "agent", offers: true }]))
      .toEqual(["q", "line", "card"]);
  });

  it("leaves a card whose line is not there yet, or belongs to another turn", () => {
    expect(place([{ id: "b1", from: "buyer" }, { id: "card", from: "agent", card: true }])).toEqual(["b1", "card"]);
    expect(place([{ id: "card", from: "agent", card: true }, { id: "b", from: "buyer" }, { id: "line", from: "agent", offers: true }]))
      .toEqual(["card", "b", "line"]);
    expect(place([{ id: "card", from: "agent", card: true }, { id: "h", from: "human" }, { id: "line", from: "agent", offers: true }]))
      .toEqual(["card", "h", "line"]);
  });

  it("handles two cards (a newer card replaces the older) and is idempotent", () => {
    const ms: M[] = [
      { id: "c1", from: "agent", card: true }, { id: "l1", from: "agent", offers: true }, { id: "b", from: "buyer" },
      { id: "c2", from: "agent", card: true }, { id: "l2", from: "agent", offers: true },
    ];
    const once = place(ms);
    expect(once).toEqual(["l1", "c1", "b", "l2", "c2"]);
    const byId = new Map(ms.map((m) => [m.id, m]));
    expect(place(once.map((id) => byId.get(id)!))).toEqual(once);
  });
});

describe("cursorOf", () => {
  it("is the newest message by time, then id, wherever it is shown", () => {
    expect(cursorOf([])).toBeNull();
    expect(cursorOf([
      { id: "line", at: "2026-11-22T10:00:01.000Z" }, { id: "card", at: "2026-11-22T10:00:00.000Z" },
    ])).toBe("line");
    expect(cursorOf([{ id: "b", at: "2026-11-22T10:00:00.000Z" }, { id: "a", at: "2026-11-22T10:00:00.000Z" }])).toBe("b");
  });
});
