/**
 * Full-use-case simulation (docs/e2e-simulation.md) against a deployed site.
 *
 *   E2E_BASE_URL=https://salesatscale18.vercel.app \
 *   E2E_EMAIL=e2e+clerk_test@salesatscale.test E2E_PASSWORD=... \
 *   npm run test:sim
 *
 * It creates its own seller account ("E2E <run id>") and test data in that
 * environment, so run it only where test data is acceptable.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e/simulation",
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/simulation" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://salesatscale18.vercel.app",
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: "simulation", use: { ...devices["Desktop Chrome"] } }],
});
