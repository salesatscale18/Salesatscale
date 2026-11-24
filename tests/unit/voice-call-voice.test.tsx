/** The test lab's "This call" card: the voice and fillers a call ran with (from its session snapshot), and older calls. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { callVoiceInfo, sentCallVoice, VOICE_MODELS } from "@/lib/voice/settings";
import { callFillersText, callVoiceText, VoiceCallStats } from "@/components/sas/voice/voice-call-stats";

const gemini = VOICE_MODELS.find((m) => m.family === "gemini")!.id;
const openai = VOICE_MODELS.find((m) => m.family === "openai")!.id;

describe("the voice a call ran with", () => {
  it("reads the session snapshot: a preset, the model default, or not recorded (older calls)", () => {
    expect(callVoiceInfo({ voice: "Kore", fillers: false, engine: "guarded" })).toEqual({ voice: "Kore", fillers: false });
    expect(callVoiceInfo({ voice: "model default", fillers: true })).toEqual({ voice: "default", fillers: true });
    expect(callVoiceInfo({ engine: "guarded" })).toEqual({ voice: null, fillers: null });
    expect(callVoiceInfo(null)).toEqual({ voice: null, fillers: null });
  });

  it("the voice a call starts with: the version's, else none on Gemini, else the OpenAI family default", () => {
    expect(sentCallVoice("Kore", gemini)).toBe("Kore");
    expect(sentCallVoice(null, gemini)).toBeNull();
    expect(sentCallVoice(null, openai)).toBe("alloy");
  });

  it("the card shows Voice and Fillers next to the model and engine", () => {
    expect(callVoiceText("Kore")).toBe("Kore");
    expect(callVoiceText("default")).toBe("Model default");
    expect(callVoiceText(null)).toBe("Not recorded");
    expect(callFillersText(true)).toBe("On (short filler phrases)");
    expect(callFillersText(false)).toBe("Off");
    expect(callFillersText(null)).toBe("Not recorded");
    const card = (voiceUsed: Parameters<typeof VoiceCallStats>[0]["voiceUsed"]) => renderToStaticMarkup(
      <VoiceCallStats durationSec={60} maxSec={600} costMicros={0} scripted fx={null} answerMsAvg={null} live={false} model="Model X" engine="Current" voiceUsed={voiceUsed} />,
    );
    const html = card({ voice: "default", fillers: true });
    expect(html).toContain("<dt>Voice</dt><dd data-voice-used=\"\">Model default</dd>");
    expect(html).toContain("<dt>Fillers</dt><dd data-voice-fillers=\"\">On (short filler phrases)</dd>");
    expect(html.indexOf("data-voice-model")).toBeLessThan(html.indexOf("data-voice-used"));
    expect(card({ voice: null, fillers: null })).toContain("<dd data-voice-used=\"\">Not recorded</dd>");
    expect(card(null)).not.toContain("data-voice-used");
  });
});
