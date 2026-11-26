import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/app/[account]/setup/playbook/draft/actions", () => ({ decideSuggestionAction: async () => {}, editSuggestionAction: async () => {} }));
const { SuggestionItem } = await import("@/app/app/[account]/setup/playbook/draft/suggestion");
type Props = Parameters<typeof SuggestionItem>[0];

const base = (status: string, payload: Record<string, unknown>) =>
  ({ id: "s1", kind: "limit", status, payload: { kind: "limit", rule: "Installation is free from 3 sites", ...payload }, evidence: [] }) as unknown as Props["s"];
const props = (s: Props["s"], limit: Props["limit"]): Props => ({ s, slug: "polar", back: "/x", editing: false, links: new Map(), calls: 0, editHref: "/e", cancelHref: "/c", limit });

describe("approved limits say where they now live (UX)", () => {
  it("an approved exception or setting links to Playbook › Limits, with no Edit or Undo", () => {
    const html = renderToStaticMarkup(<SuggestionItem {...props(base("accepted", {}), { kind: "exception" })} />);
    expect(html).toContain('data-limit-lives="playbook"');
    expect(html).toContain("Change in Playbook › Limits");
    expect(html).toContain('href="/app/polar/setup/playbook/limits"');
    expect(html).not.toContain(">Edit<");
  });

  it("an approved custom-pricing limit links to its price list", () => {
    const html = renderToStaticMarkup(<SuggestionItem {...props(base("accepted", { sku: "SNS-200" }), { kind: "setting", setting: "custom_pricing", before: "50", after: "20", sku: "SNS-200", listName: "Israel 2026" })} />);
    expect(html).toContain('data-limit-lives="price_list"');
    expect(html).toContain("Change in Price list Israel 2026");
  });

  it("a limit not yet approved keeps Edit and shows no link", () => {
    const html = renderToStaticMarkup(<SuggestionItem {...props(base("suggested", {}), { kind: "exception" })} />);
    expect(html).not.toContain("data-limit-lives");
    expect(html).toContain(">Edit<");
  });
});
