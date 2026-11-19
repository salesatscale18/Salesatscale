/**
 * The no-cost voice harness (live voice): a PGlite database with the real
 * migrations and a seeded account, the REAL voice relay (lib/voice/socket.ts
 * on a `ws` server) with the free scripted model, and a page with the REAL
 * call component (harness-page.tsx, bundled with esbuild). Nothing here calls
 * a paid API: VOICE_REALTIME is forced to "scripted".
 *
 * Start it: `npx tsx scripts/voice-harness.ts` (prints the URL), or drive it
 * with `npx tsx tests/e2e/voice/harness-run.ts` (Chromium, screenshots).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, listVersions, saveDraftPlaybook } from "@/lib/agent/service";
import { SCENARIOS } from "@/lib/agent/scenarios";
import { createVoiceSession, saveDraftVoiceSettings, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { ROUTE_END_MARGIN_SEC, ROUTE_MAX_DURATION_SEC } from "@/lib/voice/socket-limits";
import { DEFAULT_VOICE_MODEL, maxCallSeconds, resolveVoiceSettings, voiceCapabilities } from "@/lib/voice/settings";
import { createTestDb } from "../../helpers/db";
import { seedCatalog, seedPricing } from "../../helpers/pricing";
import { attachVoiceSockets } from "../../../scripts/voice-ws";

const ROOT = path.resolve(__dirname, "../../..");
/** The only mode the harness runs. */
const ENV = { VOICE_REALTIME: "scripted" } as const;
/** The harness mimics the Vercel route: the same deployment cap the real pages and relay use (4 min 30 s). */
const CAP = ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC;

async function bundlePage(): Promise<string> {
  const r = await build({
    entryPoints: [path.join(__dirname, "harness-page.tsx")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"), sourcemap: "inline", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: "globalThis.process ??= { env: {} };" },
  });
  return r.outputFiles[0].text;
}

const HARNESS_CSS = `
body { margin: 0; }
.hx-main { padding: 20px 32px 32px; }
.hx-page { display: flex; gap: 20px; align-items: flex-start; }
.hx-call { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hx-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; border-block-end: 1px solid var(--line); }
.hx-when { margin-inline-start: auto; }
.hx-side { width: 340px; flex: none; display: flex; flex-direction: column; gap: 16px; }
.hx-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px 28px; }
.hx-cell { display: flex; flex-direction: column; gap: 8px; }
.hx-scrim { position: absolute; inset: 0; background: rgba(15, 20, 32, 0.18); pointer-events: auto; }
@media (max-width: 767px) {
  .hx-main { padding: 0; }
  .hx-page { flex-direction: column; gap: 12px; }
  .hx-side { width: 100%; padding: 0 12px 12px; box-sizing: border-box; }
  .hx-call { border-radius: 0; border-inline: 0; }
  .hx-grid { grid-template-columns: minmax(0, 1fr); padding: 12px; }
}
`;

const HTML = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice harness</title><link rel="stylesheet" href="/sas.css"><style>${HARNESS_CSS}</style></head>
<body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

export type Harness = { url: string; server: Server; close: () => Promise<void>; accountId: string; summary: (conversationId: string) => ReturnType<typeof voiceSessionSummary> };

/** Starts the harness on `port` (0 = any free port). */
export async function startVoiceHarness(o: { port?: number } = {}): Promise<Harness> {
  const t = await createTestDb();
  const db = t.db;
  const [me] = await db.insert(users).values({ clerkId: "harness", email: "harness@voice.test", firstName: "Harness", role: "super_admin" }).returning();
  const p = parseCreateAccount({
    tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100",
    ownerName: "Owner", ownerEmail: "owner@acme.test",
  });
  if (!p.ok) throw new Error("account input");
  const acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [
    { sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" },
    { sku: "SETUP", name: "Setup help", unit: "site", kind: "service" },
  ]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }, { sku: "SETUP", oneTime: 20_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  const draft = await ensureDraftVersion(db, acc);
  await saveDraftPlaybook(db, acc, { ...draft.playbook, maxDiscountBp: 700 });

  const js = await bundlePage();
  const css = fs.readFileSync(path.join(ROOT, "components/sas/sas.css"), "utf8");
  const scenarios = Object.fromEntries(SCENARIOS.filter((s) => s.language === "en").map((s) => [s.id, { title: s.title, expected: s.expected }]));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, type: string, data: string) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(data);
      if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", HTML);
      if (req.method === "GET" && url.pathname === "/harness.js") return send(200, "text/javascript; charset=utf-8", js);
      if (req.method === "GET" && url.pathname === "/sas.css") return send(200, "text/css; charset=utf-8", css);
      if (req.method === "GET" && url.pathname === "/api/config") {
        const d = (await listVersions(db, acc)).find((v) => v.status === "draft")!;
        const model = url.searchParams.get("model") ?? DEFAULT_VOICE_MODEL;
        return send(200, "application/json", JSON.stringify({
          version: d.version, versionLabel: `v${d.version} Draft`, caps: voiceCapabilities(model), settings: resolveVoiceSettings(d.voiceSettings), scenarios,
          fx: { currency: "ILS", minorPerUsd: 370 }, maxSec: maxCallSeconds({ settings: d.voiceSettings, deadlineSec: CAP, env: ENV }), cap: CAP,
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/call") {
        const input = JSON.parse((await body(req)) || "{}") as { scenario?: string };
        const c = await startVoiceTestConversation(db, acc, me.id, { scenario: input.scenario ?? null });
        if (!c) return send(500, "application/json", "{}");
        const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: ENV });
        if (!s.ok) return send(409, "application/json", JSON.stringify(s));
        const host = req.headers.host ?? "localhost";
        return send(200, "application/json", JSON.stringify({
          conversationId: c.conversationId, sessionId: s.sessionId, ticket: s.ticket, wsUrl: `ws://${host}/api/voice/socket`, mode: s.mode,
          maxSec: maxCallSeconds({ settings: c.version.voiceSettings, deadlineSec: CAP, env: ENV }),
        }));
      }
      if (req.method === "GET" && url.pathname === "/api/summary") {
        return send(200, "application/json", JSON.stringify(await voiceSessionSummary(db, acc, url.searchParams.get("c") ?? "")));
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const f = new URLSearchParams(await body(req));
        const r = await saveDraftVoiceSettings(db, acc, {
          voice: f.get("voice") ?? "", pace: f.get("pace") ?? "", fillers: f.get("fillers") === "on", maxCallSec: f.get("maxCallSec") ?? "",
        }, ENV);
        return send(200, "application/json", JSON.stringify(r.ok ? { ok: true } : { ok: false, errors: r.errors }));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      console.error("[harness]", e);
      res.writeHead(500).end(String(e));
    }
  });
  attachVoiceSockets(server, { db, env: ENV, deadlineSec: CAP });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    url: `http://127.0.0.1:${port}`, server, accountId: acc,
    summary: (conversationId) => voiceSessionSummary(db, acc, conversationId),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await t.close();
    },
  };
}
