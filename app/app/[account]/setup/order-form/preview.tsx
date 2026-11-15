"use client";

import { useState } from "react";
import { dir, translator, type Locale } from "@/lib/i18n";

/** Live mobile preview of the buyer page (canvas: OrderFormSetup, right column). Sample items only. */
export function BuyerPreview({ seller, brand, languages, sections, fields }: {
  seller: string; brand: string; languages: string[]; sections: Record<string, { title: string; version: number }[]>; fields: string[];
}) {
  const langs = languages.filter((l): l is Locale => l === "en" || l === "he");
  const [lang, setLang] = useState<Locale>(langs[0] ?? "en");
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
          {fields.filter((f) => f !== "signatory_role").slice(0, 3).map((f) => (
            <div key={f} style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 11, fontWeight: 600 }}>{tr(`buyer.field.${f}` as "buyer.field.company_name")}</span><div style={{ height: 28, border: "1px solid var(--line-strong)", borderRadius: 6 }} /></div>
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
