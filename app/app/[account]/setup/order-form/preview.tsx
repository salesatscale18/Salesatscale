"use client";

import { useEffect, useState } from "react";
import { dir, translator, type Locale, type MessageKey } from "@/lib/i18n";

/**
 * The fields the buyer fills in, as the buyer page lays them out (app/f/[token]/steps.tsx):
 * the ticked company fields, then the signer, whose full name is always asked and whose role when ticked.
 */
export function previewFields(order: readonly string[], fields: readonly string[]): { company: string[]; signer: ("full_name" | "signatory_role")[] } {
  return {
    company: order.filter((f) => f !== "signatory_role" && fields.includes(f)),
    signer: fields.includes("signatory_role") ? ["full_name", "signatory_role"] : ["full_name"],
  };
}

const SIGNER_LABEL: Record<"full_name" | "signatory_role", MessageKey> = { full_name: "buyer.signer.full_name", signatory_role: "buyer.signer.role" };

/** Live mobile preview of the buyer page (canvas: OrderFormSetup, right column). Sample items only. */
export function BuyerPreview({ seller, brand, languages, sections, fields, fieldOrder, delivery, noDeliveryHint }: {
  seller: string; brand: string; languages: string[]; sections: Record<string, { title: string; version: number }[]>; fields: string[];
  /** Every optional field in form order (ORDER_FORM_FIELDS; passed in so this client file does not load the schema). */
  fieldOrder: readonly string[];
  /** The delivery estimate per language as the buyer sees it before signing; null when no lead time is set. */
  delivery?: Record<string, { label: string; lead: string }> | null;
  noDeliveryHint?: string;
}) {
  const langs = languages.filter((l): l is Locale => l === "en" || l === "he");
  const [lang, setLang] = useState<Locale>(langs[0] ?? "en");
  // Follows the field ticks on the page before they are saved (the checkboxes named "fields").
  const [ticked, setTicked] = useState<string[]>(fields);
  useEffect(() => {
    const read = (e: Event) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || el.name !== "fields") return;
      const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="fields"]')];
      const hidden = [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="fields"]')].map((h) => h.value);
      setTicked([...new Set([...hidden, ...boxes.filter((b) => b.checked).map((b) => b.value)])]);
    };
    document.addEventListener("change", read);
    return () => document.removeEventListener("change", read);
  }, []);
  const shown = previewFields(fieldOrder, ticked);
  const tr = translator(lang);
  const initials = seller.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const legal = sections[lang] ?? [];
  return (
    <section aria-label="Buyer preview" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ display: "flex", gap: 6 }} role="group" aria-label="Preview language">
        {langs.map((l) => (
          <button key={l} type="button" className={`sas-btn sas-btn--sm ${l === lang ? "sas-btn--primary" : "sas-btn--secondary"}`} aria-pressed={l === lang} onClick={() => setLang(l)}>
            {l === "he" ? "עברית" : "English"}
          </button>
        ))}
      </div>
      <div lang={lang} dir={dir(lang)} style={{ width: 320, maxWidth: "100%", background: "#fff", border: "1px solid var(--line)", borderRadius: 28, overflow: "hidden", boxShadow: "var(--shadow-pop)", fontSize: 13, lineHeight: "18px", color: "#0f1420" }}>
        <div style={{ background: "#fdf1dc", padding: "6px 12px", fontSize: 11, fontWeight: 600, textAlign: "center" }}>{tr("buyer.test_strip")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 16, borderBottom: "1px solid var(--line)" }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, background: brand, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700 }}>{initials}</span>
          <span><b style={{ display: "block", fontSize: 14 }}>{seller}</b><span style={{ color: "#566073", fontSize: 12 }}>{tr("buyer.order_form")} · Q-1001 v1</span></span>
        </div>
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>6 × Sample product</span><span className="sas-num" style={{ fontSize: 12 }}>₪3,540.00</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid var(--line)", paddingTop: 8 }}><span>{tr("buyer.due_today")}</span><span className="sas-num" style={{ fontSize: 12 }}>₪3,540.00</span></div>
          {delivery?.[lang] ? (
            <div data-delivery-preview="" style={{ display: "flex", flexDirection: "column", gap: 2 }}><b>{delivery[lang].label}</b><span style={{ color: "#566073", fontSize: 12 }}>{delivery[lang].lead}</span></div>
          ) : noDeliveryHint ? (
            <div data-delivery-preview-empty="" dir="ltr" style={{ color: "#566073", fontSize: 12 }}>{noDeliveryHint}</div>
          ) : null}
          {shown.company.map((f) => (
            <div key={f} data-preview-field={f} style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 11, fontWeight: 600 }}>{tr(`buyer.field.${f}` as "buyer.field.company_name")}</span><div style={{ height: 28, border: "1px solid var(--line-strong)", borderRadius: 6 }} /></div>
          ))}
          <b style={{ fontSize: 12, paddingTop: 4 }}>{tr("buyer.signer.title")}</b>
          {shown.signer.map((f) => (
            <div key={f} data-preview-field={f} style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 11, fontWeight: 600 }}>{tr(SIGNER_LABEL[f])}</span><div style={{ height: 28, border: "1px solid var(--line-strong)", borderRadius: 6 }} /></div>
          ))}
          {legal.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {legal.map((s) => <div key={s.title} style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: 4 }}><span>{s.title}</span><span style={{ color: "#566073" }}>{tr("buyer.version", { version: s.version })}</span></div>)}
            </div>
          ) : <div style={{ color: "#a15c07", fontSize: 12 }}>No legal text in this language yet.</div>}
          <div style={{ display: "flex", gap: 6, color: "#566073", fontSize: 12 }}><span style={{ width: 14, height: 14, border: "1.5px solid #566073", borderRadius: 3, flex: "none" }} />{tr("buyer.agree", { company: tr("buyer.agree_fallback") })}</div>
          <span style={{ minHeight: 40, borderRadius: 10, background: brand, color: "#fff", display: "grid", placeItems: "center", fontWeight: 600, textAlign: "center", padding: "0 8px" }}>{tr("buyer.sign_and_pay")}</span>
        </div>
        <div style={{ textAlign: "center", padding: "6px 0 14px", fontSize: 11, color: "#566073" }}>{tr("buyer.secured_by")}</div>
      </div>
    </section>
  );
}
