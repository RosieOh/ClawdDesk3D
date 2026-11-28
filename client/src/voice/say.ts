// One place that decides how a line is voiced: a voice-pack clip for that moment, else the voice lab
// (your cloned voice, English only), else the browser's built-in speech.

import type { Lang } from './announcer';
import { speakLab, type LabStatus } from './lab';
import { speak } from './speech';
import { playClip, type ClipKind, type VoicePack } from './voicepack';

/** Engines found at startup (set by useJarvisVoice). */
export const engines: { pack: VoicePack | null; lab: LabStatus | null } = { pack: null, lab: null };

export function sayLine(kind: ClipKind | null, text: string, lang: Lang) {
  if (kind && playClip(engines.pack, kind)) return;
  if (engines.lab && lang === 'en') return speakLab(text, () => speak(text, lang));
  speak(text, lang);
}
