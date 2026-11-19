/**
 * Bidi isolation for names inside seller sentences (round-4 review F1). A
 * Hebrew name followed by " · 18 Nov" pulls the date into its right-to-left
 * run, so "Signed by נועה כהן · 18 Nov, 21:31" read "Signed by 18 · נועה כהן
 * Nov, 21:31". First-strong isolates (U+2068 … U+2069) keep the name one run in
 * its own direction; they are invisible. Use <bdi> in JSX; this is for text
 * that goes through t(). Pure; safe in client components.
 */
const FSI = "⁨";
const PDI = "⁩";

/** The text as one isolated bidi run (empty stays empty). */
export function isolate(text: string): string {
  return text ? `${FSI}${text}${PDI}` : text;
}

/** The text without isolate marks (tests, plain-text exports). */
export function stripIsolates(text: string): string {
  return text.replace(/[⁦-⁩]/g, "");
}
