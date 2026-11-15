import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePaymentsEnabled } from "@/lib/payments/mode";

describe("payments mode", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("test payments are on by default and off only when PAYMENTS_MODE=live", () => {
    vi.stubEnv("PAYMENTS_MODE", "");
    expect(fakePaymentsEnabled()).toBe(true);
    vi.stubEnv("PAYMENTS_MODE", "test");
    expect(fakePaymentsEnabled()).toBe(true);
    vi.stubEnv("PAYMENTS_MODE", " LIVE ");
    expect(fakePaymentsEnabled()).toBe(false);
  });
  it("the fake webhook answers 404 in live mode, before reading anything", async () => {
    vi.stubEnv("PAYMENTS_MODE", "live");
    const { POST } = await import("@/app/api/payments/fake/route");
    const res = await POST(new Request("http://x/api/payments/fake", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
