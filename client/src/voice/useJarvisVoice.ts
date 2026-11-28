// Wires the store to the announcer and the speech engine: every session change may produce a line,
// which always becomes a caption and is spoken when the voice is on.

import { useEffect } from 'react';
import { useStore, type Session } from '../store';
import { Announcer, DEFAULT_MIN_TURN_MS, phrase, welcomeBack } from './announcer';
import { away, engines, sayLine } from './say';

/** Only greet on return after being away at least this long. */
const WELCOME_AFTER_MS = 60_000;
import { ownCommands, reportCommand } from './assistant';
import { hush, unlockSpeech } from './speech';
import { loadPack, stopClips, unlockClips } from './voicepack';

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
      // Headless runs started from the desk (`claude -p`) are reported with their answer instead.
      const headless = new Set(sessions.filter((x) => x.source.startsWith('sdk')).map((x) => x.id));
      for (const line of lines) {
        if (headless.has(line.sessionId) && (line.kind === 'done' || line.kind === 'started' || line.kind === 'ended')) continue;
        const text = phrase(line, s.voiceLang, several);
        const now = Date.now();
        if (text === lastText && now - lastAt < DEDUPE_MS) continue;
        lastText = text;
        lastAt = now;
        s.setCaption(text);
        // Pack clip, cloned voice or browser voice (see say.ts); the caption always carries the details.
        if (s.voiceOn) sayLine(line.kind, text, s.voiceLang);
      }
    };

    // The current sessions are the baseline: nothing already open gets announced on load.
    run(useStore.getState());

    let alive = true;
    void loadPack().then((pack) => {
      if (!alive) return;
      engines.pack = pack;
      useStore.getState().setVoicePack(pack?.name ?? null);
      if (pack) console.info(`[voicepack] ${pack.name}: ${Object.keys(pack.clips).join(', ')}`);
    });

    let awaitingBaseline = false;

    let awaySince: number | null = null;

    const unsubscribe = useStore.subscribe((s, prev) => {
      // Camera presence: hold the lines while you're away, then welcome you back with them.
      if (s.userPresent !== prev.userPresent) {
        if (s.userPresent === false) {
          away.active = true;
          awaySince = Date.now();
        } else if (away.active) {
          away.active = false;
          const lines = away.lines.splice(0);
          const long = awaySince != null && Date.now() - awaySince >= WELCOME_AFTER_MS;
          awaySince = null;
          if (s.userPresent === true && (long || lines.length) && s.voiceOn) {
            const text = welcomeBack(lines, s.voiceLang);
            s.setCaption(text);
            sayLine('greeting', text, s.voiceLang);
          }
        }
      }
      if (s.connected !== prev.connected) {
        // Switching between simulator and live: the next session list is a fresh baseline.
        announcer.reset();
        awaitingBaseline = true;
      }
      // Commands this desk sent: report Claude's answer when they finish.
      if (s.commands !== prev.commands) {
        for (const c of s.commands) {
          if (c.status !== 'running' && ownCommands.delete(c.id)) reportCommand(c, s.voiceLang);
        }
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
      unlockClips();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    return () => {
      alive = false;
      stopClips();
      unsubscribe();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      hush();
    };
  }, []);
}
