/**
 * Settings › Voice › "Say the recording line" (app/app/[account]/settings/recording-line-switch.tsx): the amber
 * warning only while the switch is off, in a live region. The toggling itself is driven in Chromium by
 * tests/e2e/voice/recording-settings-shots.ts.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordingLineSwitch } from "@/app/app/[account]/settings/recording-line-switch";

const props = { label: "Say the recording line", hint: "On by default.", warning: "Turning this off records buyers without telling them, which many markets don't allow." };

describe("the recording line switch", () => {
  it("on: no warning, an empty live region, described by its hint only", () => {
    const html = renderToStaticMarkup(<RecordingLineSwitch defaultOn {...props} />);
    expect(html).toContain('<span role="status" aria-live="polite" id="voice-line-warn"></span>');
    expect(html).not.toContain("data-voice-line-warning");
    expect(html).toMatch(/checked=""/);
    expect(html).toContain('aria-describedby="voice-line-hint"');
  });

  it("off: the warning in the live region, and the switch described by it", () => {
    const html = renderToStaticMarkup(<RecordingLineSwitch defaultOn={false} {...props} />);
    expect(html).toMatch(/<span role="status" aria-live="polite" id="voice-line-warn"><span class="sas-alert sas-alert--warning st-voice__warn" data-voice-line-warning="">/);
    expect(html).toContain("which many markets don&#x27;t allow.");
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain('aria-describedby="voice-line-hint voice-line-warn"');
  });
});
