/**
 * "Play sample" (Voice settings › Voice; lib/voice-rt-eleven/sample.ts behind app/app/[account]/voice-sample): the
 * platform-admin rule, request validation, the storage cache (a hit never calls the speaker; a miss generates once,
 * stores, answers a WAV), concurrent misses sharing one generation, the budget refusal before generating, scripted
 * mode (no gateway, no store), the rate limit; and the form's buttons per model and company languages.
 * Fake speaker and fake store only; no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb, type TestDb } from "../helpers/db";
import { ScriptedSpeaker, type Speaker } from "@/lib/voice-pipeline/speaker";
import { parseSampleRequest, pcmToWav, sampleKey, SAMPLES_PER_MINUTE, voiceSampleResponse, type SampleRequest, type SampleStore } from "@/lib/voice-rt-eleven/sample";
import { SAMPLE_TEXTS, sampleLanguagesFor } from "@/lib/voice-rt-eleven/catalog";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";
import { DEFAULT_VOICE_SETTINGS } from "@/lib/voice/settings";
import { voiceModelChoices } from "@/lib/voice/model-choices";

const TURBO = "elevenlabs/eleven-v4-turbo";
const FLASH = "elevenlabs/eleven-flash-v2.5";
const SARAH = "EXAVITQu4vr4xnSDxMaL";
const LIVE = { VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "test-not-a-key" };
const SCRIPTED = { VOICE_REALTIME: "scripted" };
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

let userSeq = 0;
const admin = () => ({ id: `admin-${++userSeq}`, role: "super_admin" });

function fakeStore(initial: Record<string, Uint8Array> = {}) {
  const m = new Map(Object.entries(initial));
  const puts: string[] = [];
  const store: SampleStore = {
    async get(k) { return m.get(k) ?? null; },
    async put(k, w) { puts.push(k); m.set(k, w); },
  };
  return { store, puts, m };
}

function fakeSpeakers() {
  const made: { req: SampleRequest; speaker: ScriptedSpeaker }[] = [];
  const speakerFor = async (req: SampleRequest): Promise<Speaker> => {
    const s = new ScriptedSpeaker(req.model, { msPerChar: 2, maxMs: 300, delay: () => new Promise((r) => setTimeout(r, 2)) });
    made.push({ req, speaker: s });
    return s;
  };
  return { made, speakerFor };
}

const body = (o: Partial<Record<string, unknown>> = {}) => ({ model: TURBO, voice: SARAH, stability: 1, language: "en", ...o });

describe("the sample route's work", () => {
  it("validation: catalog ids, steadiness, en/he, and Hebrew only for models that speak it", () => {
    expect(parseSampleRequest(body())).toMatchObject({ ok: true });
    expect(parseSampleRequest(body({ model: "elevenlabs/eleven-v9" }))).toEqual({ ok: false, error: "unknown speaking model" });
    expect(parseSampleRequest(body({ voice: "x" }))).toEqual({ ok: false, error: "unknown voice" });
    expect(parseSampleRequest(body({ stability: 0.3 }))).toMatchObject({ ok: false });
    expect(parseSampleRequest(body({ language: "fr" }))).toEqual({ ok: false, error: "language is en or he" });
    expect(parseSampleRequest(body({ model: FLASH, language: "he" }))).toEqual({ ok: false, error: "Flash v2.5 does not speak he" });
    expect(sampleKey({ model: TURBO, voice: SARAH, stability: 0.5, language: "he" })).toBe(`voice-samples/v1/${TURBO}/${SARAH}/he-s0.5.wav`);
    expect(sampleKey({ model: FLASH, voice: SARAH, stability: 0, language: "en" })).toBe(`voice-samples/v1/${FLASH}/${SARAH}/en.wav`);
    for (const t of Object.values(SAMPLE_TEXTS)) expect(t.length).toBeLessThanOrEqual(110);
  });

  it("an admin gets audio; anyone else gets 404; a bad request 400", async () => {
    const { store } = fakeStore();
    const { speakerFor } = fakeSpeakers();
    const ok = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: body() }, { db, env: LIVE, store, speakerFor, log: () => {} });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/wav");
    const seller = await voiceSampleResponse({ user: { id: "s1", role: "user" }, accountId: ACCOUNT, body: body() }, { db, env: LIVE, store, speakerFor });
    expect(seller.status).toBe(404);
    const bad = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: body({ model: FLASH, language: "he" }) }, { db, env: LIVE, store, speakerFor });
    expect(bad.status).toBe(400);
  });

  it("a miss calls the speaker once, stores the WAV and answers it; the next request is a hit (no speaker)", async () => {
    const { store, puts, m } = fakeStore();
    const { made, speakerFor } = fakeSpeakers();
    const logs: string[] = [];
    const b = body({ stability: 0.5, language: "he" });
    const r1 = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: b }, { db, env: LIVE, store, speakerFor, log: (l) => logs.push(l) });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-sample-source")).toBe("generated");
    const wav = new Uint8Array(await r1.arrayBuffer());
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint16(22, true)).toBe(1);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24_000);
    expect(made).toHaveLength(1);
    expect(made[0].speaker.said).toEqual([{ text: SAMPLE_TEXTS.he, language: "he" }]);
    expect(puts).toEqual([`voice-samples/v1/${TURBO}/${SARAH}/he-s0.5.wav`]);
    expect(m.get(puts[0])).toEqual(wav);
    expect(logs).toEqual([`[voice] sample generated model=${TURBO} voice=${SARAH} lang=he chars=${SAMPLE_TEXTS.he.length} costMicros=${SAMPLE_TEXTS.he.length * 40}`]);
    const r2 = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: b }, { db, env: LIVE, store, speakerFor });
    expect(r2.headers.get("x-sample-source")).toBe("stored");
    expect(made).toHaveLength(1);
  });

  it("two concurrent misses for the same sample generate once", async () => {
    const { store, puts } = fakeStore();
    const { made, speakerFor } = fakeSpeakers();
    const b = body({ voice: "21m00Tcm4TlvDq8ikWAM" });
    const [a, c] = await Promise.all([
      voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: b }, { db, env: LIVE, store, speakerFor, log: () => {} }),
      voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: b }, { db, env: LIVE, store, speakerFor, log: () => {} }),
    ]);
    expect([a.status, c.status]).toEqual([200, 200]);
    expect(made).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  it("the platform budget used up: refused before anything is generated", async () => {
    vi.stubEnv("AI_PLATFORM_MONTHLY_BUDGET_USD", "0");
    const { store, puts } = fakeStore();
    const { made, speakerFor } = fakeSpeakers();
    const r = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: body({ voice: "FGY2WhTYpPnrIDTdsKH5" }) }, { db, env: LIVE, store, speakerFor });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "the platform's monthly AI budget is used up" });
    expect(made).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("scripted mode: a tone WAV, no speaker, nothing stored", async () => {
    const { store, puts } = fakeStore();
    const { made, speakerFor } = fakeSpeakers();
    const r = await voiceSampleResponse({ user: admin(), accountId: ACCOUNT, body: body() }, { db, env: SCRIPTED, store, speakerFor });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-sample-source")).toBe("scripted");
    expect(made).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it(`rate limit: ${SAMPLES_PER_MINUTE} a minute per user, then 429`, async () => {
    const user = admin();
    const now = new Date("2026-11-24T10:00:10Z");
    const statuses: number[] = [];
    for (let i = 0; i <= SAMPLES_PER_MINUTE; i++) statuses.push((await voiceSampleResponse({ user, accountId: ACCOUNT, body: body() }, { db, env: SCRIPTED, now })).status);
    expect(statuses.slice(0, SAMPLES_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[SAMPLES_PER_MINUTE]).toBe(429);
  });

  it("pcmToWav: mono 16-bit 24 kHz header", () => {
    const w = pcmToWav(new Uint8Array(480));
    expect(w.byteLength).toBe(524);
    expect(new DataView(w.buffer).getUint32(40, true)).toBe(480);
  });
});

describe("the form's Play sample buttons", () => {
  const render = (elevenModel: string, languages: string[]) => renderToStaticMarkup(
    <VoiceSettingsForm action={async () => ({})} slug="acme" models={voiceModelChoices()} platformModel="google/gemini-3.8-live"
      initial={{ ...DEFAULT_VOICE_SETTINGS, model: "openai/gpt-realtime-mini" as never, speech: "elevenlabs", elevenModel: elevenModel as never }}
      version={3} closeHref="#" deploymentLimitSec={null} languages={languages} />,
  );
  const buttons = (h: string) => [...h.matchAll(/data-voice-sample="([a-z]+)"/g)].map((m) => m[1]);

  it("v4 Turbo on a Hebrew + English company: two buttons, under the voice's helper line", () => {
    const h = render(TURBO, ["en", "he"]);
    expect(buttons(h)).toEqual(["en", "he"]);
    expect(h).toContain("Play sample · English");
    expect(h).toContain("Play sample · Hebrew");
    expect(h.indexOf("data-voice-eleven-voice-line")).toBeLessThan(h.indexOf("data-voice-samples"));
    expect(sampleLanguagesFor(TURBO, ["he", "en"])).toEqual(["he", "en"]);
  });

  it("Flash v2.5 on the same company: one button (English); an English-only company: one plain \"Play sample\"", () => {
    expect(buttons(render(FLASH, ["en", "he"]))).toEqual(["en"]);
    const h = render(TURBO, ["en"]);
    expect(buttons(h)).toEqual(["en"]);
    expect(h).toMatch(/<span data-on="">Play sample<\/span>/);
  });

  it("the model's own voice: no sample buttons", () => {
    const h = renderToStaticMarkup(
      <VoiceSettingsForm action={async () => ({})} slug="acme" models={voiceModelChoices()} platformModel="google/gemini-3.8-live"
        initial={{ ...DEFAULT_VOICE_SETTINGS, model: "openai/gpt-realtime-mini" as never }} version={3} closeHref="#" deploymentLimitSec={null} languages={["en", "he"]} />,
    );
    expect(h).not.toContain("data-voice-samples");
  });
});
