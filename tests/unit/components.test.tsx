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

  it("sets dir and lang on a Hebrew bubble only", () => {
    const out = html(<ChatMessage actor="buyer" who="Rina" locale="he">שלום</ChatMessage>);
    expect(out).toMatch(/class="sas-msg__bubble" lang="he" dir="rtl"/);
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
    const itemCount = SELLER_NAV.flatMap((g) => g.items).length;
    expect(out.match(/class="sas-nav__item"/g)).toHaveLength(itemCount);
  });
});
