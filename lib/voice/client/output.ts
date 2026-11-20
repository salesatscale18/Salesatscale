/**
 * Where the agent's voice plays (browser, pure parts). Loudspeaker by default:
 * the agent's audio goes from the Web Audio graph into a
 * MediaStreamAudioDestinationNode and plays through an <audio> element, the
 * way a WebRTC call plays the other side. Phones route that like a call on
 * speaker; Web Audio played straight to `ctx.destination` while the mic is
 * open is what some phones send to the earpiece (quiet, held to the ear).
 *
 * What browsers do (to be confirmed on real phones, see docs/ai.md):
 * - iOS Safari: with the mic open the page is in a play-and-record audio
 *   session. A media element fed by a MediaStream normally plays on the
 *   loudspeaker; Web Audio straight to the destination has been reported on
 *   the earpiece at low volume. The page cannot pick the route: no setSinkId,
 *   and enumerateDevices lists no outputs, so `outputDevices()` is empty and
 *   the buyer switches with the system controls (Control Centre, AirPods).
 *   We do not set `navigator.audioSession.type`: "play-and-record" there is
 *   what can move playback to the earpiece.
 * - Android Chrome: an open mic puts audio in communication mode; a media
 *   element (like a WebRTC call) plays on the speaker unless a headset or
 *   Bluetooth device is connected, which the system then uses. Output
 *   choice is usually not listed (one "default" output), so `outputDevices()`
 *   is mostly empty there too.
 * - Desktop Chrome / Edge (and Firefox with setSinkId): outputs are listed
 *   once the mic is allowed, and `setOutputDevice` switches the element.
 * Echo cancellation stays on the mic (getUserMedia constraints); browsers
 * cancel what the page itself plays, so the element path keeps barge-in
 * usable on speaker. How well depends on the phone: a real-phone check.
 */

export type PlaybackRoute = "element" | "context";

/** What the browser offers for playback (feature checks, read once per call). */
export type OutputSupport = {
  /** AudioContext.createMediaStreamDestination exists. */
  streamDestination: boolean;
  /** An <audio> element can take a MediaStream (`srcObject`). */
  elementSrcObject: boolean;
};

/** The loudspeaker path when the browser has it, else straight to the AudioContext. */
export function playbackRoute(s: OutputSupport): PlaybackRoute {
  return s.streamDestination && s.elementSrcObject ? "element" : "context";
}

export type OutputDevice = { deviceId: string; label: string };

/**
 * The output choices to offer: empty where the page cannot switch output
 * (no setSinkId on the playing element/context) or the browser lists one or
 * no output (iOS, most Android). The system default comes first; ids are
 * unique; a device without a label (permission not yet given) gets "Speaker N".
 */
export function outputChoices(devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[], canSwitch: boolean): OutputDevice[] {
  if (!canSwitch) return [];
  const seen = new Set<string>();
  const outs: OutputDevice[] = [];
  for (const d of devices) {
    if (d.kind !== "audiooutput" || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    outs.push({ deviceId: d.deviceId, label: d.label || `Speaker ${outs.length + 1}` });
  }
  outs.sort((a, b) => Number(b.deviceId === "default") - Number(a.deviceId === "default"));
  return outs.length > 1 ? outs : [];
}
