import { describe, expect, it } from "vitest";
import type { DealFieldValue } from "@/db/schema";
import { linksOnOwnLine } from "@/lib/agent/links";
import { inboxGroup, parseInboxFilter } from "@/lib/conversations/inbox";
import { publicBaseUrl } from "@/lib/channels/whatsapp";
import { DEAL_KEYS_FOR_FIELD, dealValueFor, orderFormPrefill } from "@/lib/orders/prefill";
import { publicUrl } from "@/lib/orders/token";
import { ORDER_FORM_FIELDS } from "@/db/schema";

const L = "https://app.example/f/abc.def";

describe("linksOnOwnLine", () => {
  it("lifts an inline link onto its own line and drops stray punctuation", () => {
    expect(linksOnOwnLine(`Here is your form: ${L}. Valid 7 days.`, [L])).toBe(`Here is your form:\n${L}\nValid 7 days.`);
  });
  it("drops markdown and angle brackets around the link", () => {
    expect(linksOnOwnLine(`Form: [open it](${L}) thanks`, [L])).toBe(`Form:\n${L}\nthanks`);
    expect(linksOnOwnLine(`Form: <${L}>`, [L])).toBe(`Form:\n${L}`);
  });
  it("appends a link the model left out", () => {
    expect(linksOnOwnLine("I sent the order form.", [L])).toBe(`I sent the order form.\n${L}`);
  });
  it("leaves text already right untouched", () => {
    expect(linksOnOwnLine(`Here it is:\n${L}`, [L])).toBe(`Here it is:\n${L}`);
    expect(linksOnOwnLine("No links here.", [])).toBe("No links here.");
  });
  it("handles links with regex characters and repeats", () => {
    const odd = "https://x.example/f/a+b?c=(1)";
    expect(linksOnOwnLine(`See ${odd} and again ${odd}`, [odd, odd])).toBe(`See\n${odd}\nand again\n${odd}`);
  });
});

describe("inbox groups", () => {
  it("needs you: hand-off nobody took, or a person holds it and the buyer wrote last", () => {
    expect(inboxGroup({ status: "human", takenOverByUserId: null, lastActor: "agent" })).toBe("needs_you");
    expect(inboxGroup({ status: "human", takenOverByUserId: "u", lastActor: "buyer" })).toBe("needs_you");
    expect(inboxGroup({ status: "human", takenOverByUserId: "u", lastActor: "human" })).toBe("human");
    expect(inboxGroup({ status: "open", takenOverByUserId: null, lastActor: "buyer" })).toBe("agent");
    expect(inboxGroup({ status: "closed", takenOverByUserId: null, lastActor: null })).toBe("closed");
  });
  it("parses filters, defaulting to all", () => {
    expect(parseInboxFilter("test")).toBe("test");
    expect(parseInboxFilter("needs_you")).toBe("needs_you");
    expect(parseInboxFilter("nope")).toBe("all");
    expect(parseInboxFilter(undefined)).toBe("all");
  });
});

describe("absolute links", () => {
  it("publicUrl always has a scheme", () => {
    expect(publicUrl("/f/x", { APP_URL: "https://app.example/" })).toBe("https://app.example/f/x");
    expect(publicUrl("/f/x", { APP_URL: "app.example" })).toBe("https://app.example/f/x");
    expect(publicUrl("/f/x", { VERCEL_PROJECT_PRODUCTION_URL: "p.vercel.app" })).toBe("https://p.vercel.app/f/x");
    expect(publicUrl("/f/x", {})).toBe("http://localhost:3000/f/x");
  });
  it("publicBaseUrl adds https to a bare APP_URL", () => {
    expect(publicBaseUrl({ APP_URL: "app.example/" })).toBe("https://app.example");
    expect(publicBaseUrl({ APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });
});

describe("order form prefill", () => {
  const v = (value: string, provenance: DealFieldValue["provenance"] = "buyer"): DealFieldValue => ({ value, provenance, updatedAt: "2026-11-16" });
  const lead = { fullName: "Yossi Amar", company: "Burger Lab", email: "yossi@x.test" };

  it("maps every order-form field in one place", () => {
    for (const f of ORDER_FORM_FIELDS) expect(DEAL_KEYS_FOR_FIELD[f].length).toBeGreaterThan(0);
    expect(DEAL_KEYS_FOR_FIELD.signatory_name.length).toBeGreaterThan(0);
  });

  it("falls back to the lead record", () => {
    expect(orderFormPrefill(lead, null)).toEqual({ company_name: "Burger Lab", invoice_email: "yossi@x.test", signatory_name: "Yossi Amar" });
    expect(orderFormPrefill({ fullName: "Noa", company: null, email: null }, {})).toEqual({ signatory_name: "Noa" });
  });

  it("fills every field the deal state knows, under any of its keys", () => {
    expect(orderFormPrefill(lead, {
      legal_name: v("Burger Lab Ltd"), company_number: v("515151515"), invoice_address: v("1 Herzl St"), shipping_address: v("5 Dizengoff St"),
      billing_email: v("billing@x.test"), signatory: v("Dana Levi"), job_title: v("CFO"), purchase_order: v("PO-7"), sites: v("12"),
    })).toEqual({
      company_name: "Burger Lab Ltd", company_id: "515151515", billing_address: "1 Herzl St", delivery_address: "5 Dizengoff St",
      invoice_email: "billing@x.test", signatory_name: "Dana Levi", signatory_role: "CFO", po_number: "PO-7",
    });
  });

  it("one address fills both billing and delivery unless each is given", () => {
    expect(orderFormPrefill(lead, { address: v("2 Main St") })).toMatchObject({ billing_address: "2 Main St", delivery_address: "2 Main St" });
    expect(orderFormPrefill(lead, { address: v("2 Main St"), delivery_address: v("9 Port Rd") })).toMatchObject({ billing_address: "2 Main St", delivery_address: "9 Port Rd" });
  });

  it("precedence: verified, then buyer-said, then the lead record, then inferred; placeholders never fill", () => {
    expect(orderFormPrefill(lead, { company_name: v("Guess Inc", "inferred") }).company_name).toBe("Burger Lab");
    expect(orderFormPrefill({ ...lead, company: null }, { company_name: v("Guess Inc", "inferred") }).company_name).toBe("Guess Inc");
    expect(orderFormPrefill(lead, { company: v("Said Ltd"), company_name: v("Verified Ltd", "verified") }).company_name).toBe("Verified Ltd");
    expect(orderFormPrefill(lead, { company_id: v("n/a"), company_number: v("-") }).company_id).toBeUndefined();
    expect(dealValueFor("company_id", { company_id: v("unknown") })).toBeNull();
  });
});
