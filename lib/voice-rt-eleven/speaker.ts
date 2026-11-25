/**
 * The live speaker of a call where ElevenLabs speaks (lib/voice-rt-eleven): the version's CHOSEN speaking model, voice
 * and steadiness (Voice settings › Voice: elevenModel, elevenVoice, elevenStability) are attempt 1; when it fails (the
 * voice id is refused, the model is unavailable) the existing chain (lib/voice-pipeline/models.ts
 * PIPELINE_SPEAK_ATTEMPTS) follows with Rachel, logged once: "rt speech fallback: <model> / <voice> failed: <reason>;
 * using <model> Rachel". Each chain keeps the first attempt that produced audio for the rest of the call
 * (lib/voice-pipeline/speaker.ts SpeakerChain).
 *
 * Language: a reply in a language the chosen model does not speak (Flash v2.5 or Multilingual v2 and Hebrew) never
 * tries it: it goes to a second chain with v4 Turbo first (the same voice and steadiness), logged once per language:
 * "rt speech: <model> has no Hebrew, using elevenlabs/eleven-v4-turbo for Hebrew".
 *
 * What applied (the model and voice that spoke last, a fallback, the substituted languages) is read back by the socket
 * after the call and stored on the session (settings.elevenApplied), so the call card says what was heard.
 * No network of its own: the attempts' speakers come from `make` (GatewaySpeaker on a live call, fakes in tests).
 */
import { SpeakerChain, type ChainLink, type Speaker, type SpeakerLog } from "@/lib/voice-pipeline/speaker";
import { PIPELINE_SPEAK_ATTEMPTS, PIPELINE_VOICE, PIPELINE_VOICE_STABILITY, speakModeName, type SpeakAttempt } from "@/lib/voice-pipeline/models";
import {
  baseLanguage, ELEVEN_LANGUAGE_SUBSTITUTE, elevenModelInfo, elevenModelSpeaks, elevenVoiceLabel, elevenVoiceName, languageName, type ElevenChoice,
} from "./catalog";

/** One attempt of the realtime path's chain: model, mode, voice id, stability (sent in dialogue mode only). */
export type ElevenLink = SpeakAttempt & { voice: string; stability: number; chosen: boolean; speed?: number };

const sameLink = (a: ElevenLink, b: ElevenLink) => a.model === b.model && a.dialogue === b.dialogue && a.voice === b.voice && (!a.dialogue || a.stability === b.stability);

/**
 * The attempts for a choice, in order: the chosen model (its own dialogue flag) with the chosen voice and stability,
 * then PIPELINE_SPEAK_ATTEMPTS with Rachel and the default stability (an attempt identical to the chosen one is left
 * out). A fallback attempt whose model has no Hebrew (catalog) is skipped on a Hebrew reply.
 */
export function elevenAttempts(choice: ElevenChoice): ElevenLink[] {
  const info = elevenModelInfo(choice.model);
  const first: ElevenLink = {
    model: choice.model, dialogue: info?.dialogue ?? false, voice: choice.voice, stability: choice.stability, chosen: true,
    // The pace's speaking rate: the chosen plain text-to-speech model only (never a dialogue model, never a fallback).
    ...(choice.speed !== undefined && !(info?.dialogue ?? false) ? { speed: choice.speed } : {}),
  };
  const rest: ElevenLink[] = PIPELINE_SPEAK_ATTEMPTS.map((a) => ({
    ...a, englishOnly: a.englishOnly || elevenModelSpeaks(a.model, "he") === false, voice: PIPELINE_VOICE, stability: PIPELINE_VOICE_STABILITY, chosen: false,
  }));
  return [first, ...rest.filter((l) => !sameLink(l, first))];
}

/** What a call's ElevenLabs speech used, for the session (settings.elevenApplied) and the call card. */
export type ElevenApplied = {
  /** The version's choice. */
  chosen: ElevenChoice;
  /** The model, voice id and stability that spoke the last reply (null: nothing was spoken, or a scripted call). */
  model: string | null;
  voice: string | null;
  stability: number | null;
  /** The chosen model/voice failed and a fallback spoke: the reason (clipped). */
  fallback: string | null;
  /** Languages of replies the substitute model (v4 Turbo) spoke because the chosen model does not speak them. */
  substituted: string[];
  /** A scripted call: nothing was sent to ElevenLabs. */
  scripted?: boolean;
};

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);

export class ElevenSpeaker implements Speaker {
  /** "Sarah (ElevenLabs)": the chosen voice. */
  readonly voice: string;
  private readonly main: SpeakerChain;
  private alt: SpeakerChain | null = null;
  private last: SpeakerChain;
  private readonly kept = new Map<SpeakerChain, ElevenLink>();
  private fallback: string | null = null;
  private readonly substituted: string[] = [];
  private log: SpeakerLog = () => {};
  private announced = false;

  constructor(readonly choice: ElevenChoice, private readonly make: (link: ElevenLink) => Speaker) {
    this.voice = elevenVoiceLabel(choice.voice);
    this.main = this.chain(choice);
    this.last = this.main;
  }

  /** The model of the chain that spoke last (its kept attempt; the chosen model before anything was said). */
  get modelId(): string {
    return this.last.modelId;
  }

  setLog(log: SpeakerLog) {
    this.log = log;
    this.main.setLog(log);
    this.alt?.setLog(log);
  }

  speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array> {
    if (!this.announced) {
      this.announced = true;
      const m = elevenModelInfo(this.choice.model);
      this.log("info", `rt speech choice model=${this.choice.model} ${speakModeName({ dialogue: !!m?.dialogue })} voice=${elevenVoiceName(this.choice.voice)} (${this.choice.voice}) stability=${m?.dialogue ? this.choice.stability : "not sent"}${this.choice.speed !== undefined && !m?.dialogue ? ` speed=${this.choice.speed}` : ""}`);
    }
    const chain = this.chainFor(opts.language);
    this.last = chain;
    return chain.speak(text, opts);
  }

  cancel() {
    this.main.cancel();
    this.alt?.cancel();
  }

  /** What applied so far (read after the call). */
  applied(): ElevenApplied {
    const link = this.kept.get(this.last) ?? null;
    return {
      chosen: this.choice, model: link?.model ?? null, voice: link?.voice ?? null, stability: link ? (link.dialogue ? link.stability : null) : null,
      fallback: this.fallback, substituted: [...this.substituted],
    };
  }

  /** The chain for a reply's language: the chosen model's, or the substitute's when the chosen model does not speak it. */
  private chainFor(language: string): SpeakerChain {
    if (elevenModelSpeaks(this.choice.model, language) !== false) return this.main;
    const lang = baseLanguage(language);
    if (!this.substituted.includes(lang)) {
      this.substituted.push(lang);
      const name = languageName(lang);
      this.log("info", `rt speech: ${this.choice.model} has no ${name}, using ${ELEVEN_LANGUAGE_SUBSTITUTE} for ${name}`);
    }
    if (!this.alt) {
      this.alt = this.chain({ ...this.choice, model: ELEVEN_LANGUAGE_SUBSTITUTE });
      this.alt.setLog(this.log);
    }
    return this.alt;
  }

  private chain(choice: ElevenChoice): SpeakerChain {
    const links = elevenAttempts(choice);
    const first = links[0];
    const firstName = `${first.model} ${speakModeName(first)}`;
    const chain: SpeakerChain = new SpeakerChain(links.map((l) => ({ ...l, speaker: this.make(l) })), {
      onChosen: (link: ChainLink, failures: readonly string[]) => {
        const l = link as ChainLink & ElevenLink;
        this.kept.set(chain, l);
        if (l.chosen) return;
        const own = failures.find((f) => f.startsWith(`${firstName}: `));
        const why = clip(own ? own.slice(firstName.length + 2) : failures[0] ?? "no audio");
        this.fallback ??= why;
        this.log("warn", `rt speech fallback: ${first.model} / ${elevenVoiceName(first.voice)} failed: ${why}; using ${l.model} ${elevenVoiceName(l.voice)}`);
      },
    });
    return chain;
  }
}

/** What applied on a call whose speaker is not an ElevenSpeaker (scripted, a test's fake): the choice, nothing sent. */
export function elevenAppliedOf(speaker: Speaker, choice: ElevenChoice): ElevenApplied {
  if (speaker instanceof ElevenSpeaker) return speaker.applied();
  return { chosen: choice, model: null, voice: choice.voice, stability: null, fallback: null, substituted: [], scripted: true };
}
