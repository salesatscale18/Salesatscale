"use client";

import { useRef, useState } from "react";
import { DateField } from "@/components/sas/date-field";
import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { dateFieldFormat, formatIsoDate } from "@/lib/format";

/**
 * A market's holidays inside the "Change for this market" form: a date field
 * with "Add date", and the chosen dates below (sorted, each with Remove). The
 * form gets every date as a "holidays" value ("YYYY-MM-DD"), so the server
 * action is unchanged; a date typed but not added is sent too. Removing every
 * date and saving clears the market's holidays.
 */
export function HolidaysField({ initial, labels }: {
  /** "YYYY-MM-DD" dates. */
  initial: string[];
  labels: { field: string; add: string; remove: string; empty: string; invalid: string };
}) {
  const [dates, setDates] = useState(() => [...new Set(initial)].sort());
  const [fieldKey, setFieldKey] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  const add = () => {
    const hidden = box.current?.querySelector<HTMLInputElement>('input[type="hidden"]');
    const text = box.current?.querySelector<HTMLInputElement>('input[type="text"]')?.value.trim() ?? "";
    const iso = hidden?.value ?? "";
    if (!iso) {
      setInvalid(text.length > 0);
      return;
    }
    setDates((d) => [...new Set([...d, iso])].sort());
    setInvalid(false);
    setFieldKey((k) => k + 1);
  };

  return (
    <div className="sas-stack-2" data-holidays-field="">
      <span ref={box} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}>
        <DateField key={fieldKey} name="holidays" aria-label={labels.field} style={{ width: 150 }} aria-describedby={invalid ? "hol-invalid" : undefined} />
        <Button type="button" variant="secondary" size="sm" icon="plus" onClick={add}>{labels.add}</Button>
      </span>
      {invalid ? <span className="sas-error" id="hol-invalid" role="alert">{labels.invalid.replace("{format}", dateFieldFormat().placeholder)}</span> : null}
      {dates.length === 0 ? <span className="sas-small">{labels.empty}</span> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 8 }} data-holiday-list="">
          {dates.map((d) => (
            <li key={d} className="mk-holiday" data-holiday={d}>
              <input type="hidden" name="holidays" value={d} />
              <span className="sas-num">{formatIsoDate(d)}</span>
              <button type="button" className="mk-holiday__remove" aria-label={labels.remove.replace("{date}", formatIsoDate(d))}
                onClick={() => setDates((all) => all.filter((x) => x !== d))}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
