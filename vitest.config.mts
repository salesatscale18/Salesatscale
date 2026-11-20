import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    // PGlite boots a Postgres instance in-process; the first one can take a few seconds.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // WhatsApp is off by default in the app (WHATSAPP_ENABLED unset). The WhatsApp suites test the channel
    // itself, so it is on here; tests of the default stub it off (vi.stubEnv("WHATSAPP_ENABLED", "")).
    env: { WHATSAPP_ENABLED: "1" },
  },
});
