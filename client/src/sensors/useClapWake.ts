// Listens to the microphone for a double clap. Asleep (voice off): wakes JARVIS. Awake: a status report.
// Audio is analysed in an AudioWorklet (keeps working in a background tab) and never leaves the browser.

import { useEffect } from 'react';
import { useStore } from '../store';
import { statusReport } from '../voice/announcer';
import { sayLine } from '../voice/say';
import { speech } from '../voice/speech';
import { toggleVoice } from '../voice/controls';
import { ClapDetector } from './clap';

// Runs on the audio thread: per ~5 ms frame, post the peak and RMS level.
const WORKLET = `
class Level extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.peak = 0; this.sum = 0; this.size = Math.round(sampleRate * 0.005); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const v = ch[i], a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.sum += v * v;
      if (++this.n >= this.size) {
        this.port.postMessage([currentTime * 1000, this.peak, Math.sqrt(this.sum / this.n)]);
        this.n = 0; this.peak = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('clawddesk-level', Level);
`;

export function onDoubleClap() {
  const s = useStore.getState();
  speech.pulse = 1; // the core flashes either way
  if (!s.voiceOn) {
    toggleVoice(); // wake: voice on + greeting
    return;
  }
  const text = statusReport(s.sessions, s.voiceLang);
  s.setCaption(text);
  sayLine(null, text, s.voiceLang);
}

async function startListening(onClap: () => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Raw signal: processing like noise suppression would flatten the very transients we look for.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'clawddesk-level');
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the node pulled by the graph without making any sound
  src.connect(node).connect(mute).connect(ctx.destination);

  const detector = new ClapDetector();
  node.port.onmessage = (e: MessageEvent<[number, number, number]>) => {
    const [t, peak, rms] = e.data;
    if (detector.frame(t, peak, rms)) onClap();
  };
  if (ctx.state === 'suspended') await ctx.resume();

  return () => {
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}

export function useClapWake() {
  const clapOn = useStore((s) => s.clapOn);

  useEffect(() => {
    if (!clapOn) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    startListening(onDoubleClap)
      .then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
      .catch((err: unknown) => {
        console.warn('[clap] microphone unavailable', err);
        const s = useStore.getState();
        s.setClap(false);
        s.setCaption(s.voiceLang === 'ko' ? '마이크를 사용할 수 없어 박수 감지를 껐습니다.' : 'Microphone unavailable, sir. Clap detection is off.');
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [clapOn]);
}
