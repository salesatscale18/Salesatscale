"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export type LeadFormStrings = {
  name: string; phone: string; company: string; email: string; sites: string; send: string; sending: string;
  errName: string; errPhone: string; errGeneric: string; errBusy: string; privacy: string;
};

type FieldError = "name" | "phone";

/**
 * The hosted lead form. A plain HTML form that works without JavaScript
 * (urlencoded POST, 303 to the hand-over); with JavaScript it checks the two
 * required fields, posts JSON, shows "Sending…" and goes to the hand-over.
 * It also sends the page's one "view" beacon (no cookie, no identifier; never
 * for a preview). Nothing personal ever goes in a URL.
 */
export function LeadForm({ action, beacon, strings, fields, consentTicked, consentLine, privacyHref, hidden, initialError, dir }: {
  action: string;
  /** The view beacon's URL, or null (a preview). */
  beacon: { url: string; body: string } | null;
  strings: LeadFormStrings;
  fields: { company: boolean; email: boolean; sites: boolean };
  consentTicked: boolean;
  consentLine: string;
  privacyHref: string | null;
  /** Hidden inputs: the timing token, the preview token, ad details. */
  hidden: Record<string, string>;
  initialError: "name" | "phone" | "generic" | "busy" | null;
  dir: "ltr" | "rtl";
}) {
  const [errors, setErrors] = useState<FieldError[]>(initialError === "name" || initialError === "phone" ? [initialError] : []);
  const [alert, setAlert] = useState<string | null>(initialError === "busy" ? strings.errBusy : initialError === "generic" ? strings.errGeneric : null);
  const [sending, setSending] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    if (!beacon || sent.current) return;
    sent.current = true;
    try {
      // text/plain: no CORS preflight, no cookie needed.
      if (!navigator.sendBeacon?.(beacon.url, beacon.body)) void fetch(beacon.url, { method: "POST", body: beacon.body, keepalive: true, credentials: "omit" }).catch(() => undefined);
    } catch {
      // Counting is best effort.
    }
  }, [beacon]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sending) return;
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    const local: FieldError[] = [];
    if ((data.name ?? "").trim().length < 2) local.push("name");
    if ((data.phone ?? "").replace(/\D/g, "").length < 7) local.push("phone");
    setErrors(local);
    setAlert(null);
    if (local.length) {
      (form.elements.namedItem(local[0]) as HTMLInputElement | null)?.focus();
      return;
    }
    setSending(true);
    try {
      const res = await fetch(action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { handover?: string; thanks?: string; fields?: FieldError[] };
      const next = body.handover ?? body.thanks;
      if (res.ok && next) {
        window.location.assign(next);
        return;
      }
      if (res.status === 422 && body.fields?.length) setErrors(body.fields);
      else setAlert(res.status === 429 ? strings.errBusy : strings.errGeneric);
    } catch {
      setAlert(strings.errGeneric);
    }
    setSending(false);
  };

  const err = (f: FieldError) => errors.includes(f);
  return (
    <form className="lp-form" method="post" action={action} onSubmit={onSubmit} noValidate dir={dir} data-lead-form="">
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
      {fields.sites ? (
        <label className="lp-field">{strings.sites}<input className="lp-input" name="sites" type="number" inputMode="numeric" min={1} max={10000} step={1} dir="ltr" /></label>
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
    </form>
  );
}
