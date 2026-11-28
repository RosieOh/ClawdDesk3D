// One place that decides how a line is voiced: a voice-pack clip for that moment, else the voice lab
// (your cloned voice, English only), else the browser's built-in speech.

import { useStore } from '../store';
import type { Lang } from './announcer';
import { speakLab } from './lab';
import { speak } from './speech';
import { playClip, type ClipKind, type VoicePack } from './voicepack';

/** The voice pack found at startup (set by useJarvisVoice). The voice lab is reported by the bridge (store). */
export const engines: { pack: VoicePack | null } = { pack: null };

export function sayLine(kind: ClipKind | null, text: string, lang: Lang) {
  if (kind && playClip(engines.pack, kind)) return;
  if (useStore.getState().voiceLab && lang === 'en') return speakLab(text, () => speak(text, lang));
  speak(text, lang);
}
