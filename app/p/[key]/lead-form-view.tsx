/**
 * The presentational parts of the hosted lead form (/p/<key>), shared by the
 * real page and the seller's live preview (Lead pages › Add a page / Edit), so
 * the preview cannot drift from what the buyer gets. No state, no behaviour:
 * the real form (lead-form.tsx) adds the checks, the post and the beacon.
 */
import type { CSSProperties, ReactNode } from "react";

export type LeadFormStrings = {
  name: string; phone: string; company: string; email: string; send: string; sending: string;
  errName: string; errPhone: string; errGeneric: string; errBusy: string; privacy: string;
};

export type LeadFormFieldError = "name" | "phone";

/** The page around the form: the root with the language, direction and brand colour, the header and the body. */
export function HostedFormFrame({ lang, dir, style, header, children, preview = false }: {
  lang: string;
  dir: string;
  style: CSSProperties;
  /** The banner or the initials tile (LeadPageHeader). */
  header: ReactNode;
  children: ReactNode;
  /** The seller's preview: a plain box instead of the page's <main>. */
  preview?: boolean;
}) {
  const Box = preview ? "div" : "main";
  return (
    <div className="lp-root lp-root--form" lang={lang} dir={dir} style={style}>
      <Box className="lp-page">
        {header}
        <div className="lp-body">{children}</div>
      </Box>
    </div>
  );
}

/** The muted "About" line (when shown) and the form's title. */
export function LeadFormHead({ about, title, preview = false }: { about: string | null; title: string; preview?: boolean }) {
  const Title = preview ? "p" : "h1";
  return (
    <>
      {about ? <p className="lp-about" data-lp-about="">{about}</p> : null}
      <Title className="lp-title">{title}</Title>
    </>
  );
}

/** What is inside the form: the alert, the fields, the honeypot, the hidden inputs, the consent line and Send. */
export function LeadFormFields({ strings, fields, consentTicked, consentLine, privacyHref, hidden, errors, alert, sending }: {
  strings: LeadFormStrings;
  fields: { company: boolean; email: boolean };
  consentTicked: boolean;
  consentLine: string;
  privacyHref: string | null;
  hidden: Record<string, string>;
  errors: readonly LeadFormFieldError[];
  alert: string | null;
  sending: boolean;
}) {
  const err = (f: LeadFormFieldError) => errors.includes(f);
  return (
    <>
      {alert ? <p className="lp-alert" role="alert">{alert}</p> : null}
      <label className="lp-field">
        {strings.name}
        <input className="lp-input" name="name" autoComplete="name" required minLength={2} maxLength={120} dir="auto"
          aria-invalid={err("name") || undefined} aria-describedby={err("name") ? "lp-err-name" : undefined} />
        {err("name") ? <span className="lp-err" id="lp-err-name">{strings.errName}</span> : null}
      </label>
      <label className="lp-field">
        {strings.phone}
        <input className="lp-input" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} dir="ltr"
          aria-invalid={err("phone") || undefined} aria-describedby={err("phone") ? "lp-err-phone" : undefined} />
        {err("phone") ? <span className="lp-err" id="lp-err-phone">{strings.errPhone}</span> : null}
      </label>
      {fields.company ? (
        <label className="lp-field">{strings.company}<input className="lp-input" name="company" autoComplete="organization" maxLength={120} dir="auto" /></label>
      ) : null}
      {fields.email ? (
        <label className="lp-field">{strings.email}<input className="lp-input" name="email" type="email" autoComplete="email" maxLength={200} dir="ltr" /></label>
      ) : null}
      {/* Bots fill this in; people never see it. */}
      <div className="lp-hp" aria-hidden="true">
        <label>Website<input name="sas_url" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
      </div>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label className="lp-check">
        <input type="checkbox" name="consent" value="on" defaultChecked={consentTicked} data-consent="" />
        <span>
          {consentLine}
          {privacyHref ? <> <a className="lp-link" href={privacyHref} target="_blank" rel="noopener">{strings.privacy}</a></> : null}
        </span>
      </label>
      <button type="submit" className="lp-btn lp-btn--primary" disabled={sending} aria-busy={sending || undefined}>{sending ? strings.sending : strings.send}</button>
    </>
  );
}
