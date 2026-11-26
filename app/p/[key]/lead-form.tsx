"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LeadFormFields, type LeadFormFieldError as FieldError, type LeadFormStrings } from "./lead-form-view";

export type { LeadFormStrings };

/**
 * The hosted lead form. A plain HTML form that works without JavaScript
 * (urlencoded POST, 303 to the hand-over); with JavaScript it checks the two
 * required fields, posts JSON, shows "Sending…" and goes to the hand-over.
 * It also sends the page's one "view" beacon (no cookie, no identifier; never
 * for a preview). Nothing personal ever goes in a URL.
 */
export function LeadForm({ action, beacon, strings, fields, consentTicked, consentLine, privacyHref, hidden, initialError, dir }: {
  action: string;
  /** The view beacon's URL and body (a preview's carries its token and is never counted), or null. */
  beacon: { url: string; body: string } | null;
  strings: LeadFormStrings;
  fields: { company: boolean; email: boolean };
  consentTicked: boolean;
  /** The consent line in parts (names at odd indexes, isolated when shown). */
  consentLine: readonly string[];
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

  // A preview form brought back from the browser's back-forward cache (after a send): empty again, ready to send.
  const formRef = useRef<HTMLFormElement>(null);
  const isPreview = !!hidden.preview;
  useEffect(() => {
    if (!isPreview) return;
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      formRef.current?.reset();
      setSending(false);
      setErrors([]);
      setAlert(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [isPreview]);

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
      const post = async () => {
        const r = await fetch(action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), credentials: "same-origin" });
        return { res: r, body: (await r.json().catch(() => ({}))) as { handover?: string; thanks?: string; fields?: FieldError[]; error?: string; retryAfterMs?: number } };
      };
      let { res, body } = await post();
      // Sent within a second of the form loading (autofill and a quick tap): wait out the rest and send once more, no error shown.
      if (res.status === 403 && body.error === "timing" && (body.retryAfterMs ?? 0) > 0) {
        await new Promise((r) => setTimeout(r, Math.min(body.retryAfterMs ?? 0, 5000) + 150));
        ({ res, body } = await post());
      }
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

  return (
    <form ref={formRef} className="lp-form" method="post" action={action} onSubmit={onSubmit} noValidate dir={dir} data-lead-form="">
      <LeadFormFields
        strings={strings} fields={fields} consentTicked={consentTicked} consentLine={consentLine} privacyHref={privacyHref}
        hidden={hidden} errors={errors} alert={alert} sending={sending}
      />
    </form>
  );
}
