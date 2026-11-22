"use client";

/**
 * Settings › Voice › Call recordings: the "Say the recording line" switch. The amber warning shows only while the
 * switch is off, as it is toggled (before saving), in a live region so a screen reader announces it when it
 * appears. Texts arrive translated from the server.
 */
import { useState } from "react";
import { Icon } from "@/components/sas/icon";

export function RecordingLineSwitch({ defaultOn, label, hint, warning }: { defaultOn: boolean; label: string; hint: string; warning: string }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="st-voice__row" style={{ alignItems: "flex-start" }}>
      <span className="sas-stack-2" style={{ gap: 6 }}>
        <label htmlFor="voice-rec-line"><b>{label}</b></label>
        <span className="sas-small" id="voice-line-hint">{hint}</span>
        {/* The live region is always there; its content appears only while the switch is off. */}
        <span role="status" aria-live="polite" id="voice-line-warn">
          {on ? null : (
            <span className="sas-alert sas-alert--warning st-voice__warn" data-voice-line-warning=""><Icon name="alert-triangle" /><span>{warning}</span></span>
          )}
        </span>
      </span>
      <input
        type="checkbox" role="switch" className="sas-switch" id="voice-rec-line" name="recordingNotice" checked={on}
        onChange={(e) => setOn(e.currentTarget.checked)} aria-describedby={on ? "voice-line-hint" : "voice-line-hint voice-line-warn"} data-voice-recording-notice=""
      />
    </div>
  );
}
