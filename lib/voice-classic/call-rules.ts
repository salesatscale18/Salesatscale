/**
 * CLASSIC (20 Nov): lib/voice/call-rules.ts as it was at commit af85493 (20 Nov 2026), frozen (unchanged).
 *
 * The call's standby and stop rules (live voice), in one place. Owner-approved
 * starting values (2026-11-20): never pay for an idle call, without cutting off
 * a buyer who is quietly filling in the order form. Pure and import-safe from
 * client code (the settings UI reads the default length).
 *
 * "Standby": the realtime model connection is closed (that is what costs
 * money) while the buyer's socket and microphone stay connected to our
 * server, which listens for speech itself (lib/voice/vad.ts) and reconnects
 * the model when the buyer speaks, types or taps the call bar.
 *
 * The deployment's own cap (the Vercel function's limit) is
 * DEPLOYMENT_CALL_CAP_SEC in lib/voice/socket-limits.ts.
 */
export const CALL_RULES = {
  /** A call's default longest length (a version may set 60..PLATFORM_MAX_CALL_SEC), standby included. */
  defaultMaxCallSec: 480,
  /** The platform's longest call; a version's setting can only lower it. */
  platformMaxCallSec: 600,
  /** Standby after the agent finished (turn done, no tool, nothing queued) and the buyer was quiet this long. */
  standbyAfterQuietMs: 30_000,
  /** Continuous standby with no speech this long ends the call (`idle`), unless the order form is open. */
  standbyIdleEndMs: 180_000,
  /** Mic audio kept while in standby, replayed to the model on a wake so the first words are not lost. */
  preRollMs: 3_000,
  /** Audio kept while the model reconnects on a wake (on top of the pre-roll), at most. */
  wakeBufferMaxMs: 15_000,
  /** A woken model has this long to connect; one retry, then the call ends (`connection_lost`). */
  wakeConnectMs: 8_000,
  /** A speech wake with no buyer transcript within this long after the model is ready is a false wake. */
  falseWakeMs: 8_000,
  /** After this many false wakes the detector's threshold doubles (up to maxThresholdBoost). */
  falseWakesBeforeRaise: 3,
  maxThresholdBoost: 8,
  /** Speech wakes at most this often (a noisy room cannot reconnect the model constantly). */
  minWakeGapMs: 5_000,
  /** The server-side speech detector in standby. */
  vad: {
    /** RMS of a PCM16 frame (0..1) that counts as loud, at least. */
    threshold: 0.02,
    /** Loud for this long is speech; shorter bursts (a click, a tap on the phone) are ignored. */
    minSpeechMs: 250,
    /** Quiet this long ends a stretch of speech. */
    endSilenceMs: 700,
    /** Adaptive noise floor: loud = above floor × factor (and above `threshold`). */
    floorFactor: 3,
    /** How fast the floor follows a louder room (ms to close the gap) and a quieter one. */
    floorRiseMs: 4_000,
    floorFallMs: 300,
  },
} as const;
