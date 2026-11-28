// User-facing voice controls (called from clicks / key presses, which also satisfy the browser's gesture rule).

import { useStore } from '../store';
import type { Lang } from './announcer';
import { hush, speak, unlockSpeech } from './speech';

const GREETING: Record<Lang, string> = { ko: '음성 안내를 시작합니다.', en: 'At your service, sir.' };

export function toggleVoice() {
  const s = useStore.getState();
  const on = !s.voiceOn;
  s.setVoice(on);
  if (on) {
    unlockSpeech();
    speak(GREETING[s.voiceLang], s.voiceLang);
    s.setCaption(GREETING[s.voiceLang]);
  } else {
    hush();
  }
}

export function cycleVoiceLang() {
  const s = useStore.getState();
  const lang: Lang = s.voiceLang === 'ko' ? 'en' : 'ko';
  s.setVoiceLang(lang);
  if (s.voiceOn) {
    hush();
    speak(GREETING[lang], lang);
    s.setCaption(GREETING[lang]);
  }
}
