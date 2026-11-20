/**
 * Voice relay sockets on a plain Node HTTP server (live voice), for the local
 * dev server and the no-cost harness: `upgradeWebSocket` only works on
 * Vercel, so locally a `ws` server runs the same handler (lib/voice/socket.ts).
 */
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Db } from "@/db/types";
import { MAX_CLIENT_AUDIO_BYTES } from "@/lib/voice/protocol";
import type { RealtimeModel } from "@/lib/voice/realtime";
import type { VoiceLimits } from "@/lib/voice/engine";
import { handleVoiceSocket } from "@/lib/voice/socket";

/**
 * Accepts WebSocket upgrades on `path` and runs each as a voice call. `deadlineSec`: a hosting cap to mimic (none by default).
 * `makeModel`: the harness's own scripted model per call (it reads what the model received); else the mode's model.
 * `limits`: the harness's call timings per call (shorter standby to see it); else the product's.
 */
export function attachVoiceSockets(server: Server, o: {
  db: Db; path?: string; env?: Record<string, string | undefined>; deadlineSec?: number | null; makeModel?: () => RealtimeModel;
  limits?: () => Omit<VoiceLimits, "deadlineSec" | "env"> | undefined;
}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_AUDIO_BYTES + 1024 });
  const path = o.path ?? "/api/voice/socket";
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleVoiceSocket(ws, { db: o.db, deadlineSec: o.deadlineSec ?? null, env: o.env, ...(o.makeModel ? { model: o.makeModel() } : {}), limits: o.limits?.() });
    });
  });
  return wss;
}
