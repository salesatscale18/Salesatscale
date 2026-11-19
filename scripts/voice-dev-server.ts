/**
 * Local voice relay for development (live voice): `upgradeWebSocket` in
 * app/api/voice/socket only works on Vercel, so with `next dev` run this next
 * to it and point the app at it:
 *
 *   VOICE_REALTIME=scripted npx tsx scripts/voice-dev-server.ts      # ws://localhost:8787/api/voice/socket
 *   VOICE_WS_URL=ws://localhost:8787/api/voice/socket npm run dev
 *
 * It uses DATABASE_URL like the app (.env.local, then .env). Keep
 * VOICE_REALTIME=scripted: a live call spends money and needs the owner's
 * approval first (CLAUDE.md, "AI spend").
 */
import { createServer } from "node:http";
import { config } from "dotenv";
import { attachVoiceSockets } from "./voice-ws";

config({ path: ".env.local" });
config();

async function main() {
  const { db } = await import("@/db");
  const { voiceMode } = await import("@/lib/voice/settings");
  const port = Number(process.env.VOICE_DEV_PORT || 8787);
  if (voiceMode() === "off") console.warn("[voice-dev] VOICE_REALTIME is off: every call will be refused. Set VOICE_REALTIME=scripted.");
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("Voice relay: connect with a WebSocket.\n");
  });
  attachVoiceSockets(server, { db });
  server.listen(port, () => console.log(`[voice-dev] ws://localhost:${port}/api/voice/socket (mode ${voiceMode()})`));
}

void main();
