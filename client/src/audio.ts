// Tiny procedural Web Audio synth: mechanical clicks on transitions + a soft hum while generating.
import type { AgentState } from './store';

let ctx: AudioContext | null = null;
let master: GainNode;
let humGain: GainNode;
let noiseBuf: AudioBuffer;
const MASTER_LEVEL = 0.55;

function init() {
  if (ctx) return ctx;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  // Short white-noise buffer used for the "click" body
  noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
  const ch = noiseBuf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);

  // Hum: two detuned saws -> slowly breathing low-pass
  humGain = ctx.createGain();
  humGain.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 260;
  lp.Q.value = 4;
  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo.frequency.value = 0.35;
  lfoDepth.gain.value = 90;
  lfo.connect(lfoDepth).connect(lp.frequency);
  lfo.start();
  for (const f of [55, 55.6, 110.3]) {
    const o = ctx.createOscillator();
    o.type = f > 100 ? 'sine' : 'sawtooth';
    o.frequency.value = f;
    o.connect(lp);
    o.start();
  }
  lp.connect(humGain).connect(master);
  return ctx;
}

export function setAudioEnabled(enabled: boolean) {
  const c = init();
  if (enabled && c.state === 'suspended') void c.resume();
  master.gain.setTargetAtTime(enabled ? MASTER_LEVEL : 0, c.currentTime, 0.05);
}

function click(freq: number, gain: number, pitch?: [number, number]) {
  if (!ctx) return;
  const t = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 2.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  src.connect(bp).connect(g).connect(master);
  src.start(t);

  if (pitch) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(pitch[0], t);
    o.frequency.exponentialRampToValueAtTime(pitch[1], t + 0.09);
    og.gain.setValueAtTime(0.12, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 0.14);
  }
}

export function playTransition(state: AgentState) {
  if (!ctx || ctx.state !== 'running') return;
  switch (state) {
    case 'OFFLINE':
      click(900, 0.5, [440, 180]);
      break;
    case 'IDLE':
      click(1800, 0.45, [520, 660]);
      break;
    case 'GENERATING':
      click(2600, 0.55, [660, 990]);
      break;
    case 'TOOL_RUNNING':
      click(3400, 0.5, [1180, 880]);
      break;
  }
  if (!humGain) return;
  const level = state === 'GENERATING' ? 0.07 : state === 'TOOL_RUNNING' ? 0.035 : 0;
  humGain.gain.setTargetAtTime(level, ctx.currentTime, 0.4);
}

export function playUiClick() {
  if (!ctx || ctx.state !== 'running') return;
  click(4200, 0.25);
}
