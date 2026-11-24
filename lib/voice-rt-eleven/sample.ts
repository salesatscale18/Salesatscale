/**
 * "Play sample" (Voice settings › Voice, platform admins only; owner 24 Nov 2026): one fixed sentence (catalog.ts
 * SAMPLE_TEXTS) in a chosen ElevenLabs speaking model + voice + steadiness, in English or Hebrew.
 *
 * Cost rule: a sample is generated ONCE per combination and then replayed from storage for free. Storage: the private
 * Vercel Blob store (as call recordings), key `voice-samples/v1/<model>/<voice>/<lang>[-s<steadiness>].wav` (the
 * steadiness part only for dialogue-mode models). Samples hold no account data and are shared across accounts.
 * Before generating: the platform's monthly AI budget and the account's spend cap (as createVoiceSession checks
 * them). After generating, the characters × the catalog rate are logged ("[voice] sample generated …"): lib/ai's usage
 * rollups read messages, pipeline runs and voice sessions only, so there is no row to record a sample's cost in
 * without changing lib/ai (not done here). Two requests for the same missing sample share one generation (in-flight
 * map). In scripted mode (VOICE_REALTIME=scripted, the harness, tests) the gateway is never called: a short tone WAV,
 * not stored. Server-only.
 */
import type { Db } from "@/db/types";
import { platformBudget, spendCapped } from "@/lib/ai/usage";
import { rateLimit } from "@/lib/security/rate-limit";
import { voiceLabAccess } from "@/lib/voice/lab";
import { voiceMode } from "@/lib/voice/settings";
import { tonePcm, type Speaker } from "@/lib/voice-pipeline/speaker";
import { SPEAK_OUTPUT_RATE } from "@/lib/voice-pipeline/models";
import {
  elevenModelInfo, elevenModelSpeaks, isElevenModel, isElevenStability, isElevenVoice, SAMPLE_LANGUAGES, SAMPLE_TEXTS,
  type ElevenChoice, type SampleLanguage,
} from "./catalog";

export type SampleRequest = ElevenChoice & { language: SampleLanguage };

/** A request body (untrusted): the catalog's ids, a steadiness, English or Hebrew that the model speaks. */
export function parseSampleRequest(input: unknown): { ok: true; value: SampleRequest } | { ok: false; error: string } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (!isElevenModel(o.model)) return { ok: false, error: "unknown speaking model" };
  if (!isElevenVoice(o.voice)) return { ok: false, error: "unknown voice" };
  const stability = typeof o.stability === "string" ? Number(o.stability) : o.stability ?? 1;
  if (!isElevenStability(stability)) return { ok: false, error: "steadiness is 0, 0.5 or 1" };
  if (typeof o.language !== "string" || !(SAMPLE_LANGUAGES as string[]).includes(o.language)) return { ok: false, error: "language is en or he" };
  const language = o.language as SampleLanguage;
  if (elevenModelSpeaks(o.model, language) !== true) return { ok: false, error: `${elevenModelInfo(o.model)?.label ?? o.model} does not speak ${language}` };
  return { ok: true, value: { model: o.model, voice: o.voice, stability, language } };
}

/** `voice-samples/v1/<model>/<voice>/<lang>[-s<steadiness>].wav` (steadiness only for dialogue-mode models). */
export function sampleKey(r: SampleRequest): string {
  const s = elevenModelInfo(r.model)?.dialogue ? `-s${r.stability}` : "";
  return `voice-samples/v1/${r.model}/${r.voice}/${r.language}${s}.wav`;
}

/** PCM16 mono → a WAV file (44-byte header). */
export function pcmToWav(pcm: Uint8Array, rate = SPEAK_OUTPUT_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Where samples are kept (the Blob store on a deployment; a fake in tests). */
export type SampleStore = { get(key: string): Promise<Uint8Array | null>; put(key: string, wav: Uint8Array): Promise<void> };

/** The private Blob store for samples, or null without BLOB_READ_WRITE_TOKEN. */
export async function blobSampleStore(env: Record<string, string | undefined> = process.env): Promise<SampleStore | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const { get, put } = await import("@vercel/blob");
  return {
    async get(key) {
      try {
        const r = await get(key, { access: "private", token, useCache: false });
        return r?.stream ? new Uint8Array(await new Response(r.stream).arrayBuffer()) : null;
      } catch (e) {
        if (/not.?found|404/i.test(String((e as { message?: unknown })?.message ?? e))) return null;
        throw e;
      }
    },
    async put(key, wav) {
      await put(key, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength), {
        access: "private", contentType: "audio/wav", token, addRandomSuffix: false, allowOverwrite: true,
      });
    },
  };
}

/** The live speaker for one sample: ONE attempt, the chosen model/voice/steadiness (a fallback would not be a sample of the choice). */
export async function gatewaySampleSpeaker(r: SampleRequest, env: Record<string, string | undefined>): Promise<Speaker> {
  const { GatewaySpeaker } = await import("@/lib/voice-pipeline/gateway");
  return new GatewaySpeaker(r.model, env, r.voice, { dialogue: !!elevenModelInfo(r.model)?.dialogue, stability: r.stability });
}

/** Samples a user may ask for per minute. */
export const SAMPLES_PER_MINUTE = 20;

export type VoiceSampleDeps = {
  db: Db;
  env?: Record<string, string | undefined>;
  /** The store (null: none configured). Default: the Blob store. */
  store?: SampleStore | null;
  /** The live speaker (default: the Gateway). Never called in scripted mode. */
  speakerFor?: (r: SampleRequest) => Promise<Speaker>;
  log?: (line: string) => void;
  now?: Date;
};

const inFlight = new Map<string, Promise<Uint8Array>>();

/** Generation refused before anything was spent (the budget, the spend cap). */
class SampleRefused extends Error {}

const clip = (e: unknown) => String((e as { message?: unknown })?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 120);
const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
const wavResponse = (wav: Uint8Array, source: "stored" | "generated" | "scripted") => new Response(new Blob([wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }), {
  status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.byteLength), "Cache-Control": "private, max-age=86400", "X-Sample-Source": source },
});

/**
 * The route's work (app/app/[account]/voice-sample/route.ts): the caller has resolved the account (requireAccount);
 * here the platform-admin rule (the test lab's: voiceLabAccess, server-checked: 404 otherwise), the rate limit, the
 * request, then storage, the budget and generation.
 */
export async function voiceSampleResponse(
  a: { user: { id: string; role: string }; accountId: string; body: unknown }, deps: VoiceSampleDeps,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.info(l));
  if (voiceLabAccess(a.user, env) !== "ok") return json(404, "not found");
  const rl = await rateLimit(deps.db, `voice-sample:${a.user.id}`, { limit: SAMPLES_PER_MINUTE, windowSeconds: 60 }, deps.now);
  if (!rl.ok) return json(429, `too many samples; try again in ${rl.retryAfterSeconds} s`);
  const req = parseSampleRequest(a.body);
  if (!req.ok) return json(400, req.error);
  const r = req.value;
  const text = SAMPLE_TEXTS[r.language];
  // Scripted: never the gateway, never stored.
  if (voiceMode(env) !== "live") return wavResponse(pcmToWav(tonePcm(Math.min(1_500, text.length * 12))), "scripted");
  const store = deps.store === undefined ? await blobSampleStore(env) : deps.store;
  if (!store) return json(503, "sample storage is not set up (BLOB_READ_WRITE_TOKEN)");
  const key = sampleKey(r);
  try {
    const stored = await store.get(key);
    if (stored) return wavResponse(stored, "stored");
  } catch (e) {
    return json(502, `storage: ${clip(e)}`);
  }
  // No await between this lookup and the set below: concurrent misses share one generation.
  let job = inFlight.get(key);
  if (!job) {
    job = (async () => {
      // Spend is checked before anything is generated (as createVoiceSession).
      if ((await platformBudget(deps.db, deps.now)).exceeded) throw new SampleRefused("the platform's monthly AI budget is used up");
      if (await spendCapped(deps.db, a.accountId, deps.now)) throw new SampleRefused("this account's spend cap is reached");
      const speaker = await (deps.speakerFor ?? ((x) => gatewaySampleSpeaker(x, env)))(r);
      const parts: Uint8Array[] = [];
      for await (const c of speaker.speak(text, { language: r.language })) if (c.byteLength) parts.push(c);
      const n = parts.reduce((s, p) => s + p.byteLength, 0);
      if (!n) throw new Error("the stream ended without audio");
      const pcm = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        pcm.set(p, at);
        at += p.byteLength;
      }
      const wav = pcmToWav(pcm);
      await store.put(key, wav);
      const costMicros = Math.round((elevenModelInfo(r.model)?.usdPer1kChars ?? 0) * 1000 * text.length);
      log(`[voice] sample generated model=${r.model} voice=${r.voice} lang=${r.language} chars=${text.length} costMicros=${costMicros}`);
      return wav;
    })();
    inFlight.set(key, job);
    void job.finally(() => inFlight.delete(key)).catch(() => undefined);
  }
  try {
    return wavResponse(await job, "generated");
  } catch (e) {
    if (e instanceof SampleRefused) return json(402, e.message);
    log(`[voice] sample failed model=${r.model} voice=${r.voice} lang=${r.language}: ${clip(e)}`);
    return json(502, clip(e));
  }
}
