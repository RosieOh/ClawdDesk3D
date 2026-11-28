// Optional local voice pack: recorded clips played for announcements instead of synthesized speech.
// The pack lives outside git (`voicepack/`, served by the dev/preview server at /voicepack/), because
// recordings are usually not ours to redistribute. Kinds without clips fall back to speech synthesis.

import type { Announcement } from './announcer';
import { speech } from './speech';

export type ClipKind = Announcement['kind'] | 'greeting';
const KINDS: ClipKind[] = ['greeting', 'done', 'failed', 'permission', 'started', 'ended'];
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i;

export interface VoicePack {
  name: string;
  /** 0..1 */
  volume: number;
  /** kind → clip paths relative to the pack root */
  clips: Partial<Record<ClipKind, string[]>>;
}

/** Validate a voicepack.json. Unknown kinds, non-audio files and absolute or `..` paths are dropped. */
export function parsePack(raw: unknown): VoicePack | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const clipsIn = o.clips && typeof o.clips === 'object' ? (o.clips as Record<string, unknown>) : {};
  const clips: VoicePack['clips'] = {};
  for (const kind of KINDS) {
    const list = clipsIn[kind];
    if (!Array.isArray(list)) continue;
    const ok = list.filter(
      (p): p is string =>
        typeof p === 'string' && AUDIO_EXT.test(p) && !p.startsWith('/') && !p.split(/[\\/]/).includes('..'),
    );
    if (ok.length) clips[kind] = ok;
  }
  if (Object.keys(clips).length === 0) return null;
  const volume = typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1 ? o.volume : 0.9;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Voice pack';
  return { name, volume, clips };
}

/** A clip for this kind, or null when the pack has none (→ speak instead). Avoids repeating `last` when it can. */
export function pickClip(pack: VoicePack | null, kind: ClipKind, last: string | null = null, rand = Math.random): string | null {
  const list = pack?.clips[kind];
  if (!list?.length) return null;
  const pool = list.length > 1 && last ? list.filter((c) => c !== last) : list;
  return pool[Math.floor(rand() * pool.length)] ?? null;
}

export const clipUrl = (path: string) => `/voicepack/${path.split('/').map(encodeURIComponent).join('/')}`;

export async function loadPack(): Promise<VoicePack | null> {
  try {
    const res = await fetch('/voicepack/voicepack.json', { cache: 'no-cache' });
    if (!res.ok || res.status === 204) return null; // 204: no pack installed
    return parsePack(await res.json());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- playback

let ctx: AudioContext | null = null;
let analyser: AnalyserNode;
let gain: GainNode;
const buffers = new Map<string, Promise<AudioBuffer>>();
const queue: string[] = [];
let playing = false;
let lastClip: string | null = null;
let currentSource: AudioBufferSourceNode | null = null;
const MAX_QUEUE = 2;

function audio(): AudioContext {
  if (ctx) return ctx;
  ctx = new AudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain = ctx.createGain();
  analyser.connect(gain).connect(ctx.destination);
  return ctx;
}

/** Resume the audio context from a user gesture (browsers start it suspended). */
export function unlockClips() {
  const c = audio();
  if (c.state === 'suspended') void c.resume();
}

function decode(path: string): Promise<AudioBuffer> {
  let p = buffers.get(path);
  if (!p) {
    p = fetch(clipUrl(path))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${path}`);
        return r.arrayBuffer();
      })
      .then((b) => audio().decodeAudioData(b));
    p.catch(() => buffers.delete(path)); // retry next time
    buffers.set(path, p);
  }
  return p;
}

/** Drive the core's glow from the clip's loudness while it plays. */
function meter() {
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!playing) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / data.length);
    speech.pulse = Math.max(speech.pulse, Math.min(1, rms * 5));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function next(volume: number): Promise<void> {
  const path = queue.shift();
  if (!path) {
    playing = false;
    speech.speaking = 0;
    return;
  }
  playing = true;
  try {
    const buf = await decode(path);
    const c = audio();
    gain.gain.value = volume;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    currentSource = src;
    speech.speaking = 1;
    meter();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  } catch (err) {
    console.warn('[voicepack] could not play', path, err);
  }
  currentSource = null;
  return next(volume);
}

/** Queue a clip; returns false when there is nothing to play for this kind. */
export function playClip(pack: VoicePack | null, kind: ClipKind): boolean {
  const path = pickClip(pack, kind, lastClip);
  if (!path || !pack) return false;
  lastClip = path;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(path);
  if (!playing) void next(pack.volume);
  return true;
}

export function stopClips() {
  queue.length = 0;
  try {
    currentSource?.stop();
  } catch {
    /* already stopped */
  }
}
