"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * What the add/edit form holds right now, as the seller edits it (not saved):
 * read from the form's own fields on every change, so the live preview and the
 * address field's place follow the form without making every field controlled.
 */
export type LeadPageDraft = {
  connection: string;
  language: string;
  marketId: string;
  company: boolean;
  email: boolean;
  consent: boolean;
  /** The opening-topic choice ("" none, "0".., "keep"). */
  topic: string;
  address: string;
  /** The chosen banner file, as an object URL, before it is uploaded; null when none is chosen. */
  banner: string | null;
};

export const EMPTY_DRAFT: LeadPageDraft = {
  connection: "snippet", language: "en", marketId: "", company: false, email: false, consent: false, topic: "", address: "", banner: null,
};

/** The draft from the form's fields (the banner is kept from `prev`: it comes from the banner field). */
export function readDraft(form: HTMLFormElement, prev: LeadPageDraft): LeadPageDraft {
  const el = (name: string) => form.elements.namedItem(name);
  const value = (name: string, fallback: string) => {
    const x = el(name);
    if (!x) return fallback;
    if (x instanceof RadioNodeList) return x.value || fallback;
    return "value" in x ? String((x as HTMLInputElement).value) : fallback;
  };
  const checked = (name: string, fallback: boolean) => {
    const x = el(name);
    return x instanceof HTMLInputElement ? x.checked : fallback;
  };
  return {
    connection: value("connection", prev.connection),
    language: value("language", prev.language),
    marketId: value("marketId", prev.marketId),
    company: checked("field_company", prev.company),
    email: checked("field_email", prev.email),
    consent: checked("consentTicked", prev.consent),
    topic: value("openingTopic", prev.topic),
    address: value("address", prev.address),
    banner: prev.banner,
  };
}

type DraftApi = { draft: LeadPageDraft; setBanner: (url: string | null) => void };
const Ctx = createContext<DraftApi>({ draft: EMPTY_DRAFT, setBanner: () => {} });

export function DraftProvider({ value, children }: { value: DraftApi; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLeadPageDraft = () => useContext(Ctx);

/**
 * The address field in its place for the chosen connection: second in "The page" block, or last for
 * "Button or link" (optional there). Rendered in one place only, so the keyboard order follows what shows.
 */
export function AddressSlot({ at, children }: { at: "early" | "late"; children: ReactNode }) {
  const { draft } = useLeadPageDraft();
  const late = draft.connection === "link";
  return (at === "late") === late ? <>{children}</> : null;
}

/** The address input; when it moves (another connection), it comes back with what was typed. */
export function AddressInput() {
  const { draft } = useLeadPageDraft();
  return <input className="sas-input" name="address" defaultValue={draft.address} placeholder="https://" inputMode="url" autoComplete="off" dir="ltr" />;
}
