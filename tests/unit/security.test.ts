import { describe, expect, it } from "vitest";
import { isUuid } from "@/lib/security/ids";
import { clientIp, declaredTooLarge, hashKey } from "@/lib/security/rate-limit";

describe("isUuid", () => {
  it("accepts uuids and refuses everything else", () => {
    expect(isUuid("3f1c9a52-8a4e-4b7e-9d2a-1c2b3d4e5f60")).toBe(true);
    expect(isUuid("3F1C9A52-8A4E-4B7E-9D2A-1C2B3D4E5F60")).toBe(true);
    for (const bad of ["", "nope", "3f1c9a52-8a4e-4b7e-9d2a-1c2b3d4e5f6", "3f1c9a52-8a4e-4b7e-9d2a-1c2b3d4e5f60x", "' or 1=1 --", null, undefined, 42]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe("request helpers", () => {
  it("takes the first x-forwarded-for address", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("flags a declared Content-Length over the limit only", () => {
    expect(declaredTooLarge(new Headers({ "content-length": "40000" }), 32 * 1024)).toBe(true);
    expect(declaredTooLarge(new Headers({ "content-length": "100" }), 32 * 1024)).toBe(false);
    expect(declaredTooLarge(new Headers(), 32 * 1024)).toBe(false);
    expect(declaredTooLarge(new Headers({ "content-length": "abc" }), 32 * 1024)).toBe(false);
  });

  it("hashes secrets used in keys", () => {
    expect(hashKey("secret-token")).toMatch(/^[0-9a-f]{32}$/);
    expect(hashKey("secret-token")).not.toContain("secret");
    expect(hashKey("a")).not.toBe(hashKey("b"));
  });
});
