/**
 * A browser harness for the add/edit form's save feedback (tests/e2e/lead-page-save.spec.ts): the real
 * form shell, Save foot, field errors, address slots, banner field and live preview, laid out like the
 * Add a page form (the same classes, about as tall), with a stand-in for the server action. The stand-in
 * refuses what the server refuses for these fields (lib/lead-pages/page-check.ts, the server's own
 * messages) and also a name the server would refuse for its own reasons ("Server says no"), waits a
 * moment (so the pending state shows) and records what it received (window.__sent).
 * Served by tests/e2e/helpers/harness.ts.
 */
import { createRoot } from "react-dom/client";
import { BannerField } from "@/app/app/[account]/lead-pages/banner-field";
import { AddressInput, AddressSlot, type LeadPageDraft } from "@/app/app/[account]/lead-pages/draft";
import { FieldError, LeadPageFormShell, SaveFoot } from "@/app/app/[account]/lead-pages/form-shell";
import { LeadPagePreview } from "@/app/app/[account]/lead-pages/preview";
import type { LeadPageFormState } from "@/app/app/[account]/lead-pages/actions";
import type { LeadPagePreviewData, PreviewTexts } from "@/lib/lead-pages/preview";
import { quickPageErrors } from "@/lib/lead-pages/page-check";
import { t } from "@/lib/i18n";

type Sent = { name: string; connection: string; address: string; intent: string };
const w = window as unknown as { __sent: Sent[]; __delay: number };
w.__sent = [];
w.__delay = 600;

async function action(_prev: LeadPageFormState, form: FormData): Promise<LeadPageFormState> {
  const v = (k: string) => String(form.get(k) ?? "");
  w.__sent.push({ name: v("name"), connection: v("connection"), address: v("address"), intent: v("intent") });
  await new Promise((r) => setTimeout(r, w.__delay));
  const errors: Record<string, string> = { ...quickPageErrors({ name: v("name"), connection: v("connection"), address: v("address") }) };
  if (v("name") === "Server says no") errors.name = "Use another name.";
  if (Object.keys(errors).length) return { errors, connection: v("connection") };
  document.body.setAttribute("data-saved", `${v("intent")}:${v("name")}`);
  return null;
}

const form = (_lang: "en" | "he") => ({
  title: "Leave your details", name: "Full name", phone: "Mobile number", company: "Company (optional)", email: "Email (optional)", send: "Send",
  sending: "…", errName: "", errPhone: "", errGeneric: "", errBusy: "", privacy: "Privacy notice", closed: "", continue: "",
});
const texts = (lang: "en" | "he"): PreviewTexts => ({
  lang, dir: lang === "he" ? "rtl" : "ltr", seller: "Polar Demo", initials: "PD", form: form(lang),
  consentLine: ["By sending, you agree that ", "Polar Demo", " may contact you."],
  thanks: "Thanks, Dana", connecting: "Connecting you with Maya",
  buttons: { talkNow: "Talk now", chatWriting: "Chat in writing", continueChat: "Continue to the chat" }, byLine: "Conversation by Sales at Scale",
  openers: { "": "opener" }, about: { "": null },
  chat: { initials: "PD", automated: "Maya · automated assistant" },
});
const data: LeadPagePreviewData = {
  texts: { en: texts("en"), he: texts("he") },
  formStyle: { "--brand": "#0f6b5a", "--brand-on": "#ffffff", "--brand-text": "#0f6b5a" },
  handoverStyle: { "--brand": "#0f6b5a", "--brand-on": "#ffffff", "--brand-text": "#0f6b5a", "--bubble": "#e2edeb" },
  voiceOffered: true, privacy: ["|en"], savedBanner: null, openerTemplates: {},
};
const initial: LeadPageDraft = { connection: "snippet", language: "en", marketId: "", company: false, email: false, consent: true, topic: "", address: "", banner: null };
const required = t("lead_pages.form.required");
const saveText = {
  notSavedOne: t("lead_pages.form.not_saved_one"), notSavedMany: t("lead_pages.form.not_saved_many"), notSavedForm: t("lead_pages.form.not_saved_form"),
  saving: t("lead_pages.form.saving"), goingLive: t("lead_pages.form.going_live"),
};
const address = (
  <label className="lpg-field lpg-field--address" data-address-field="">
    <span className="lpg-field__label" data-for="link">{t("lead_pages.form.address")}</span>
    <span className="lpg-field__label" data-for="snippet">{t("lead_pages.form.address_snippet")} <span className="lpg-req">{required}</span></span>
    <span className="lpg-field__label" data-for="own_form">{t("lead_pages.form.address_own")}</span>
    <AddressInput />
    <span className="sas-small" data-for="link">{t("lead_pages.form.address_hint")}</span>
    <span className="sas-small" data-for="snippet">{t("lead_pages.form.address_snippet_hint")}</span>
    <span className="sas-small" data-for="own_form">{t("lead_pages.form.address_own_hint")}</span>
    <FieldError name="address" />
  </label>
);
const card = (id: string, title: string, line: string, checked = false) => (
  <label className="lpg-ccard" data-connection={id}>
    <input type="radio" name="connection" value={id} defaultChecked={checked} />
    <span className="lpg-ccard__head"><span className="lpg-ccard__icon">▭</span><span className="lpg-ccard__title"><strong>{title}</strong></span></span>
    <span className="sas-small">{line}</span>
  </label>
);
// The sections between the page block and the Save buttons (as tall as the real form's).
const filler = (h: string, lines: number) => (
  <div className="lpg-sec">
    <h2 className="lpg-sec__h">{h}</h2>
    {Array.from({ length: lines }, (_, i) => <span key={i} className="sas-small">A line of help text that the real form has here, to keep its height.</span>)}
  </div>
);

createRoot(document.getElementById("root")!).render(
  <main className="sas-shell__content lpg-page">
    <header className="sas-stack-2"><h1 className="sas-title">Add a page</h1></header>
    <LeadPageFormShell
      action={action} errorTitle={t("lead_pages.form.errors")} className="lpg-form" initialDraft={initial} summaryText={saveText}
      side={(
        <LeadPagePreview
          data={data}
          text={{
            title: t("lead_pages.preview.title"), tabs: { form: "Form", handover: "Hand-over", first: "First message" }, changed: "changed",
            noteSnippet: "On your page it takes your page's font.", noteOwn: "Your own form stays as it is.", sample: "Sample buyer Dana. Nothing here is sent.",
            close: t("lead_pages.preview.close"), afterSave: null,
          }}
        />
      )}
    >
      <fieldset className="lpg-connect">
        <legend className="sas-label">{t("lead_pages.form.how")}</legend>
        <div className="lpg-connect__cards">
          {card("snippet", "Our form on your page", "Paste one snippet where the form should be.", true)}
          {card("own_form", "Your own form", "Keep the form you have and point it at us.")}
          {card("link", "Button or link", "For pages that can't hold a form.")}
        </div>
        <FieldError name="connection" />
      </fieldset>
      <section className="sas-panel lpg-form__main">
        <div className="lpg-sec">
          <h2 className="lpg-sec__h">{t("lead_pages.form.page")}</h2>
          <div className="lpg-grid2">
            <label className="lpg-field">
              <span className="lpg-field__label">{t("lead_pages.form.name")} <span className="lpg-req">{required}</span></span>
              <input className="sas-input" name="name" maxLength={80} required autoComplete="off" />
              <span className="sas-small">{t("lead_pages.form.name_hint")}</span>
              <FieldError name="name" />
            </label>
            <AddressSlot at="early">{address}</AddressSlot>
            <label className="lpg-field"><span className="lpg-field__label">Market</span><select className="sas-select" name="marketId" defaultValue=""><option value="">Any market</option></select></label>
            <label className="lpg-field"><span className="lpg-field__label">Language of the form</span><select className="sas-select" name="language" defaultValue="en"><option value="en">English</option></select></label>
            <AddressSlot at="late">{address}</AddressSlot>
          </div>
        </div>
        {filler("What the buyer fills in", 5)}
        <div className="lpg-sec">
          <h2 className="lpg-sec__h">The hand-over screen</h2>
          <BannerField
            saved={null} uploads removeButton={null} icons={{ placeholder: <span>▭</span>, upload: <span>↑</span> }}
            text={{ title: "Banner", hint: "", none: "", choose: "Choose image", replace: "Replace", remove: "Remove", off: "", selected: "Chosen: {name}", wrongType: "Wrong type", tooBig: "Too big {size}", again: "Again", clear: "Don't use it" }}
          />
        </div>
        {filler("How the agent opens", 3)}
        {filler("Your ad tracking", 5)}
        <SaveFoot
          text={saveText}
          buttons={[
            { intent: "draft", label: t("lead_pages.form.save_draft"), variant: "secondary" },
            { intent: "live", label: t("lead_pages.form.go_live"), variant: "primary" },
          ]}
          after={<a className="sas-btn sas-btn--ghost" href="#">Cancel</a>}
        />
      </section>
    </LeadPageFormShell>
  </main>,
);
