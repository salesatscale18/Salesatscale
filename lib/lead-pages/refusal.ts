/**
 * A refused no-JavaScript post (slice c, the seller's own form; also our hosted form and the
 * snippet's fallback): which `?sas_error=` code it goes back with, the buyer sentence for each
 * code, and the small styled page shown when it cannot go back (no redirect to an unlisted origin).
 *
 * One source of truth: the endpoint returns only codes from OWN_FORM_ERRORS (ownFormErrorCode),
 * and the seller's setup panel lists exactly those codes with OWN_FORM_ERROR_TEXT.
 */
import { t, dir, type Locale, type MessageKey } from "@/lib/i18n";
import type { SubmitResult } from "./intake";
import type { OwnFormError } from "./rules";

/** The approved buyer sentence for each code (in the page's form language when shown). */
export const OWN_FORM_ERROR_TEXT = {
  name: "buyer.lp.form.err_name",
  phone: "buyer.lp.form.err_phone",
  busy: "buyer.lp.form.err_busy",
  closed: "buyer.lp.form.closed",
  generic: "buyer.lp.form.err_generic",
} as const satisfies Record<OwnFormError, MessageKey>;

/** The code for a result that is not a hand-over (a no-JS post goes back to the form with it). */
export function ownFormErrorCode(r: SubmitResult): OwnFormError {
  if (r.kind === "invalid") return r.errors[0] ?? "generic";
  if (r.kind === "busy") return "busy";
  if (r.kind === "refused" && r.reason === "closed") return "closed";
  return "generic";
}

/**
 * The sentence when a refused post cannot go back to the form's page: busy and closed say so;
 * anything else (a refused address, a missing field the buyer cannot fix here) the generic one.
 */
export function refusalSentenceKey(code: OwnFormError): MessageKey {
  return code === "busy" || code === "closed" ? OWN_FORM_ERROR_TEXT[code] : OWN_FORM_ERROR_TEXT.generic;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Inline only: no scripts, no external assets, no form posts, no framing. */
export const REFUSAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * A minimal self-contained page with one approved buyer sentence. It never carries anything
 * from the request (no field, header, address or key): only the sentence for `key` in `locale`.
 */
export function refusalPageHtml(locale: Locale, key: MessageKey): string {
  const sentence = esc(t(key, undefined, locale));
  return `<!doctype html>
<html lang="${locale}" dir="${dir(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${sentence}</title>
<style>
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#f6f7f9;color:#1d2433;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{width:100%;max-width:420px;padding:24px;border:1px solid #e3e6eb;border-radius:12px;background:#fff;text-align:center}
p{margin:0;font-size:17px;line-height:1.5;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e8eaee}main{background:#1d2128;border-color:#2c313a}}
</style>
</head>
<body>
<main><p>${sentence}</p></main>
</body>
</html>
`;
}
