/**
 * Client-safe CSV helpers (no Node imports, so the import form can use them).
 * Re-exported from ./rules.
 */

/** Characters that make a spreadsheet treat a cell as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Escapes one CSV cell. Text that starts like a formula gets a leading single
 * quote, so Excel or Sheets shows it as text instead of running it.
 */
export function csvEscape(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
