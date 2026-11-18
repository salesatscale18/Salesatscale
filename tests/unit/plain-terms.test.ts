import { describe, expect, it } from "vitest";
import { currencyLabel, currencyName, regionName, timezoneLabel, zonePlainName } from "@/lib/format";

const winter = new Date("2026-11-18T12:00:00Z");
const summer = new Date("2026-07-01T12:00:00Z");

describe("time zone label (7.1.1)", () => {
  it("keeps the IANA name, adds a plain name and the current offset", () => {
    expect(timezoneLabel("Asia/Jerusalem", winter)).toBe("Israel time · Asia/Jerusalem (GMT+2)");
    expect(timezoneLabel("Asia/Jerusalem", summer)).toBe("Israel time · Asia/Jerusalem (GMT+3)");
    expect(timezoneLabel("America/New_York", winter)).toBe("Eastern time · America/New_York (GMT-5)");
    expect(zonePlainName("Europe/London", winter)).toBe("United Kingdom time");
  });
  it("UTC, zones without a plain name and bad values", () => {
    expect(timezoneLabel("UTC", winter)).toBe("UTC");
    expect(timezoneLabel("Etc/GMT+5", winter)).toBe("Etc/GMT+5 (GMT-5)");
    expect(timezoneLabel("Not/AZone", winter)).toBe("UTC");
  });
});

describe("currency label (7.1.2)", () => {
  it("code, plain name and symbol", () => {
    expect(currencyLabel("ILS")).toBe("ILS · Israeli shekel (₪)");
    expect(currencyLabel("USD")).toBe("USD · US dollar ($)");
    expect(currencyLabel("EUR")).toBe("EUR · Euro (€)");
    expect(currencyLabel("GBP")).toBe("GBP · British pound (£)");
    expect(currencyName("gbp")).toBe("British pound");
  });
  it("unknown codes stay as they are", () => {
    expect(currencyLabel("XYZ")).toBe("XYZ");
  });
});

describe("region name (7.1.8)", () => {
  it("names a country code", () => {
    expect(regionName("IL")).toBe("Israel");
    expect(regionName("us")).toBe("United States");
  });
});
