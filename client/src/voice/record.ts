// Records one spoken command from the microphone: starts right away, stops after a pause once you've
// spoken (or at the time limit), and returns 16 kHz mono WAV for the voice lab to transcribe.

export interface RecordOptions {
  /** hard limit (ms) */
  maxMs: number;
  /** give up if nothing is said within this long (ms) */
  waitMs: number;
  /** after speech, this much quiet ends the recording (ms) */
  silenceMs: number;
}

export const DEFAULT_RECORD: RecordOptions = { maxMs: 12_000, waitMs: 5_000, silenceMs: 1_200 };
const TARGET_RATE = 16_000;

// Audio thread: hand 2048-sample chunks to the page.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('clawddesk-tap', Tap);
`;

/** Voice-activity end detection over chunk loudness. Pure, so it can be tested. */
export class Endpointer {
  private floor = 0.004;
  private spokeAt: number | null = null;
  private lastLoud = 0;

  constructor(private readonly opts: RecordOptions) {}

  /** Feed one chunk's RMS at time t (ms since start). Returns 'continue' | 'stop' | 'nothing'. */
  feed(t: number, rms: number): 'continue' | 'stop' | 'nothing' {
    const loud = rms > Math.max(0.012, this.floor * 3.5);
    if (loud) {
      this.lastLoud = t;
      if (this.spokeAt == null) this.spokeAt = t;
    } else if (this.spokeAt == null) {
      this.floor = this.floor * 0.95 + rms * 0.05;
    }
    if (t >= this.opts.maxMs) return this.spokeAt == null ? 'nothing' : 'stop';
    if (this.spokeAt == null) return t >= this.opts.waitMs ? 'nothing' : 'continue';
    return t - this.lastLoud >= this.opts.silenceMs ? 'stop' : 'continue';
  }

  get heardSpeech() {
    return this.spokeAt != null;
  }
}

/** Linear resample + 16-bit PCM WAV encode. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const n = Math.max(1, Math.round((samples.length * TARGET_RATE) / rate));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * (samples.length - 1)) / Math.max(1, n - 1);
    const i0 = Math.floor(x);
    const v = samples[i0] + ((samples[Math.min(i0 + 1, samples.length - 1)] ?? 0) - samples[i0]) * (x - i0);
    pcm[i] = Math.max(-1, Math.min(1, v || 0)) * 0x7fff;
  }
  const header = new ArrayBuffer(44);
  const d = new DataView(header);
  const str = (o: number, s: string) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  d.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); // PCM
  d.setUint16(22, 1, true); // mono
  d.setUint32(24, TARGET_RATE, true);
  d.setUint32(28, TARGET_RATE * 2, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, 'data');
  d.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

/** Record until the speaker pauses. Resolves null if nothing was said. `level` reports 0..1 loudness. */
export async function recordCommand(opts: RecordOptions = DEFAULT_RECORD, level?: (v: number) => void, signal?: AbortSignal): Promise<Blob | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'clawddesk-tap');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();

  const chunks: Float32Array[] = [];
  const ep = new Endpointer(opts);
  const started = performance.now();
  try {
    const outcome = await new Promise<'stop' | 'nothing'>((resolve) => {
      signal?.addEventListener('abort', () => resolve(ep.heardSpeech ? 'stop' : 'nothing'));
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const chunk = e.data;
        chunks.push(chunk);
        let sum = 0;
        for (const v of chunk) sum += v * v;
        const rms = Math.sqrt(sum / chunk.length);
        level?.(Math.min(1, rms * 8));
        const r = ep.feed(performance.now() - started, rms);
        if (r !== 'continue') resolve(r);
      };
    });
    if (outcome === 'nothing') return null;
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return encodeWav(all, ctx.sampleRate);
  } finally {
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    level?.(0);
  }
}
