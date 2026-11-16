import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestedReplyBox } from "@/app/app/[account]/leads/[leadId]/suggested-reply";
import { STATUS } from "@/lib/domain/status";

describe("reply box with the agent's suggestion (UX: agent text is always labelled)", () => {
  const base = { id: "r1", label: "Suggested by the agent · edit before sending", clearLabel: "Clear" };

  it("labels prefilled agent text and offers Clear", () => {
    const html = renderToStaticMarkup(<SuggestedReplyBox {...base} suggested="Hi Rina, the order form is ready." />);
    expect(html).toContain("data-agent-suggestion");
    expect(html).toContain("Suggested by the agent · edit before sending");
    expect(html).toContain(">Clear<");
    expect(html).toContain("Hi Rina, the order form is ready.");
  });

  it("shows no label when there is no suggestion", () => {
    const html = renderToStaticMarkup(<SuggestedReplyBox {...base} suggested={null} />);
    expect(html).not.toContain("data-agent-suggestion");
    expect(html).toContain('name="text"');
  });
});

describe("source status words (UX sign-off)", () => {
  it("Ready for review is neutral, and Partly failed differs from Needs input by icon", () => {
    expect(STATUS.source.ready).toMatchObject({ tone: "neutral", icon: "scan-search" });
    expect(STATUS.source.processing).toMatchObject({ tone: "agent", icon: "sparkles" });
    expect(STATUS.source.partly_failed.icon).not.toBe(STATUS.source.needs_input.icon);
  });
});
