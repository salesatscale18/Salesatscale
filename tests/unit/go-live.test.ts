import { describe, expect, it } from "vitest";
import { goLiveChecks, type GoLiveInput } from "@/lib/accounts/go-live";
import { parseCompany, whiteContrast } from "@/lib/accounts/company";

const ready: GoLiveInput = {
  company: { legalName: "Polar Monitoring Ltd", companyId: "51-555012-3", supportContact: "support@polar.test" },
  catalog: { version: 4, activeItems: 5 },
  liveAgentVersion: 2,
  approvedFacts: 12,
  languages: ["en", "he"],
  legalLanguages: ["en", "he"],
  payments: { card: true, bankTransfer: false, bankDetails: null },
  testConversations: 3,
};
const state = (input: GoLiveInput, id: string) => goLiveChecks(input).checks.find((c) => c.id === id)!.state;

describe("goLiveChecks", () => {
  it("passes every blocking check for a ready account; WhatsApp never blocks", () => {
    const r = goLiveChecks(ready);
    expect(r.ready).toBe(true);
    expect(r).toMatchObject({ passed: 7, total: 7 });
    expect(r.checks.find((c) => c.id === "whatsapp")).toMatchObject({ state: "later", blocking: false, fixPath: null });
  });

  it("needs legal name, company ID and support contact", () => {
    const r = goLiveChecks({ ...ready, company: { legalName: " ", companyId: null, supportContact: "x" } });
    expect(r.ready).toBe(false);
    expect(r.checks[0]).toMatchObject({ id: "company", state: "fail", fixPath: "/setup/company", data: { missing: "legal name, company ID" } });
    expect(r.passed).toBe(6);
  });

  it("needs a published catalog with an active product", () => {
    expect(state({ ...ready, catalog: null }, "catalog")).toBe("fail");
    expect(state({ ...ready, catalog: { version: 1, activeItems: 0 } }, "catalog")).toBe("fail");
  });

  it("needs a live agent version, an approved fact and a test conversation", () => {
    expect(state({ ...ready, liveAgentVersion: null }, "agent")).toBe("fail");
    expect(state({ ...ready, approvedFacts: 0 }, "knowledge")).toBe("fail");
    expect(state({ ...ready, testConversations: 0 }, "test_lab")).toBe("fail");
  });

  it("needs legal text in every selling language and names the missing ones", () => {
    const r = goLiveChecks({ ...ready, legalLanguages: ["en"] });
    expect(r.checks.find((c) => c.id === "legal")).toMatchObject({ state: "fail", fixPath: "/setup/order-form", data: { missing: "HE" } });
    expect(state({ ...ready, languages: [], legalLanguages: [] }, "legal")).toBe("fail");
  });

  it("needs a payment method; bank transfer only counts with bank details", () => {
    expect(state({ ...ready, payments: { card: false, bankTransfer: false, bankDetails: null } }, "payments")).toBe("fail");
    const noDetails = goLiveChecks({ ...ready, payments: { card: false, bankTransfer: true, bankDetails: "  " } }).checks.find((c) => c.id === "payments")!;
    expect(noDetails).toMatchObject({ state: "fail", data: { bankWithoutDetails: 1 } });
    expect(state({ ...ready, payments: { card: false, bankTransfer: true, bankDetails: "Leumi 800/123" } }, "payments")).toBe("pass");
  });
});

describe("company form", () => {
  it("requires a trade name and a valid color; trims optional fields to null", () => {
    expect(parseCompany({ tradeName: " ", brandColor: "#0f6b5a" })).toMatchObject({ ok: false, errors: { tradeName: expect.any(String) } });
    expect(parseCompany({ tradeName: "Polar", brandColor: "green" })).toMatchObject({ ok: false, errors: { brandColor: expect.any(String) } });
    expect(parseCompany({ tradeName: "Polar", brandColor: "#0F6B5A", salesRepUserId: "nope" })).toMatchObject({ ok: false, errors: { salesRepUserId: expect.any(String) } });
    expect(parseCompany({ tradeName: " Polar ", legalName: "", brandColor: "#0F6B5A" })).toEqual({
      ok: true,
      value: { tradeName: "Polar", legalName: null, companyId: null, address: null, supportContact: null, salesRepUserId: null, brandColor: "#0f6b5a" },
    });
  });

  it("measures white-text contrast on the brand color", () => {
    expect(whiteContrast("#0f6b5a")).toBeGreaterThan(4.5);
    expect(whiteContrast("#ffff00")).toBeLessThan(2);
  });
});
