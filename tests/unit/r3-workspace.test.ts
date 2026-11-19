/** Round-3 review, lane R3-1: pure parts (next step, deal pane, sorting, inbox groups, Ordered, thread scroll). */
import { describe, expect, it } from "vitest";
import { dealPaneView, nextStepText } from "@/lib/leads/deal-pane";
import { ariaSort, nextSort, parseSort } from "@/lib/domain/table-sort";
import { inboxGroup } from "@/lib/conversations/inbox";
import { displayQuoteStatus } from "@/lib/quotes/service";
import { scrollThreadToEnd } from "@/app/app/[account]/conversations/scroll-end";

const base = { tradeName: "Polar Demo", buyerName: "Noa Cohen", agentNextStep: "quote on assumption of 1 site" };

describe("next step (A2)", () => {
  it("after the sale: the order's state", () => {
    expect(nextStepText({ ...base, latestOrder: { order: { number: 10001, paymentStatus: "paid" } }, stage: { stage: "after" } })).toBe("Order PD-10001 is paid. Next: delivery.");
    expect(nextStepText({ ...base, latestOrder: { order: { number: 10001, paymentStatus: "not_started" } }, stage: { stage: "after" } })).toBe("Order PD-10001 is signed. Waiting for the payment.");
  });
  it("form out or quote out: from the stage, not the agent's stale text", () => {
    expect(nextStepText({ ...base, latestOrder: null, stage: { stage: "after" } })).toBe("Waiting for Noa to sign and pay.");
    expect(nextStepText({ ...base, latestOrder: null, stage: { stage: "order_form" } })).toBe("Waiting for Noa to accept the quote. Then the agent sends the order form.");
  });
  it("earlier stages keep the agent's words, as a sentence", () => {
    for (const stage of ["open", "understand", "recommend", "quote_close"] as const) {
      expect(nextStepText({ ...base, latestOrder: null, stage: { stage } })).toBe("Quote on assumption of 1 site.");
    }
    expect(nextStepText({ ...base, latestOrder: null, stage: null })).toBe("Quote on assumption of 1 site.");
    expect(nextStepText({ ...base, agentNextStep: null, latestOrder: null, stage: null })).toBeNull();
  });
});

describe("deal pane (A1)", () => {
  const playbook = { fields: [
    { key: "sites", label: "Number of sites", stage: "before_quote" as const },
    { key: "how", label: "How they check", stage: "before_quote" as const },
    { key: "company_name", label: "Company name", stage: "before_order_form" as const },
    { key: "company_id", label: "Company ID", stage: "before_order_form" as const },
  ] } as never;
  it("known and before-quote fields shown, unknown order-form details grouped, counts", () => {
    const pane = dealPaneView({
      playbook, latestOrder: null, stage: { stage: "understand" }, tradeName: "Polar Demo", buyerName: "Eli",
      deal: { fields: { sites: { value: "1", provenance: "buyer" }, company_id: { value: "5160", provenance: "verified" } } as never, objections: [{ text: "Too pricey", handled: true }], nextStep: "ask how they check" },
    });
    expect(pane.state).toBe("fields");
    expect(pane.shown.map((f) => f.key)).toEqual(["sites", "how", "company_id"]);
    expect(pane.laterUnknown.map((f) => f.key)).toEqual(["company_name"]);
    // R5-1: the phone line counts order-form details only, as desktop does ("how" is a before-quote field).
    expect(pane.missingCount).toBe(1);
    expect(pane.missingCount).toBe(pane.laterUnknown.length);
    expect(pane.objections).toHaveLength(1);
    expect(pane.nextStep).toBe("Ask how they check.");
  });
  it("no playbook yet, or one with no fields", () => {
    const none = { latestOrder: null, stage: null, tradeName: "P", buyerName: "E", deal: null };
    expect(dealPaneView({ ...none, playbook: null }).state).toBe("pending");
    expect(dealPaneView({ ...none, playbook: { fields: [] } as never }).state).toBe("none");
  });
});

describe("table sort (C)", () => {
  const keys = ["lead", "activity"] as const;
  const def = { key: "activity" as const, dir: "desc" as const };
  it("parses the URL, falling back on unknown keys", () => {
    expect(parseSort("lead", "desc", keys, def)).toEqual({ key: "lead", dir: "desc" });
    expect(parseSort("lead", "sideways", keys, def)).toEqual({ key: "lead", dir: "asc" });
    expect(parseSort("drop table", "asc", keys, def)).toEqual(def);
    expect(parseSort(undefined, undefined, keys, def)).toEqual(def);
  });
  it("same column flips; another starts at its natural direction; aria-sort", () => {
    expect(nextSort({ key: "lead", dir: "asc" }, "lead", "asc")).toEqual({ key: "lead", dir: "desc" });
    expect(nextSort({ key: "lead", dir: "asc" }, "activity", "desc")).toEqual({ key: "activity", dir: "desc" });
    expect(ariaSort({ key: "lead", dir: "asc" }, "lead")).toBe("ascending");
    expect(ariaSort({ key: "lead", dir: "desc" }, "lead")).toBe("descending");
    expect(ariaSort({ key: "lead", dir: "asc" }, "activity")).toBe("none");
  });
});

describe("inbox groups (B2)", () => {
  it("a won or lost lead's open chat is Closed; a person holding it still shows as such", () => {
    expect(inboxGroup({ status: "open", takenOverByUserId: null, lastActor: "system", leadStatus: "won" })).toBe("closed");
    expect(inboxGroup({ status: "open", takenOverByUserId: null, lastActor: "agent", leadStatus: "lost" })).toBe("closed");
    expect(inboxGroup({ status: "open", takenOverByUserId: null, lastActor: "agent", leadStatus: "agent_handling" })).toBe("agent");
    expect(inboxGroup({ status: "human", takenOverByUserId: "u", lastActor: "buyer", leadStatus: "won" })).toBe("needs_you");
  });
});

describe("Ordered (B1)", () => {
  it("a quote an order came from shows Ordered, even past its date", () => {
    const until = new Date("2026-11-25T21:59:00Z");
    expect(displayQuoteStatus("sent", until, new Date("2026-11-18T10:00:00Z"), "Asia/Jerusalem", true)).toBe("ordered");
    expect(displayQuoteStatus("sent", until, new Date("2026-12-18T10:00:00Z"), "Asia/Jerusalem", true)).toBe("ordered");
    expect(displayQuoteStatus("sent", until, new Date("2026-11-18T10:00:00Z"), "Asia/Jerusalem")).toBe("sent");
  });
});

describe("thread opens at the latest message (A9)", () => {
  const box = (scrollHeight: number, clientHeight: number) => {
    const into: ScrollIntoViewOptions[] = [];
    return { into, el: { scrollTop: 0, scrollHeight, clientHeight, lastElementChild: { scrollIntoView: (o?: ScrollIntoViewOptions) => { into.push(o ?? {}); } } } };
  };
  it("wide screen: the chat pane scrolls to its bottom", () => {
    const b = box(2400, 600);
    expect(scrollThreadToEnd(b.el)).toBe("pane");
    expect(b.el.scrollTop).toBe(2400);
    expect(b.into).toEqual([]);
  });
  it("phone: the pane does not scroll, so the page brings the latest message into view", () => {
    const b = box(2400, 2400);
    expect(scrollThreadToEnd(b.el)).toBe("page");
    expect(b.into).toEqual([{ block: "end" }]);
    expect(scrollThreadToEnd(null)).toBeNull();
  });
});
