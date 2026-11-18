/**
 * A server module that imports a plain value (an array, a helper) from a "use client" file gets a
 * client reference, not the value. That took /setup/catalog down in production
 * ("ITEM_TABS.includes is not a function"). Components and types are fine to import.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
const isClient = (src: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(src);

describe("server/client boundary", () => {
  it("no server module imports a non-component value from a \"use client\" file", () => {
    const files = [...walk("app"), ...walk("components"), ...walk("lib")];
    const clientValues = new Map<string, Set<string>>();
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      if (!isClient(src)) continue;
      // Exported values whose name is not a component (components start with a capital and aren't ALL_CAPS).
      const names = [...src.matchAll(/export (?:const|let|function) ([A-Za-z_]\w*)/g)].map((m) => m[1]).filter((n) => !/^[A-Z]/.test(n) || /^[A-Z0-9_]+$/.test(n));
      clientValues.set(f.replace(/\.(ts|tsx)$/, ""), new Set(names));
    }
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      if (isClient(src)) continue;
      for (const m of src.matchAll(/import \{([^}]*)\} from "([^"]+)"/g)) {
        const spec = m[2];
        const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.normalize(path.join(path.dirname(f), spec)) : null;
        const values = base ? clientValues.get(base) : undefined;
        if (!values) continue;
        for (const raw of m[1].split(",")) {
          const n = raw.trim();
          if (!n || n.startsWith("type ")) continue;
          const name = n.split(/\s+as\s+/)[0];
          if (values.has(name)) bad.push(`${f} imports ${name} from ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
