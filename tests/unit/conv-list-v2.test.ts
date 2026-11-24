/** ConvListV2: the list row's second line and the sort parameter (pure helpers). */
import { describe, expect, it } from "vitest";
import { callLength, listPreview, needsYouLine, voiceCallPreview } from "@/lib/conversations/preview";
import { voiceCallEndedLine } from "@/lib/agent/thread-markers";
import { INBOX_SORTS, parseInboxSort } from "@/lib/conversations/inbox";

describe("ConvListV2 row line 2", () => {
  it("a call's length in minutes and seconds", () => {
    expect(callLength(252)).toBe("4 min 12 s");
    expect(callLength(240)).toBe("4 min");
    expect(callLength(38)).toBe("38 s");
    expect(callLength(0)).toBe("0 s");
  });

  it("the stored call-ended line reads Voice call · length; other text is not a call", () => {
    expect(voiceCallPreview(voiceCallEndedLine(252))).toBe("Voice call · 4 min 12 s");
    expect(voiceCallPreview(voiceCallEndedLine(38))).toBe("Voice call · 38 s");
    expect(voiceCallPreview("Voice call ended soon")).toBeNull();
  });

  it("the speaker comes first; a system line never says System:", () => {
    expect(listPreview({ lastBody: "Hi", lastActor: "buyer", lastUserId: null }, "me")).toEqual({ who: "Buyer", text: "Hi" });
    expect(listPreview({ lastBody: "Hi", lastActor: "agent", lastUserId: null }, "me")).toEqual({ who: "Agent", text: "Hi" });
    expect(listPreview({ lastBody: "Hi", lastActor: "human", lastUserId: "me" }, "me")).toEqual({ who: "You", text: "Hi" });
    expect(listPreview({ lastBody: "Hi", lastActor: "human", lastUserId: "other" }, "me")).toEqual({ who: "Team", text: "Hi" });
    expect(listPreview({ lastBody: voiceCallEndedLine(252), lastActor: "system", lastUserId: null }, "me")).toEqual({ who: null, text: "Voice call · 4 min 12 s" });
    const sys = listPreview({ lastBody: "The agent could not reply (model error). Try again.", lastActor: "system", lastUserId: null }, "me");
    expect(sys.who).toBeNull();
    expect(sys.text).toBe("The agent could not reply (model error). Try again.");
    expect(listPreview({ lastBody: null, lastActor: null, lastUserId: null }, "me")).toEqual({ who: null, text: "No messages yet" });
  });

  it("Needs you: what waits, then why", () => {
    expect(needsYouLine(false, "AI limit reached")).toBe("Hand-off requested · AI limit reached");
    expect(needsYouLine(true, "Upset: false alarms")).toBe("Buyer waiting · Upset: false alarms");
    expect(needsYouLine(false, undefined)).toBe("Hand-off requested");
  });

  it("sort: newest first by default, oldest first on request; nothing else", () => {
    expect(INBOX_SORTS).toEqual(["newest", "oldest"]);
    expect(parseInboxSort(undefined)).toBe("newest");
    expect(parseInboxSort("oldest")).toBe("oldest");
    expect(parseInboxSort("waiting")).toBe("newest");
  });
});
