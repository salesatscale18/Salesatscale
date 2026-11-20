import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// JSON.parse keeps the last of two equal keys silently; a merge can leave a duplicate (or bring back a removed key twice).
describe("i18n message files", () => {
  for (const file of ["lib/i18n/messages/en.json", "lib/i18n/messages/he.json"]) {
    it(`${file} has no duplicate keys`, () => {
      const keys = [...readFileSync(file, "utf8").matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
      const seen = new Set<string>();
      const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
      expect(dupes).toEqual([]);
    });
  }
});
