import { describe, expect, it } from "vitest";
import { displayName, personName } from "@/lib/auth/display";

describe("people are never shown as a full email", () => {
  const nameless = { id: "u1", firstName: null, lastName: null, email: "testuser+clerk_test@salesatscale.com" };
  it("falls back to the email's local part without the +tag", () => {
    expect(displayName(nameless)).toBe("testuser");
    expect(personName(nameless)).toBe("testuser");
  });
  it("uses the name when there is one", () => {
    expect(displayName({ firstName: "Dana", lastName: "Levi", email: "d@x.test" })).toBe("Dana Levi");
  });
});
