/** Transcription markers and segment joins (lib/voice/transcript-clean.ts), with the owner's live call (Gemini 3.8 Live). */
import { describe, expect, it } from "vitest";
import { cleanTranscript, isMarkerOnly, joinTranscript } from "@/lib/voice/transcript-clean";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";

describe("markers are no text", () => {
  it("the live call's agent lines: the marker at the end with no space, and alone", () => {
    expect(cleanTranscript("Yes, of course. To help you protect your fridges, how do you check your temperatures today?<no speech detected>"))
      .toBe("Yes, of course. To help you protect your fridges, how do you check your temperatures today?");
    expect(cleanTranscript("Got it, doing it manually. How many sites (kitchens or branches) would you like to monitor?<no speech detected>"))
      .toBe("Got it, doing it manually. How many sites (kitchens or branches) would you like to monitor?");
    expect(cleanTranscript("<no speech detected>…")).toBe("");
    expect(cleanTranscript("<no speech detected>")).toBe("");
  });

  it("many marker forms, alone, repeated, in the middle; any case and spacing", () => {
    for (const m of ["<noise>", "<silence>", "[no speech]", "(no audio)", "< No Speech Detected >", "[ inaudible ]", "(unintelligible)", "{silence}", "[BLANK_AUDIO]", "<background noise>", "[music]", "<no speech detected> <noise>", "  <silence>.  "]) {
      expect(cleanTranscript(m), m).toBe("");
      expect(isMarkerOnly(m), m).toBe(true);
    }
    expect(cleanTranscript("Yes <noise> please")).toBe("Yes please");
    expect(cleanTranscript("[inaudible] I'd like the hub.")).toBe("I'd like the hub.");
    expect(cleanTranscript("Three sites<no speech detected>, maybe four.")).toBe("Three sites, maybe four.");
  });

  it("ordinary text with brackets or < stays exactly as it is", () => {
    for (const t of [
      "Under <5 km from the shop.", "How many sites (kitchens or branches) would you like to monitor?", "We need it for (two hubs).",
      "Prices are [optional] extras.", "a<b and c>d", "Use <the hub> for that", "(Noise levels are fine.)", "הצעת מחיר Q-1005 (כולל מע״מ)", "",
    ]) expect(cleanTranscript(t), t).toBe(t);
    expect(isMarkerOnly("Hello")).toBe(false);
    expect(isMarkerOnly("")).toBe(false);
  });
});

describe("segments of one turn are joined with a space", () => {
  it("after sentence punctuation or a tool call; never inside a word", () => {
    expect(joinTranscript("One moment, I'm checking that.", "Understood, you check")).toBe("One moment, I'm checking that. Understood, you check");
    expect(joinTranscript("…rely purely on manual checks?", "The total today including VAT is")).toBe("…rely purely on manual checks? The total today including VAT is");
    expect(joinTranscript("I'm chec", "king that")).toBe("I'm checking that");
    expect(joinTranscript("Let me look", "Okay", true)).toBe("Let me look Okay");
    expect(joinTranscript("Hello ", "there")).toBe("Hello there");
    expect(joinTranscript("Hello.", " there")).toBe("Hello. there");
    expect(joinTranscript("Price is 10.", "5 shekels")).toBe("Price is 10. 5 shekels");
    expect(joinTranscript("", "Hi")).toBe("Hi");
  });

  it("the Gateway mapper: joined segments, no marker in any agent or buyer event", () => {
    const m = new ServerEventMapper();
    const evs = [
      ...m.map({ type: "response-created" } as never),
      ...m.map({ type: "audio-transcript-delta", delta: "One moment, I'm checking that." } as never),
      ...m.map({ type: "function-call-arguments-done", callId: "c1", name: "search_catalog", arguments: "{}" } as never),
      ...m.map({ type: "audio-transcript-delta", delta: "Understood, you check by hand?" } as never),
      ...m.map({ type: "audio-transcript-delta", delta: "<no speech detected>" } as never),
      ...m.map({ type: "response-done", status: "completed" } as never),
      // A whole turn that is only the marker (the live call's standalone lines): nothing at all.
      ...m.map({ type: "response-created" } as never),
      ...m.map({ type: "audio-transcript-delta", delta: "<no speech detected>…" } as never),
      ...m.map({ type: "response-done", status: "completed" } as never),
      // The buyer: a marker-only transcription is no turn.
      ...m.map({ type: "transcript-fragment", speaker: "user", delta: "<no speech detected>" } as never),
      ...m.map({ type: "input-transcription-completed", transcript: "<no speech detected>" } as never),
    ];
    const texts = evs.filter((e) => e.type === "agent-transcript" || e.type === "buyer-transcript").map((e) => `${e.type}:${(e as { text: string }).text}`);
    expect(texts.join("\n")).not.toMatch(/no speech/);
    expect(texts.filter((t) => t.startsWith("buyer"))).toEqual([]);
    expect(evs.filter((e) => e.type === "agent-transcript" && (e as { final: boolean }).final).map((e) => (e as { text: string }).text))
      .toEqual(["One moment, I'm checking that. Understood, you check by hand?"]);
  });
});
