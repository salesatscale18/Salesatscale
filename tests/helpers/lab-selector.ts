/**
 * The test lab's "Voice engine" select switched back ON (LAB_ENGINE_SELECTOR = true), for the tests that keep the
 * engine comparison covered while it is off in the code (owner decision, 26 Nov 2026: one engine for every call).
 * Flipping the constant changes exactly these three exports: the constant itself (the page's `engines` prop),
 * labEngineChoice (a platform admin's pick honoured) and labEngineRefused (retired ids refused). Use as
 *   vi.mock("@/lib/voice-classic/engine-choice", async (orig) => (await import("../helpers/lab-selector")).selectorOn(await orig()));
 */
import type * as EngineChoice from "@/lib/voice-classic/engine-choice";

export function selectorOn(m: typeof EngineChoice): typeof EngineChoice {
  return {
    ...m,
    LAB_ENGINE_SELECTOR: true,
    labEngineChoice: (user, posted, env = process.env) => m.labEngineChoice(user, posted, env, true),
    labEngineRefused: (posted) => m.labEngineRefused(posted, true),
  };
}
