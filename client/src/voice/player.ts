// Shared Web Audio playback for recorded or generated speech (voice-pack clips, voice-lab audio):
// one queue, so lines never talk over each other, and a loudness meter that makes the 3D core glow.

import { speech } from './speech';

type Job = { load: () => Promise<AudioBuffer>; volume: number; label: string; onError?: () => void };

const MAX_QUEUE = 2;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode;
let gain: GainNode;
const queue: Job[] = [];
let playing = false;
let current: AudioBufferSourceNode | null = null;

export function audio(): AudioContext {
  if (ctx) return ctx;
  ctx = new AudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain = ctx.createGain();
  analyser.connect(gain).connect(ctx.destination);
  return ctx;
}

/** Resume the audio context from a user gesture (browsers start it suspended). */
export function unlockAudio() {
  const c = audio();
  if (c.state === 'suspended') void c.resume();
}

export async function decodeResponse(res: Response, what: string): Promise<AudioBuffer> {
  if (!res.ok) throw new Error(`${res.status} ${what}`);
  return audio().decodeAudioData(await res.arrayBuffer());
}

/** Drive the core's glow from the audio's loudness while it plays. */
function meter() {
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!playing) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    speech.pulse = Math.max(speech.pulse, Math.min(1, Math.sqrt(sum / data.length) * 5));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function next(): Promise<void> {
  const job = queue.shift();
  if (!job) {
    playing = false;
    speech.speaking = 0;
    return;
  }
  playing = true;
  try {
    const buf = await job.load();
    const src = audio().createBufferSource();
    src.buffer = buf;
    gain.gain.value = job.volume;
    src.connect(analyser);
    current = src;
    speech.speaking = 1;
    meter();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  } catch (err) {
    console.warn('[voice] could not play', job.label, err);
    job.onError?.();
  }
  current = null;
  return next();
}

/** Queue audio; only the two newest lines are kept if it falls behind. `onError` lets callers fall back. */
export function enqueue(load: () => Promise<AudioBuffer>, volume: number, label: string, onError?: () => void) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ load, volume, label, onError });
  if (!playing) void next();
}

export function stopAll() {
  queue.length = 0;
  try {
    current?.stop();
  } catch {
    /* already stopped */
  }
}
