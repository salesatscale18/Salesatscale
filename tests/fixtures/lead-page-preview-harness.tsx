/**
 * A browser harness for the add/edit form's live preview (tests/e2e/lead-page-preview.spec.ts):
 * the real form shell, the real address slots and banner field, and the real preview, with
 * stand-in preview data (the server's own data is checked on PGlite in
 * tests/integration/lead-pages-preview.test.tsx). Served by tests/e2e/helpers/harness.ts.
 */
import { createRoot } from "react-dom/client";
import { BannerField } from "@/app/app/[account]/lead-pages/banner-field";
import { AddressInput, AddressSlot, type LeadPageDraft } from "@/app/app/[account]/lead-pages/draft";
import { LeadPageFormShell } from "@/app/app/[account]/lead-pages/form-shell";
import { LeadPagePreview } from "@/app/app/[account]/lead-pages/preview";
import type { LeadPageFormState } from "@/app/app/[account]/lead-pages/actions";
import type { LeadPagePreviewData, PreviewTexts } from "@/lib/lead-pages/preview";

const form = (lang: "en" | "he") => ({
  title: lang === "he" ? "השאירו פרטים" : "Leave your details", name: lang === "he" ? "שם מלא" : "Full name", phone: lang === "he" ? "מספר נייד" : "Mobile number",
  company: lang === "he" ? "חברה (לא חובה)" : "Company (optional)", email: lang === "he" ? "אימייל (לא חובה)" : "Email (optional)", send: lang === "he" ? "שליחה" : "Send",
  sending: "…", errName: "", errPhone: "", errGeneric: "", errBusy: "", privacy: lang === "he" ? "הודעת פרטיות" : "Privacy notice", closed: "", continue: "",
});
const texts = (lang: "en" | "he"): PreviewTexts => ({
  lang, dir: lang === "he" ? "rtl" : "ltr", seller: "Polar Demo", initials: "PD", form: form(lang),
  consentLine: lang === "he" ? ["בשליחה את/ה מסכימ/ה ש-", "Polar Demo", " תיצור קשר."] : ["By sending, you agree that ", "Polar Demo", " may contact you."],
  thanks: lang === "he" ? "תודה, דנה" : "Thanks, Dana", connecting: lang === "he" ? "מחברים אותך למאיה" : "Connecting you with Maya",
  buttons: { talkNow: "Talk now", chatWriting: "Chat in writing", continueChat: "Continue to the chat" }, byLine: "Conversation by Sales at Scale",
  openers: { "": `${lang}: opener default`, "0": `${lang}: opener fridges`, "1": `${lang}: opener cold rooms` },
  about: { "": null, "0": null, "1": null },
  chat: { initials: "PD", automated: "Maya · automated assistant" },
});
const data: LeadPagePreviewData = {
  texts: { en: texts("en"), he: texts("he") },
  formStyle: { "--brand": "#0f6b5a", "--brand-on": "#ffffff", "--brand-text": "#0f6b5a" },
  handoverStyle: { "--brand": "#0f6b5a", "--brand-on": "#ffffff", "--brand-text": "#0f6b5a", "--bubble": "#e2edeb" },
  voiceOffered: true, privacy: ["|en"], savedBanner: null, openerTemplates: {},
};
const initial: LeadPageDraft = { connection: "snippet", language: "en", marketId: "", company: false, email: false, consent: true, topic: "0", address: "", banner: null };
const action = async (): Promise<LeadPageFormState> => null;
const address = <label className="lpg-field lpg-field--address" data-address-field="">Address<AddressInput /></label>;

createRoot(document.getElementById("root")!).render(
  <LeadPageFormShell
    action={action} errorTitle="Check the fields." className="lpg-form" initialDraft={initial}
    side={(
      <LeadPagePreview
        data={data}
        text={{
          title: "Preview", tabs: { form: "Form", handover: "Hand-over", first: "First message" }, changed: "changed",
          noteSnippet: "On your page it takes your page's font.", noteOwn: "Your own form stays as it is.", sample: "Sample buyer Dana. Nothing here is sent.", close: "Close",
          afterSave: { snippet: "You get the snippet when you save.", own_form: "You get your form's address when you save.", link: "You get the link for your button when you save." },
        }}
      />
    )}
  >
    <fieldset className="lpg-connect">
      <label><input type="radio" name="connection" value="snippet" defaultChecked />Our form on your page</label>
      <label><input type="radio" name="connection" value="own_form" />Your own form</label>
      <label><input type="radio" name="connection" value="link" />Button or link</label>
    </fieldset>
    <section className="sas-panel lpg-form__main">
      <div className="lpg-grid2">
        <label>Name <input name="name" /></label>
        <AddressSlot at="early">{address}</AddressSlot>
        <label>Market <select name="marketId" defaultValue=""><option value="">Any market</option><option value="m2">Other</option></select></label>
        <label>Language <select name="language" defaultValue="en"><option value="en">English</option><option value="he">Hebrew</option></select></label>
        <AddressSlot at="late">{address}</AddressSlot>
      </div>
      <label><input type="checkbox" name="field_company" />Company</label>
      <label><input type="checkbox" name="field_email" />Email</label>
      <label><input type="checkbox" name="consentTicked" defaultChecked />Tick the consent box</label>
      <BannerField
        saved={null} uploads removeButton={null}
        icons={{ placeholder: <span>▭</span>, upload: <span>↑</span> }}
        text={{
          title: "Banner", hint: "", none: "", choose: "Choose image", replace: "Replace", remove: "Remove", off: "", selected: "Chosen: {name}",
          wrongType: "Wrong type", tooBig: "Too big {size}", again: "Again", clear: "Don't use it",
        }}
      />
      <label>Opening topic <select name="openingTopic" defaultValue="0"><option value="">None</option><option value="0">Fridges</option><option value="1">Cold rooms</option></select></label>
      <button type="submit" name="intent" value="draft">Save draft</button>
    </section>
  </LeadPageFormShell>,
);
