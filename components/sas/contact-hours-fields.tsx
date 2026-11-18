"use client";

import { useState } from "react";
import { WEEKDAYS } from "@/lib/accounts/contact-hours";
import { normalizeClock } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import type { ContactHours } from "@/db/schema";

/**
 * A 24-hour clock field ("08:30"), the same in every browser: a native time
 * input follows the browser's locale (08:00 PM) rather than the account's.
 * A day that is off shows its times disabled; their values still go with the
 * form (hidden inputs), as parseContactHours reads every day.
 */
function ClockField({ name, label, value, disabled }: { name: string; label: string; value: string; disabled: boolean }) {
  const [text, setText] = useState(value);
  const clean = normalizeClock(text);
  return (
    <label className="sas-small" style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: disabled ? 0.55 : undefined }}>
      {label}
      <input
        className="sas-input sas-num" type="text" inputMode="numeric" autoComplete="off" maxLength={5}
        name={disabled ? undefined : name} value={text} disabled={disabled} required={!disabled}
        pattern="([01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:MM" title="HH:MM (24-hour)"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (clean) setText(clean); }}
        style={{ width: 72 }} data-clock={name}
      />
      {disabled ? <input type="hidden" name={name} value={clean ?? value} /> : null}
    </label>
  );
}

/** The seven day rows of a contact hours form (Settings › Contact hours, Markets). */
export function ContactHoursFields({ hours }: { hours: ContactHours }) {
  const [on, setOn] = useState(() => hours.map((h) => h.on));
  return (
    <div className="sas-stack-2">
      {WEEKDAYS.map((d, i) => (
        <fieldset key={d} data-day={d} data-off={on[i] ? undefined : ""} style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
          <legend className="sas-sr">{t(`settings.hours.day.${d}` as MessageKey)}</legend>
          <label className="sas-check" style={{ width: 120 }}>
            <input type="checkbox" name={`${d}_on`} checked={on[i]} onChange={(e) => setOn((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))} />
            {t(`settings.hours.day.${d}` as MessageKey)}
          </label>
          {/* From and To wrap together, so a narrow screen shows the day, then its times on one line. */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12, whiteSpace: "nowrap" }}>
            <ClockField name={`${d}_from`} label={t("settings.hours.from")} value={hours[i].from} disabled={!on[i]} />
            <ClockField name={`${d}_to`} label={t("settings.hours.to")} value={hours[i].to} disabled={!on[i]} />
          </span>
        </fieldset>
      ))}
    </div>
  );
}
