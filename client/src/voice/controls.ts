// User-facing voice controls (called from clicks / key presses, which also satisfy the browser's gesture rule).

import { useStore } from '../store';
import type { Lang } from './announcer';
import { hush, speak, unlockSpeech } from './speech';
import { playClip, stopClips, unlockClips } from './voicepack';
import { voicePack } from './useJarvisVoice';

const GREETING: Record<Lang, string> = { ko: '음성 안내를 시작합니다.', en: 'At your service, sir.' };

export function toggleVoice() {
  const s = useStore.getState();
  const on = !s.voiceOn;
  s.setVoice(on);
  if (on) {
    unlockSpeech();
    unlockClips();
    if (!playClip(voicePack, 'greeting')) speak(GREETING[s.voiceLang], s.voiceLang);
    s.setCaption(GREETING[s.voiceLang]);
  } else {
    hush();
    stopClips();
  }
}

export function cycleVoiceLang() {
  const s = useStore.getState();
  const lang: Lang = s.voiceLang === 'ko' ? 'en' : 'ko';
  s.setVoiceLang(lang);
  if (s.voiceOn) {
    hush();
    // The pack's recordings don't change with the language; only synthesized lines do.
    if (!voicePack) speak(GREETING[lang], lang);
    s.setCaption(GREETING[lang]);
  }
}
