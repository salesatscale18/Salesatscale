import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "@/components/sas/chat";
import { DealStateFields, WindowTimer } from "@/components/sas/record";
import { SELLER_NAV, SideNav } from "@/components/sas/nav";
import { StatusPill } from "@/components/sas/primitives";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("design system components", () => {
  it("status pill always has an icon and the exact word", () => {
    const out = html(<StatusPill object="payment" state="bank_transfer_expected" />);
    expect(out).toContain("sas-pill--warning");
    expect(out).toContain("<svg");
    expect(out).toContain("Bank transfer expected");
  });

  it("neutral pills get no tone class", () => {
    expect(html(<StatusPill object="lead" state="new" />)).toMatch(/class="sas-pill"/);
  });

  it("a Hebrew bubble carries lang and dir=\"auto\" (its text finds its direction), the row has no dir", () => {
    const out = html(<ChatMessage actor="buyer" who="Rina" locale="he">שלום</ChatMessage>);
    expect(out).toMatch(/class="sas-msg__bubble" lang="he" dir="auto"/);
    expect(out).not.toMatch(/class="sas-msg sas-msg--buyer"[^>]*dir=/);
  });

  it("renders the agent trace only when given", () => {
    const withTrace = html(
      <ChatMessage actor="agent" who="Agent" trace={[{ kind: "tool", label: "create_quote" }]}>Hi</ChatMessage>,
    );
    expect(withTrace).toContain("create_quote");
    expect(html(<ChatMessage actor="agent" who="Agent">Hi</ChatMessage>)).not.toContain("sas-msg__trace");
  });

  it("shows 'Not known yet' for a missing deal-state field and no provenance", () => {
    const out = html(<DealStateFields fields={[{ key: "b", label: "Budget", provenance: "inferred" }]} />);
    expect(out).toContain("Not known yet");
    expect(out).not.toContain("Agent inferred");
  });

  it("window timer says templates only when closed", () => {
    expect(html(<WindowTimer state="closed" />)).toContain("templates only");
    expect(html(<WindowTimer state="open" remaining="3h" />)).toContain("3h left");
  });

  it("side nav marks the active item and links under the base path", () => {
    const out = html(
      <SideNav mode="seller" basePath="/app/acme" active="leads" accountName="Acme" user={{ name: "D L", initials: "DL" }} />,
    );
    expect(out).toContain('href="/app/acme/leads" aria-current="page"');
    const itemCount = SELLER_NAV.flatMap((g) => g.items).filter((it) => !it.hidden).length;
    expect(out.match(/class="sas-nav__item"/g)).toHaveLength(itemCount);
    // Meetings and Reports are hidden until they are built (live review Package 5.9); their routes stay.
    expect(out).not.toContain('href="/app/acme/meetings"');
    expect(out).not.toContain('href="/app/acme/reports"');
  });

  it("side nav shows setup progress under Agent setup: bar, checks on done steps, Next on the first open one", () => {
    const out = html(
      <SideNav mode="seller" basePath="/app/acme" active="leads" accountName="Acme" user={{ name: "D L", initials: "DL" }} setup={{ done: ["company", "sources", "prices"] }} />,
    );
    expect(out).toContain('data-setup-done="3"');
    expect(out).toContain("3 of 8 done");
    expect(out).toContain('data-step-done="company"');
    expect(out).toContain('data-step-done="prices"');
    expect(out).toContain('data-step-next="knowledge"');
    expect(out).not.toContain('data-step-done="markets"');
    // Live accounts pass no setup: no progress in the menu.
    const live = html(<SideNav mode="seller" basePath="/app/acme" active="leads" accountName="Acme" user={{ name: "D L", initials: "DL" }} />);
    expect(live).not.toContain("sas-nav__progress");
    expect(live).not.toContain("data-step-");
  });
});
