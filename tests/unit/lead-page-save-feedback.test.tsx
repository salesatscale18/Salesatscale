/**
 * Lead pages › Add / Edit: a save never looks silent (owner, 25 Nov: "I tried to save a lead draft
 * and it didn't work"). The parts that render without a browser: the Save buttons' pending state,
 * the line next to them after a refused save, the address marked required per connection, and the
 * browser's own check (the same messages as the server's). Focus and scrolling run in a real
 * browser: tests/e2e/lead-page-save.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveFootView, saveSummaryText, type SaveButton, type SaveFootText } from "@/app/app/[account]/lead-pages/form-shell";
import { AddressInput, DraftProvider, EMPTY_DRAFT } from "@/app/app/[account]/lead-pages/draft";
import { quickPageErrors, PAGE_ERRORS } from "@/lib/lead-pages/page-check";
import { parseLeadPageInput } from "@/lib/lead-pages/rules";
import { t } from "@/lib/i18n";

const text: SaveFootText = {
  notSavedOne: t("lead_pages.form.not_saved_one"), notSavedMany: t("lead_pages.form.not_saved_many"), notSavedForm: t("lead_pages.form.not_saved_form"),
  saving: t("lead_pages.form.saving"), goingLive: t("lead_pages.form.going_live"),
};
const buttons: SaveButton[] = [
  { intent: "draft", label: "Save draft", variant: "secondary" },
  { intent: "live", label: "Go live", variant: "primary" },
];
const foot = (p: Partial<Parameters<typeof SaveFootView>[0]>) => renderToStaticMarkup(
  <SaveFootView buttons={buttons} text={text} pending={false} pressed={null} summary={null} onJump={() => {}} {...p} />,
);
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the Save buttons", () => {
  it("idle: enabled, their own labels, no line", () => {
    const html = foot({});
    expect(html).not.toContain("disabled");
    expect(plain(html)).toBe("Save draft Go live");
    expect(html).not.toContain("data-save-error");
  });

  it("while a save runs: all disabled, the pressed one says Saving… (Going live…)", () => {
    let html = foot({ pending: true, pressed: "draft" });
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toMatch(/value="draft"[^>]*data-saving=""[^>]*>.*Saving…<\/button>/);
    expect(html).toMatch(/value="live"[^>]*>Go live<\/button>/);
    html = foot({ pending: true, pressed: "live" });
    expect(html).toMatch(/value="live"[^>]*data-saving=""[^>]*>.*Going live…<\/button>/);
    expect(html).toMatch(/value="draft"[^>]*>Save draft<\/button>/);
  });

  it("after a refused save: the line next to them names the count and the first field; hidden while the next save runs", () => {
    const html = foot({ summary: { count: 1, label: "Address of your page", form: null } });
    expect(html).toMatch(/<button type="button" class="lpg-notsaved" data-save-error="">/);
    expect(plain(html)).toContain("Not saved: 1 field needs a fix. First: Address of your page.");
    expect(foot({ summary: { count: 1, label: "Name", form: null }, pending: true, pressed: "draft" })).not.toContain("data-save-error");
    expect(saveSummaryText({ count: 2, label: "Name", form: null }, text)).toBe("Not saved: 2 fields need a fix. First: Name.");
    // Not about one field (the page is gone): the reason.
    expect(saveSummaryText({ count: 0, label: "", form: "This page no longer exists." }, text)).toBe("Not saved. This page no longer exists.");
  });
});

describe("the address is required only for Our form on your page", () => {
  const input = (connection: string) => renderToStaticMarkup(
    <DraftProvider value={{ draft: { ...EMPTY_DRAFT, connection }, setBanner: () => {} }}><AddressInput /></DraftProvider>,
  );
  it("aria-required follows the connection", () => {
    expect(input("snippet")).toContain('aria-required="true"');
    expect(input("own_form")).not.toContain("aria-required");
    expect(input("link")).not.toContain("aria-required");
  });
});

describe("the browser's own check before sending", () => {
  const server = (name: string, connection: string, address: string) => {
    const r = parseLeadPageInput({ name, connection, address, language: "en" }, { languages: ["en"] });
    return r.ok ? {} : r.errors;
  };
  it("the simple cases, with the server's messages", () => {
    const cases: [string, string, string][] = [
      ["", "link", ""], ["Offer", "snippet", ""], ["", "snippet", "  "], ["Offer", "own_form", "not an address"], ["Offer", "link", "not an address"],
      ["Offer", "snippet", "example.com/offer"], ["Offer", "own_form", ""], ["Offer", "link", ""],
    ];
    for (const [name, connection, address] of cases) expect(quickPageErrors({ name, connection, address })).toEqual(server(name, connection, address));
    expect(quickPageErrors({ name: " ", connection: "snippet", address: "" })).toEqual({ name: PAGE_ERRORS.nameEmpty, address: PAGE_ERRORS.addressRequired });
  });
});
