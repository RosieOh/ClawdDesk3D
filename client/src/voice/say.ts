// One place that decides how a line is voiced: a voice-pack clip for that moment, else the voice lab
// (your cloned voice, English only), else the browser's built-in speech.

import { useStore } from '../store';
import type { Lang } from './announcer';
import { speakLab } from './lab';
import { speak } from './speech';
import { playClip, type ClipKind, type VoicePack } from './voicepack';

/** The voice pack found at startup (set by useJarvisVoice). The voice lab is reported by the bridge (store). */
export const engines: { pack: VoicePack | null } = { pack: null };

/** While you're away from the desk (camera presence), lines are kept for the welcome back instead of spoken. */
export const away: { active: boolean; lines: string[] } = { active: false, lines: [] };

export function sayLine(kind: ClipKind | null, text: string, lang: Lang) {
  if (away.active) {
    if (away.lines.length < 20) away.lines.push(text);
    return;
  }
  if (kind && playClip(engines.pack, kind)) return;
  if (useStore.getState().voiceLab && lang === 'en') return speakLab(text, () => speak(text, lang));
  speak(text, lang);
}
