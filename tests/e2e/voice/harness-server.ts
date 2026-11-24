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
import { eq } from "drizzle-orm";
import { conversations, rateLimits, sellerAccounts, users } from "@/db/schema";
import { translator } from "@/lib/i18n";
import { buyerChat, chatNames, createSimulatedBuyer, receiveSimulatorInbound, resolveChatLink, startSimulatorConversation } from "@/lib/simulator/service";
import { brandVars, buyerBubbleColor } from "@/lib/simulator/rules";
import { buyerConversation, buyerVoiceGate, buyerVoiceState, startBuyerVoiceCall } from "@/lib/voice/buyer";
import { textTurnBlocked } from "@/lib/voice/one-agent";
import { chatStrings } from "../../../app/chat/[token]/strings";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, listVersions, publishDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import { SCENARIOS } from "@/lib/agent/scenarios";
import { createVoiceSession, saveDraftVoiceSettings, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { ROUTE_END_MARGIN_SEC, ROUTE_MAX_DURATION_SEC } from "@/lib/voice/socket-limits";
import { DEFAULT_VOICE_MODEL, maxCallSeconds, resolveVoiceSettings, versionModelId, voiceModelLabel } from "@/lib/voice/settings";
import { voiceModelChoices } from "@/lib/voice/model-choices";
import { voiceSettingsSummary } from "@/lib/voice/lab";
import { createTestDb } from "../../helpers/db";
import { seedCatalog, seedPricing } from "../../helpers/pricing";
import { attachVoiceSockets } from "../../../scripts/voice-ws";
import { ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { voiceTabKey } from "@/lib/voice/tab-key";

const ROOT = path.resolve(__dirname, "../../..");
/** The only mode the harness runs. */
const ENV = { VOICE_REALTIME: "scripted" } as const;
/** The harness mimics the Vercel route: the same deployment cap the real pages and relay use (4 min 30 s). */
const CAP = ROUTE_MAX_DURATION_SEC - ROUTE_END_MARGIN_SEC;

async function bundlePage(entry = "harness-page.tsx"): Promise<{ js: string; css: string }> {
  const r = await build({
    entryPoints: [path.join(__dirname, entry)], outdir: path.join(ROOT, ".harness-out"),
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"), sourcemap: "inline", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' },
    // "use server" modules (the chat page's actions) are server references in Next.js: a stub here, not server code.
    plugins: [{
      name: "server-actions-stub",
      setup(b) {
        b.onResolve({ filter: /^\.\/(?:reach-)?actions$/ }, (args) => (args.importer.includes(`${path.sep}app${path.sep}chat${path.sep}`) ? { path: path.join(__dirname, "stub-server-actions.ts") } : undefined));
      },
    }],
    banner: { js: "globalThis.process ??= { env: {} };" },
  });
  return {
    js: r.outputFiles.find((f) => f.path.endsWith(".js"))!.text,
    css: r.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n"),
  };
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

const BUYER_HTML = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buyer chat harness</title><link rel="stylesheet" href="/buyer.css"><style>body{margin:0}</style></head>
<body><div id="root"></div><script type="module" src="/buyer.js"></script></body></html>`;

const FORM_HTML = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order form harness</title><link rel="stylesheet" href="/form.css"><style>body{margin:0}</style></head>
<body><div id="root"></div><script type="module" src="/form.js"></script></body></html>`;

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

export type Harness = { url: string; server: Server; close: () => Promise<void>; accountId: string; buyers: Record<string, { token: string; conversationId: string }>; summary: (conversationId: string) => ReturnType<typeof voiceSessionSummary> };

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

  const { js } = await bundlePage();
  const buyerBundle = await bundlePage("buyer-page.tsx");
  const formBundle = await bundlePage("form-page.tsx");
  const chatCss = fs.readFileSync(path.join(ROOT, "app/chat/[token]/chat.css"), "utf8");
  const bubbleCss = fs.readFileSync(path.join(ROOT, "components/sas/voice/voice-bubble.css"), "utf8");
  const formCss = fs.readFileSync(path.join(ROOT, "app/f/[token]/buyer.css"), "utf8");
  // Each call's scripted model, so /api/notes can show what the model was told (the order form's step).
  const models: ScriptedRealtime[] = [];
  // Standby timings for calls started from now on (/api/limits?fast=1: see standby and the idle end in seconds).
  let fastStandby = false;
  // Transcription markers from the scripted model for calls started from now on (/api/markers?mode=with_text|only|off).
  let markers: "with_text" | "only" | undefined;
  // Buyers (release 2): an English chat, and a Hebrew page whose conversation is in English (the call bar in RTL).
  const ALWAYS = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
  let gateEnv: Record<string, string | undefined> = ENV;
  await db.update(sellerAccounts).set({ status: "live", voiceBuyerCallsOff: false, allowSimulatedBuyers: true, contactHours: ALWAYS })
    .where(eq(sellerAccounts.id, acc));
  await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
  await ensureDraftVersion(db, acc);
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
  const buyers: Record<string, { token: string; conversationId: string }> = {};
  for (const [lang, name] of [["en", "Dana Cohen"], ["he", "דנה כהן"]] as const) {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, account, { fullName: name, company: "Cohen Shop", language: lang, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc, made.lead.id);
    if (!started.ok) throw new Error(`buyer start ${started.reason}`);
    // The scripted model plays the ready buyer's call; the Hebrew page's conversation is English so the call is offered.
    await db.update(conversations).set({ scenario: "ready_buyer", language: "en" }).where(eq(conversations.id, started.conversationId));
    buyers[lang] = { token: made.token, conversationId: started.conversationId };
  }
  // A buyer whose chat has not started (a link, no conversation): /buyer?who=empty. Voice starts the conversation.
  const emptyMade = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, account, { fullName: "Noa Levi", company: "Levi Shop", language: "en", country: "IL" });
  if (!emptyMade.ok) throw new Error("empty buyer");
  const emptyToken = emptyMade.token;
  const css = fs.readFileSync(path.join(ROOT, "components/sas/sas.css"), "utf8");
  const scenarios = Object.fromEntries(SCENARIOS.filter((s) => s.language === "en").map((s) => [s.id, { title: s.title, expected: s.expected }]));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, type: string, data: string) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(data);
      if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", HTML);
      if (req.method === "GET" && url.pathname === "/harness.js") return send(200, "text/javascript; charset=utf-8", js);
      if (req.method === "GET" && url.pathname === "/sas.css") return send(200, "text/css; charset=utf-8", css);
      if (req.method === "GET" && url.pathname === "/buyer") return send(200, "text/html; charset=utf-8", BUYER_HTML);
      if (req.method === "GET" && url.pathname === "/buyer.js") return send(200, "text/javascript; charset=utf-8", buyerBundle.js);
      if (req.method === "GET" && url.pathname === "/buyer.css") return send(200, "text/css; charset=utf-8", `${css}\n${chatCss}\n${bubbleCss}\n${buyerBundle.css}`);
      if (req.method === "GET" && url.pathname === "/form") return send(200, "text/html; charset=utf-8", FORM_HTML);
      if (req.method === "GET" && url.pathname === "/form.js") return send(200, "text/javascript; charset=utf-8", formBundle.js);
      if (req.method === "GET" && url.pathname === "/form.css") return send(200, "text/css; charset=utf-8", `${formCss}\n${bubbleCss}\n${formBundle.css}`);
      if (req.method === "GET" && url.pathname === "/api/form-config") {
        // The order form tab of a buyer's conversation: the same key the chat page gets (lib/voice/tab-key.ts).
        const lang = url.searchParams.get("lang") === "he" ? "he" : "en";
        const link = await resolveChatLink(db, buyers[lang].token);
        if (!link) return send(404, "application/json", "{}");
        const names = await chatNames(db, link.ctx.account, lang);
        return send(200, "application/json", JSON.stringify({
          lang, tabKey: voiceTabKey(buyers[lang].conversationId), agentName: (await chatNames(db, link.ctx.account, "en")).agent, seller: names.seller,
          rootStyle: brandVars(link.ctx.brandColor),
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/reset-rate-limits") {
        // Harness only: a buyer link allows 6 calls an hour; the sections below make more than that on the same links.
        await db.delete(rateLimits);
        return send(200, "application/json", "{}");
      }
      if (req.method === "POST" && url.pathname === "/api/markers") {
        const m = url.searchParams.get("mode");
        markers = m === "with_text" || m === "only" ? m : undefined;
        return send(200, "application/json", "{}");
      }
      if (req.method === "POST" && url.pathname === "/api/limits") {
        fastStandby = url.searchParams.get("fast") === "1";
        return send(200, "application/json", "{}");
      }
      if (req.method === "GET" && url.pathname === "/api/notes") {
        // What the last call's model was told about the order form (notes it does not answer).
        return send(200, "application/json", JSON.stringify(models.at(-1)?.connections.flatMap((c) => c.notes) ?? []));
      }
      if (req.method === "POST" && url.pathname === "/api/buyer-gate") {
        // Harness only: turn one gate off (or reset all) to show why the button is disabled on a simulated chat.
        const which = url.searchParams.get("off") ?? "";
        const convIds = Object.values(buyers).map((b) => b.conversationId);
        await db.update(sellerAccounts).set({ voiceBuyerCallsOff: false, status: "live", monthlySpendCapMinor: 10_000, contactHours: ALWAYS }).where(eq(sellerAccounts.id, acc));
        for (const id of convIds) await db.update(conversations).set({ status: "open", language: "en" }).where(eq(conversations.id, id));
        gateEnv = ENV;
        if (which === "buyer_calls_off") await db.update(sellerAccounts).set({ voiceBuyerCallsOff: true }).where(eq(sellerAccounts.id, acc));
        if (which === "account_not_live") await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, acc));
        if (which === "not_agent") for (const id of convIds) await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, id));
        if (which === "spend_cap") {
          // Only the gate runs in "live" mode here (it reads the cap); no call is started and nothing is paid.
          await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
          gateEnv = { VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "harness-gate-only" };
        }
        return send(200, "application/json", "{}");
      }
      if (req.method === "GET" && url.pathname === "/api/buyer-config") {
        const lang = url.searchParams.get("lang") === "he" ? "he" : "en";
        const empty = url.searchParams.get("who") === "empty";
        const token = empty ? emptyToken : buyers[lang].token;
        const link = await resolveChatLink(db, token);
        if (!link) return send(404, "application/json", "{}");
        const ctx = link.ctx;
        const conv = await buyerConversation(db, ctx);
        const tr = translator(lang);
        const names = await chatNames(db, ctx.account, lang);
        const chat = await buyerChat(db, ctx);
        const gate = await buyerVoiceGate(db, ctx, { env: gateEnv });
        chat.voice = buyerVoiceState(gate, ctx.lead);
        return send(200, "application/json", JSON.stringify({
          token, lang, seller: names.seller, initials: names.seller.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
          strings: chatStrings(tr, names, lang), initial: chat, timeZone: "Asia/Jerusalem",
          voice: { agentName: (await chatNames(db, ctx.account, "en")).agent, gender: names.gender, tabKey: conv ? voiceTabKey(conv.id) : null },
          rootStyle: { ...brandVars(ctx.brandColor), "--bubble": buyerBubbleColor(ctx.brandColor) },
        }));
      }
      const chatPath = /^\/chat\/([^/]+)\/(messages|voice)$/.exec(url.pathname);
      if (chatPath) {
        // The same functions as app/chat/[token]/messages and ./voice (no agent reply: no model call).
        const link = await resolveChatLink(db, decodeURIComponent(chatPath[1]));
        if (!link || link.state !== "live") return send(404, "application/json", JSON.stringify({ ok: false, reason: "not_found" }));
        const ctx = link.ctx;
        if (chatPath[2] === "voice") {
          await body(req);
          const r = await startBuyerVoiceCall(db, ctx, chatPath[1], { deadlineSec: CAP, env: gateEnv === ENV ? ENV : gateEnv });
          if (!r.ok) {
            const shown = r.gate ? buyerVoiceState({ ok: false, reason: r.gate }, ctx.lead) : null;
            return send(409, "application/json", JSON.stringify({ ok: false, reason: r.reason, ...(shown?.reason ? { gate: shown.reason } : {}) }));
          }
          return send(200, "application/json", JSON.stringify({ ...r, wsUrl: `ws://${req.headers.host}/api/voice/socket` }));
        }
        if (req.method === "POST") {
          const b = JSON.parse((await body(req)) || "{}") as { text?: string; clientId?: string };
          const conv = await buyerConversation(db, ctx);
          // As the route (app/chat/[token]/messages/route.ts): one agent at a time.
          if (conv && (await textTurnBlocked(db, ctx.account.id, conv.id, "typed message"))) return send(409, "application/json", JSON.stringify({ ok: false, reason: "in_call" }));
          await receiveSimulatorInbound(db, ctx, b.text ?? "", b.clientId ?? "");
          return send(200, "application/json", JSON.stringify({ ok: true }));
        }
        const [chat, gate] = await Promise.all([buyerChat(db, ctx, { after: url.searchParams.get("after") }), buyerVoiceGate(db, ctx, { env: gateEnv })]);
        return send(200, "application/json", JSON.stringify({ ...chat, voice: buyerVoiceState(gate, ctx.lead) }));
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const d = (await listVersions(db, acc)).find((v) => v.status === "draft")!;
        const model = url.searchParams.get("model") ?? DEFAULT_VOICE_MODEL;
        return send(200, "application/json", JSON.stringify({
          version: d.version, versionLabel: `v${d.version} Draft`, models: voiceModelChoices(), platformModel: model, settings: resolveVoiceSettings(d.voiceSettings, versionModelId(d.voiceSettings, { VOICE_MODEL: model })), scenarios,
          summary: voiceSettingsSummary(resolveVoiceSettings(d.voiceSettings, versionModelId(d.voiceSettings, { VOICE_MODEL: model })), versionModelId(d.voiceSettings, { VOICE_MODEL: model })),
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
          model: voiceModelLabel(versionModelId(c.version.voiceSettings, {})),
        }));
      }
      if (req.method === "GET" && url.pathname === "/api/summary") {
        return send(200, "application/json", JSON.stringify(await voiceSessionSummary(db, acc, url.searchParams.get("c") ?? "")));
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const f = new URLSearchParams(await body(req));
        const r = await saveDraftVoiceSettings(db, acc, {
          model: f.get("model") ?? "", voice: f.get("voice") ?? "", pace: f.get("pace") ?? "", style: f.get("style") ?? "",
          pauseMs: f.get("pauseMs") ?? "", interrupt: f.get("interrupt") ?? "", fillers: f.get("fillers") === "on", maxCallSec: f.get("maxCallSec") ?? "",
          speech: f.get("speech") ?? "",
        }, ENV, { canPickSpeech: true });
        return send(200, "application/json", JSON.stringify(r.ok ? { ok: true } : { ok: false, errors: r.errors }));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      console.error("[harness]", e);
      res.writeHead(500).end(String(e));
    }
  });
  attachVoiceSockets(server, { db, env: ENV, deadlineSec: CAP, limits: () => (fastStandby ? { standbyAfterQuietMs: 3_000, standbyIdleEndMs: 8_000 } : undefined), makeModel: () => {
    const m = new ScriptedRealtime({ markers });
    models.push(m);
    return m;
  } });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return {
    url: `http://127.0.0.1:${port}`, server, accountId: acc, buyers,
    summary: (conversationId) => voiceSessionSummary(db, acc, conversationId),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await t.close();
    },
  };
}
