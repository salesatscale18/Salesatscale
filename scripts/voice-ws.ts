/**
 * Voice relay sockets on a plain Node HTTP server (live voice), for the local
 * dev server and the no-cost harness: `upgradeWebSocket` only works on
 * Vercel, so locally a `ws` server runs the same handler (lib/voice/socket.ts).
 */
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Db } from "@/db/types";
import { MAX_CLIENT_AUDIO_BYTES } from "@/lib/voice/protocol";
import { handleVoiceSocket } from "@/lib/voice/socket";

/** Accepts WebSocket upgrades on `path` and runs each as a voice call. Calls have no hosting deadline here. */
export function attachVoiceSockets(server: Server, o: { db: Db; path?: string; env?: Record<string, string | undefined> }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_AUDIO_BYTES + 1024 });
  const path = o.path ?? "/api/voice/socket";
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleVoiceSocket(ws, { db: o.db, deadlineSec: null, env: o.env });
    });
  });
  return wss;
}
