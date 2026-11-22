/** Tool results as a call reads them: wording a spoken agent must not get wrong. */
import { describe, expect, it } from "vitest";
import { voiceToolResultMessage } from "@/lib/agent/core/voice";

describe("tool result wording on a call", () => {
  it("schedule_follow_up: they get a text with a link back to the chat; never \"I'll message you\"", () => {
    const chat = "Scheduled. Confirm the time back to the buyer in their own wording and language (for example \"tomorrow at 10\"), in one short sentence. At that time they get a text message with a link back to this chat, where they can talk to you by voice or write.";
    const voice = voiceToolResultMessage(chat);
    expect(voice).toContain("Say that at that time they get a text with a link back to this chat");
    expect(voice).toContain("Never say you will message or call them yourself.");
    // Applying it twice changes nothing.
    expect(voiceToolResultMessage(voice)).toBe(voice);
  });
});
