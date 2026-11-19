/**
 * The no-cost voice harness (live voice): the real call component against the
 * real engine on an in-memory database with the free scripted model. No
 * database URL, no Clerk keys, no paid API.
 *
 *   npx tsx scripts/voice-harness.ts            # prints http://127.0.0.1:4777
 *   VOICE_HARNESS_PORT=5000 npx tsx scripts/voice-harness.ts
 *
 * Views: /?view=call&scenario=ready_buyer, /?view=states, /?view=settings
 * (&model=openai/gpt-realtime for the Advanced fold). The automated run with
 * screenshots: `npx tsx tests/e2e/voice/harness-run.ts`.
 */
import { startVoiceHarness } from "../tests/e2e/voice/harness-server";

void startVoiceHarness({ port: Number(process.env.VOICE_HARNESS_PORT || 4777) }).then((h) => {
  console.log(`[voice-harness] ${h.url}  (scripted model, no cost; Ctrl+C to stop)`);
});
