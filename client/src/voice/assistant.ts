// The command loop: listen → transcribe → understand → act (on the desk, or by asking Claude) → report.

import { sendCommand } from '../bridge';
import { useStore, type DeskCommand } from '../store';
import { statusReport, type Lang } from './announcer';
import { parseIntent, spokenSummary } from './intents';
import { transcribe } from './lab';
import { DEFAULT_RECORD, recordCommand } from './record';
import { sayLine } from './say';
import { speech } from './speech';
import { toggleVoice } from './controls';

const LINES = {
  greet: { en: 'Yes, sir?', ko: '네, 말씀하세요.' },
  listening: { en: 'Listening…', ko: '듣고 있습니다…' },
  unheard: { en: "Sorry, sir, I didn't catch that.", ko: '잘 못 들었습니다.' },
  cancel: { en: 'Very well, sir.', ko: '알겠습니다.' },
  noLab: { en: 'Sir, speech recognition needs the voice lab running.', ko: '음성 인식을 하려면 음성 실험실을 켜 주세요.' },
  noBridge: { en: "I'm not connected to the bridge, sir.", ko: '브리지에 연결되어 있지 않습니다.' },
  noSession: {
    en: 'Sir, I need a project to work in. Start a Claude session there first.',
    ko: '작업할 프로젝트가 없습니다. 먼저 그 폴더에서 Claude 세션을 열어 주세요.',
  },
  busy: { en: "I'm already running two tasks, sir.", ko: '이미 작업 두 개를 실행 중입니다.' },
  micError: { en: "I can't access the microphone, sir.", ko: '마이크를 사용할 수 없습니다.' },
} satisfies Record<string, Record<Lang, string>>;

const said = (key: keyof typeof LINES, lang: Lang) => LINES[key][lang];

function tell(text: string, lang: Lang) {
  const s = useStore.getState();
  s.setCaption(text);
  if (s.voiceOn) sayLine(null, text, lang);
}

/** Wait until the desk has stopped talking (so the microphone doesn't hear JARVIS). */
async function quiet(maxMs = 4000) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 150));
  while (speech.speaking && Date.now() - start < maxMs) await new Promise((r) => setTimeout(r, 100));
}

let abort: AbortController | null = null;
/** Commands this desk started; their completion is announced with Claude's answer. */
export const ownCommands = new Set<string>();

/** Listen for one spoken command and carry it out. `greet` answers first ("Yes, sir?"), e.g. after a clap. */
export async function listenForCommand(greet = false) {
  const s = useStore.getState();
  const lang = s.voiceLang;
  if (s.listening !== 'idle') {
    abort?.abort(); // a second press ends the recording early
    return;
  }
  if (!s.sttAvailable) return tell(said('noLab', lang), lang);

  if (greet) {
    tell(said('greet', lang), lang);
    await quiet();
  }
  s.setListening('listening');
  s.setCaption(said('listening', lang));
  abort = new AbortController();
  let wav: Blob | null;
  try {
    wav = await recordCommand(DEFAULT_RECORD, (v) => (speech.pulse = Math.max(speech.pulse, v)), abort.signal);
  } catch (err) {
    console.warn('[talk] recording failed', err);
    useStore.getState().setListening('idle');
    return tell(said('micError', lang), lang);
  }
  abort = null;
  if (!wav) {
    useStore.getState().setListening('idle');
    return tell(said('unheard', lang), lang);
  }

  useStore.getState().setListening('thinking');
  let text = '';
  try {
    text = (await transcribe(wav)).text;
  } catch {
    /* treated as unheard */
  }
  useStore.getState().setListening('idle');
  await act(text, lang);
}

async function act(text: string, lang: Lang) {
  const intent = parseIntent(text);
  const s = useStore.getState();
  if (text) s.setCaption(`“${text}”`);
  switch (intent.kind) {
    case 'none':
      return tell(said('unheard', lang), lang);
    case 'cancel':
      return tell(said('cancel', lang), lang);
    case 'mute':
      if (s.voiceOn) toggleVoice();
      return;
    case 'status':
      return tell(statusReport(s.sessions, lang), lang);
    case 'claude': {
      if (!s.connected) return tell(said('noBridge', lang), lang);
      const target = s.primary && s.primary.cwd && s.connected ? s.primary : null;
      if (!target) return tell(said('noSession', lang), lang);
      const res = await sendCommand(intent.prompt, target.id);
      if (!res.ok) {
        if (res.status === 429) return tell(said('busy', lang), lang);
        return tell(lang === 'ko' ? `요청을 보내지 못했습니다. ${res.message}` : `I couldn't send that, sir. ${res.message}`, lang);
      }
      ownCommands.add(res.id);
      return tell(lang === 'ko' ? `${target.project}에서 작업을 시작합니다.` : `On it, sir. Working in ${target.project}.`, lang);
    }
  }
}

/** Speak the outcome of a desk command (called when its status leaves "running"). */
export function reportCommand(c: DeskCommand, lang: Lang) {
  const result = (c.result ?? '').trim();
  if (c.status === 'done') {
    const summary = spokenSummary(result);
    const head = lang === 'ko' ? `${c.project} 작업을 마쳤습니다.` : `${c.project} is done, sir.`;
    useStore.getState().setCaption(`${head} ${result.slice(0, 280)}${result.length > 280 ? '…' : ''}`);
    if (useStore.getState().voiceOn) sayLine(null, summary ? `${head} ${summary}` : head, lang);
  } else {
    const head = lang === 'ko' ? '작업에 실패했습니다.' : "I'm afraid that didn't work, sir.";
    tell(`${head} ${spokenSummary(result, 140)}`.trim(), lang);
  }
}
