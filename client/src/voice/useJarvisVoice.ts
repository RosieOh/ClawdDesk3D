// Wires the store to the announcer and the speech engine: every session change may produce a line,
// which always becomes a caption and is spoken when the voice is on.

import { useEffect } from 'react';
import { useStore, type Session } from '../store';
import { Announcer, DEFAULT_MIN_TURN_MS, phrase } from './announcer';
import { hush, speak, unlockSpeech } from './speech';

/** Same line again within this window is dropped (e.g. two sessions finishing together). */
const DEDUPE_MS = 4_000;

type State = ReturnType<typeof useStore.getState>;

/** Sessions as the desk shows them: a dock override replaces the shown session's state, so demos speak too. */
export function effectiveSessions(s: Pick<State, 'sessions' | 'primaryId' | 'override' | 'state' | 'tool' | 'running'>): Session[] {
  if (!s.override) return s.sessions;
  return s.sessions.map((x) =>
    x.id === s.primaryId ? { ...x, state: s.state, tool: s.tool, running: s.running, lastTool: s.tool ?? x.lastTool } : x,
  );
}

export function useJarvisVoice() {
  useEffect(() => {
    const announcer = new Announcer();
    let lastText = '';
    let lastAt = 0;

    const run = (s: State) => {
      const sessions = effectiveSessions(s);
      const lines = announcer.update(sessions, Date.now(), { minTurnMs: s.override ? 0 : DEFAULT_MIN_TURN_MS });
      const several = sessions.filter((x) => x.state !== 'OFFLINE').length > 1;
      for (const line of lines) {
        const text = phrase(line, s.voiceLang, several);
        const now = Date.now();
        if (text === lastText && now - lastAt < DEDUPE_MS) continue;
        lastText = text;
        lastAt = now;
        s.setCaption(text);
        if (s.voiceOn) speak(text, s.voiceLang);
      }
    };

    // The current sessions are the baseline: nothing already open gets announced on load.
    run(useStore.getState());
    let awaitingBaseline = false;

    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.connected !== prev.connected) {
        // Switching between simulator and live: the next session list is a fresh baseline.
        announcer.reset();
        awaitingBaseline = true;
      }
      if (s.sessions === prev.sessions && s.state === prev.state && s.tool === prev.tool) return;
      if (awaitingBaseline && s.live !== prev.live) {
        announcer.update(effectiveSessions(s), Date.now());
        awaitingBaseline = false;
        return;
      }
      if (!awaitingBaseline) run(s);
    });

    // Speech needs a user gesture once per page load; the first click or key press unlocks it.
    const unlock = () => {
      unlockSpeech();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    return () => {
      unsubscribe();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      hush();
    };
  }, []);
}
