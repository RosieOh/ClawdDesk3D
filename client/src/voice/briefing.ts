// The daily briefing: spoken once a day the first time the desk wakes up (voice on, or back at the desk),
// or whenever you ask for it ("briefing").

import { useStore } from '../store';
import { briefing } from './announcer';
import { sayLine } from './say';

const PREF = 'clawddesk.briefedOn';
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

function briefedToday(): boolean {
  try {
    return window.localStorage.getItem(PREF) === today();
  } catch {
    return false;
  }
}

function markBriefed() {
  try {
    window.localStorage.setItem(PREF, today());
  } catch {
    /* storage unavailable: it may brief again on reload, which is harmless */
  }
}

/** Brief now if it hasn't been done today (or always, when asked for). */
export function maybeBrief(force = false) {
  const s = useStore.getState();
  if (!s.voiceOn || (!force && briefedToday())) return;
  // Without GitHub data yet (bridge just started), a briefing would be thin; wait for an explicit ask.
  if (!force && !s.github) return;
  const text = briefing(s.github, s.sessions, s.voiceLang);
  s.setCaption(text);
  sayLine(null, text, s.voiceLang);
  markBriefed();
}
