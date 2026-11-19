/**
 * The mic capture AudioWorklet (live voice), as source text: it is loaded
 * from a Blob URL, so Next needs no public file or bundler config. It only
 * collects mono float samples (about 40 ms per message at 48 kHz) and posts
 * them to the page, where they are resampled and sent (lib/voice/client/audio.ts).
 */
export const CAPTURE_PROCESSOR = "sas-voice-capture";

export const CAPTURE_WORKLET_SOURCE = `
class SasVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (this.len + ch.length > this.buf.length) this.flush();
      this.buf.set(ch, this.len);
      this.len += ch.length;
      if (this.len >= 1920) this.flush();
    }
    return true;
  }
  flush() {
    if (!this.len) return;
    const out = this.buf.slice(0, this.len);
    this.port.postMessage(out, [out.buffer]);
    this.len = 0;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR)}, SasVoiceCapture);
`;
