/**
 * Config for the demo rehearsal (tests/e2e/demo/rehearsal.spec.ts). Same
 * settings as playwright.sim.config.ts, but:
 * - testDir is this folder (the sim config only sees tests/e2e/simulation);
 * - Playwright's output goes to test-results/demo-output, because Playwright
 *   empties its output folder at the start of every run, and the rehearsal
 *   keeps its resume state in test-results/rehearsal-state.json.
 *
 *   npx playwright test -c tests/e2e/demo/playwright.config.ts
 */
import path from "node:path";
import { defineConfig } from "@playwright/test";
import sim from "../../../playwright.sim.config";

const root = path.resolve(__dirname, "../../..");

export default defineConfig({
  ...sim,
  testDir: __dirname,
  outputDir: path.join(root, "test-results", "demo-output"),
  reporter: [["list"]],
});
