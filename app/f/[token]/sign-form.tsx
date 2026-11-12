"use client";

import { useActionState } from "react";
import type { OrderFormField } from "@/db/schema";
import { translator, type Locale } from "@/lib/i18n";
import { signAction, type SignState } from "./actions";

/** Business details + signature (canvas: BuyerOrder). The server validates everything again. */
export function SignForm({ token, lang, fields, prefill, company }: {
  token: string; lang: Locale; fields: OrderFormField[]; prefill: Record<string, string>; company: string;
}) {
  const tr = translator(lang);
  const [state, action, pending] = useActionState<SignState, FormData>(signAction, { status: "idle" });
  const e = state.status === "error" ? state.errors : {};
  const err = (k: keyof typeof e) => (e[k] ? <span className="b-err" id={`e-${k}`}>{e[k] === "invalid" ? tr("buyer.err.invalid") : k === "agreed" ? tr("buyer.err.agreed") : tr("buyer.err.required")}</span> : null);
  const inv = (k: keyof typeof e) => (e[k] ? { "aria-invalid": true as const, "aria-describedby": `e-${k}` } : {});
  const detail = fields.filter((f) => f !== "signatory_role");
  return (
    <form action={action} noValidate>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="lang" value={lang} />
      <section className="b-sec" aria-labelledby="bd-h">
        <h2 id="bd-h" className="b-h2">{tr("buyer.details")}</h2>
        {detail.map((f) => (
          <label key={f} className="b-lbl" htmlFor={`f-${f}`}>
            {tr(`buyer.field.${f}`)}
            <input
              className="b-inp" id={`f-${f}`} name={f} defaultValue={prefill[f] ?? ""} {...inv(f)}
              type={f === "invoice_email" ? "email" : "text"} inputMode={f === "company_id" ? "numeric" : undefined}
              autoComplete={f === "invoice_email" ? "email" : f === "company_name" ? "organization" : f.endsWith("address") ? "street-address" : undefined}
            />
            {err(f)}
          </label>
        ))}
      </section>
      <section className="b-sec" aria-labelledby="sg-h">
        <h2 id="sg-h" className="b-h2">{tr("buyer.sign")}</h2>
        <label className="b-lbl" htmlFor="f-full_name">
          {tr("buyer.full_name")}
          <input className="b-inp" id="f-full_name" name="full_name" defaultValue={prefill.signatory_name ?? ""} autoComplete="name" {...inv("full_name")} />
          {err("full_name")}
        </label>
        {fields.includes("signatory_role") ? (
          <label className="b-lbl" htmlFor="f-role">
            {tr("buyer.role")}
            <input className="b-inp" id="f-role" name="signatory_role" autoComplete="organization-title" {...inv("signatory_role")} />
            {err("signatory_role")}
          </label>
        ) : null}
        <label className="b-check">
          <input type="checkbox" name="agreed" {...inv("agreed")} />
          <span>{tr("buyer.agree", { company: company || tr("buyer.agree_fallback") })}</span>
        </label>
        {err("agreed")}
        {state.status === "error" && state.formError ? <span className="b-err" role="alert">{tr("buyer.err.not_open")}</span> : null}
        <button type="submit" className="b-btn" disabled={pending}>{pending ? tr("buyer.signing") : tr("buyer.sign_and_pay")}</button>
        <span className="b-mut" style={{ textAlign: "center" }}>{tr("buyer.sign_note")}</span>
      </section>
    </form>
  );
}
