import { describe, expect, it } from "vitest";
import { withoutInternalIds } from "@/lib/voice/result-ids";

const ID = "9da6f888-1c2b-4c1e-9d6e-0a1b2c3d4e5f";

describe("withoutInternalIds (A1: what the model gets on a guarded call)", () => {
  it("drops create_quote's quote_id and quote_message_id and keeps everything else in order", () => {
    const r = { ok: true, quote: "Q-1005 v1", status: "ready", quote_message_id: ID, quote_id: ID, quote_version: 1, message: "m", say_this: "s" };
    const out = withoutInternalIds(r);
    expect(out).toEqual({ ok: true, quote: "Q-1005 v1", status: "ready", quote_version: 1, message: "m", say_this: "s" });
    expect(Object.keys(out)).toEqual(["ok", "quote", "status", "quote_version", "message", "say_this"]);
    // The tool's own result is untouched (stored rows and the browser use it).
    expect(r.quote_id).toBe(ID);
  });

  it("drops a uuid at any depth (an id field, an array element), never an app reference such as an offer id or a quote number", () => {
    const out = withoutInternalIds({
      offer: { offer_id: "OF-3fa2c1", quote_ref: ID, terms: "5% off" },
      facts: [{ id: ID, fact: "f" }],
      ids: [ID, "Q-7"],
      quote_id: "Q-7",
      note: `see ${ID}`,
    });
    expect(out).toEqual({ offer: { offer_id: "OF-3fa2c1", terms: "5% off" }, facts: [{ fact: "f" }], ids: ["Q-7"], note: `see ${ID}` });
  });
});
