/** Super admin › Create a seller account: the form is a five-step wizard (one step on screen, one sentence on what each is). */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/sadmin/accounts/actions", () => ({ createAccountAction: vi.fn() }));
const { CreateAccountForm } = await import("@/app/sadmin/accounts/new/create-account-form");

describe("Create a seller account wizard", () => {
  const html = renderToStaticMarkup(<CreateAccountForm timezones={["Asia/Jerusalem"]} />);
  const step = (id: string) => html.match(new RegExp(`<fieldset class="sas-fieldset"( hidden="")? data-step="${id}"`))?.[1] === undefined;

  it("lists five steps and starts on Business with its one-sentence explanation", () => {
    expect(html.match(/<li class="sas-wizard__step/g)).toHaveLength(5);
    expect(html).toMatch(/aria-current="step"><button[^>]*data-wizard-jump="business"/);
    expect(html).toContain("The name buyers see, and the legal details used on quotes and order forms.");
    expect(html).toContain("Step 1 of 5");
  });

  it("shows only the current step; the other fields stay in the one form (sent together on Create)", () => {
    expect(step("business")).toBe(true);
    for (const id of ["market", "plan", "owner"]) expect(step(id), id).toBe(false);
    for (const name of ["tradeName", "market", "languages", "monthlySpendCap", "ownerName", "ownerEmail"]) expect(html).toContain(`name="${name}"`);
    expect(html).toMatch(/data-step="review"/);
  });

  it("has Next on the first step, no Back and no Create yet; later steps cannot be jumped to ahead", () => {
    expect(html).toContain("data-wizard-next");
    expect(html).not.toContain("data-wizard-back");
    expect(html).not.toContain(">Create account<");
    expect(html).toMatch(/<button type="button" class="sas-wizard__jump" disabled="" data-wizard-jump="owner"/);
  });
});
