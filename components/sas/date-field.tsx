"use client";

import { useState, type InputHTMLAttributes } from "react";
import { dateFieldFormat, dateFieldToIso, isoToDateField } from "@/lib/format";

/**
 * A date field in the account locale's order ("18/11/2026"; Hebrew
 * "18.11.2026"). A native date input follows the browser's locale, so an
 * Israeli account could see mm/dd/yyyy; this is a text field with the
 * locale's pattern. The form still gets "YYYY-MM-DD" under `name` (a hidden
 * input), so server actions are unchanged.
 */
export function DateField({ name, defaultValue, language, id, ...rest }: {
  name: string;
  /** "YYYY-MM-DD" or empty. */
  defaultValue?: string | null;
  /** The account's language: decides the day/month/year order. */
  language?: string | null;
  id?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "defaultValue" | "value" | "type" | "onChange">) {
  const { placeholder } = dateFieldFormat(language);
  const [text, setText] = useState(() => isoToDateField(defaultValue, language));
  const iso = text.trim() ? dateFieldToIso(text, language) : "";
  return (
    <>
      <input
        {...rest} id={id} className={rest.className ?? "sas-input sas-num"} type="text" inputMode="numeric" autoComplete="off"
        value={text} placeholder={placeholder} title={placeholder} data-date-field={name}
        pattern={"\\d{1,2}[.\\/\\-]\\d{1,2}[.\\/\\-](\\d{2}|\\d{4})"}
        aria-invalid={iso === null ? true : rest["aria-invalid"]}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (iso) setText(isoToDateField(iso, language)); }}
      />
      <input type="hidden" name={name} value={iso ?? ""} />
    </>
  );
}
