// Thin wrapper over the browser's Web Speech API (speechSynthesis): voice choice, queueing, and a shared
// "speaking" signal the 3D core reads every frame to glow in time with the words.

import type { Lang } from './announcer';

/** Read by the scene inside useFrame (no React re-renders). */
export const speech = {
  /** 1 while an utterance is playing */
  speaking: 0,
  /** jumps to 1 on every word boundary, decays in the scene */
  pulse: 0,
};

const LANG_TAG: Record<Lang, string> = { ko: 'ko-KR', en: 'en-GB' };
/**
 * Preferred voices, best first: calm British male voices for English (the closest stock match to JARVIS).
 * macOS' downloadable Premium / Enhanced variants win over the compact default when installed
 * (System Settings › Accessibility › Spoken Content › System voice › Manage Voices).
 */
const PREFERRED: Record<Lang, string[]> = {
  ko: ['Yuna', '유나', 'Sora', 'Google 한국의', 'Heami', 'Minsu'],
  en: ['Jamie', 'Daniel', 'Arthur', 'Google UK English Male', 'Oliver', 'George'],
};
/** Names carrying these are the higher-quality downloads (English and localized macOS labels). */
const HIGH_QUALITY = /premium|enhanced|프리미엄|향상/i;
const MAX_PENDING = 2;

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

export const speechSupported = () => synth() != null;

export function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | null {
  const tag = LANG_TAG[lang].toLowerCase();
  const prefix = lang.toLowerCase();
  for (const name of PREFERRED[lang]) {
    const matches = voices.filter((x) => x.name.includes(name) && x.lang.toLowerCase().startsWith(prefix));
    if (matches.length) return matches.find((x) => HIGH_QUALITY.test(x.name)) ?? matches[0];
  }
  return (
    voices.find((x) => x.lang.toLowerCase().replace('_', '-') === tag) ??
    voices.find((x) => x.lang.toLowerCase().startsWith(prefix)) ??
    null
  );
}

let pending = 0;

/** Queue a sentence. Returns false when speech isn't available. Older lines are dropped if it falls behind. */
export function speak(text: string, lang: Lang): boolean {
  const s = synth();
  if (!s) return false;
  if (pending >= MAX_PENDING) {
    s.cancel();
    pending = 0;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_TAG[lang];
  const voice = pickVoice(s.getVoices(), lang);
  if (voice) u.voice = voice;
  // Unhurried and a touch low for the butler; Korean slightly brisker.
  u.rate = lang === 'en' ? 0.96 : 1.05;
  u.pitch = lang === 'en' ? 0.88 : 1.0;
  u.onstart = () => {
    speech.speaking = 1;
    speech.pulse = 1;
  };
  u.onboundary = () => {
    speech.pulse = 1;
  };
  const finish = () => {
    pending = Math.max(0, pending - 1);
    speech.speaking = s.speaking && pending > 0 ? 1 : 0;
  };
  u.onend = finish;
  u.onerror = finish;
  pending++;
  s.speak(u);
  return true;
}

/** Stop talking now (voice switched off). */
export function hush() {
  synth()?.cancel();
  pending = 0;
  speech.speaking = 0;
}

/**
 * Browsers only allow speech after a user gesture. Call this from a click/keypress handler:
 * an empty utterance unlocks the engine for later, programmatic speech.
 */
export function unlockSpeech() {
  const s = synth();
  if (!s) return;
  s.getVoices(); // starts the async voice list load in Chrome
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  s.speak(u);
}
