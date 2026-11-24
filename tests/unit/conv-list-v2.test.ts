/** ConvListV2: the list row's second line and the sort parameter (pure helpers). */
import { describe, expect, it } from "vitest";
import { callLength, listLineText, listPreview, needsYouLine, startsRtl, voiceCallPreview } from "@/lib/conversations/preview";
import { handoffShort } from "@/lib/leads/handoff-reason";
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
    // conv-list-fixes: a call with no stored length reads "Voice call", never "· 0 s".
    expect(voiceCallPreview(voiceCallEndedLine(0))).toBe("Voice call");
  });

  it("a right-to-left message is cut at a word so its start shows; left-to-right text is left to CSS", () => {
    expect(startsRtl("היי רונית")).toBe(true);
    expect(startsRtl("12 חיישנים")).toBe(true);
    expect(startsRtl("Hi רונית")).toBe(false);
    expect(listLineText("היי רונית, כאן הצוות של פולאר דמו")).toBe("היי רונית, כאן הצוות של פולאר");
    expect(listLineText("שלום")).toBe("שלום");
    const en = "Still open, Avi. Is anything holding up the payment today?";
    expect(listLineText(en)).toBe(en);
    expect(listLineText("א".repeat(50))).toBe("א".repeat(30));
  });

  it("the short hand-off label for every kind; none for a free reason", () => {
    const req = (reason: string) => ({ type: "handoff.requested", data: { reason } });
    expect(handoffShort({ type: "handoff.spend_cap", data: {} })).toBe("AI limit reached");
    expect(handoffShort(req("The platform's monthly AI budget is used up"))).toBe("AI limit reached");
    expect(handoffShort(req("The buyer is upset: false night alarms"))).toBe("Upset");
    expect(handoffShort(req("Wants to complain about the installer"))).toBe("Complaint");
    expect(handoffShort(req("Their lawyer wants the contract"))).toBe("Legal");
    expect(handoffShort(req("An existing customer with a second site"))).toBe("Existing customer");
    expect(handoffShort(req("The buyer insists on a human"))).toBe("Insists on a person");
    expect(handoffShort(req("The buyer asked to talk to a person about delivery"))).toBe("Buyer asked for a person");
    expect(handoffShort({ type: "handoff.requested", data: { reason: "x", objections: [{ play: "handoff", status: "open" }] } })).toBe("Upset");
    expect(handoffShort(req("Needs a custom installation plan for 40 sites"))).toBeNull();
    expect(handoffShort(req("צריך תוכנית התקנה מיוחדת"))).toBeNull();
    expect(needsYouLine(false, handoffShort(req("Needs a plan")))).toBe("Hand-off requested");
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
