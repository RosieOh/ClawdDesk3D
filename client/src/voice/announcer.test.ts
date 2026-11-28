import { describe, expect, it } from 'vitest';
import type { AgentState, Session } from '../store';
import { Announcer, phrase, statusReport, type Announcement } from './announcer';
import { pickVoice } from './speech';
import { effectiveSessions } from './useJarvisVoice';

const MIN = { minTurnMs: 15_000 };

function s(id: string, state: AgentState, extra: Partial<Session> = {}): Session {
  return { id, cwd: `/dev/${id}`, project: id, source: 'cli', state, tool: null, startedAt: 0, lastSeen: 0, ...extra };
}

describe('Announcer', () => {
  it('stays quiet on the first snapshot (baseline)', () => {
    const a = new Announcer();
    expect(a.update([s('app', 'GENERATING'), s('web', 'WAITING')], 0, MIN)).toEqual([]);
  });

  it('announces a long turn finishing, with its duration', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    a.update([s('app', 'GENERATING')], 1_000, MIN);
    a.update([s('app', 'TOOL_RUNNING', { tool: 'Bash' })], 30_000, MIN);
    expect(a.update([s('app', 'IDLE')], 181_000, MIN)).toEqual([
      { kind: 'done', sessionId: 'app', project: 'app', durationMs: 180_000 },
    ]);
  });

  it('keeps quick replies silent', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    a.update([s('app', 'GENERATING')], 1_000, MIN);
    expect(a.update([s('app', 'IDLE')], 5_000, MIN)).toEqual([]);
  });

  it('a turn that started before the baseline still counts from the baseline', () => {
    const a = new Announcer();
    a.update([s('app', 'GENERATING')], 0, MIN);
    expect(a.update([s('app', 'IDLE')], 20_000, MIN)).toHaveLength(1);
  });

  it('asks for permission naming the tool that is waiting', () => {
    const a = new Announcer();
    a.update([s('app', 'TOOL_RUNNING', { tool: 'Bash', lastTool: 'Bash', running: 1 })], 0, MIN);
    expect(a.update([s('app', 'WAITING', { lastTool: 'Bash', running: 1 })], 1_000, MIN)).toEqual([
      { kind: 'permission', sessionId: 'app', project: 'app', tool: 'Bash' },
    ]);
  });

  it('an elicitation with no tool in flight asks generically', () => {
    const a = new Announcer();
    a.update([s('app', 'GENERATING', { lastTool: 'Read', running: 0 })], 0, MIN);
    const [line] = a.update([s('app', 'WAITING', { lastTool: 'Read', running: 0 })], 1_000, MIN);
    expect(line).toMatchObject({ kind: 'permission', tool: null });
  });

  it('a waiting turn counts toward the duration and finishing after it is announced', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    a.update([s('app', 'GENERATING')], 0, MIN);
    a.update([s('app', 'WAITING', { running: 1, lastTool: 'Bash' })], 2_000, MIN);
    a.update([s('app', 'GENERATING')], 40_000, MIN);
    expect(a.update([s('app', 'IDLE')], 41_000, MIN)[0]).toMatchObject({ kind: 'done', durationMs: 41_000 });
  });

  it('reports a failed stop regardless of duration', () => {
    const a = new Announcer();
    a.update([s('app', 'GENERATING')], 0, MIN);
    expect(a.update([s('app', 'IDLE', { lastEvent: 'StopFailure' })], 1_000, MIN)).toEqual([
      { kind: 'failed', sessionId: 'app', project: 'app' },
    ]);
  });

  it('announces sessions that appear after the baseline, but not ones that are already over', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    const lines = a.update([s('app', 'IDLE'), s('web', 'GENERATING'), s('old', 'OFFLINE')], 1_000, MIN);
    expect(lines).toEqual([{ kind: 'started', sessionId: 'web', project: 'web' }]);
  });

  it('announces a session going offline', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    expect(a.update([s('app', 'OFFLINE')], 1_000, MIN)).toEqual([{ kind: 'ended', sessionId: 'app', project: 'app' }]);
    expect(a.update([s('app', 'OFFLINE')], 2_000, MIN)).toEqual([]);
  });

  it('forgets removed sessions, and reset() makes a new baseline', () => {
    const a = new Announcer();
    a.update([s('app', 'IDLE')], 0, MIN);
    a.update([], 1_000, MIN);
    expect(a.update([s('app', 'IDLE')], 2_000, MIN)).toHaveLength(1); // came back: new again
    a.reset();
    expect(a.update([s('x', 'GENERATING')], 3_000, MIN)).toEqual([]);
  });

  it('minTurnMs 0 announces every finished turn (dock demo)', () => {
    const a = new Announcer();
    a.update([s('app', 'GENERATING')], 0, { minTurnMs: 0 });
    expect(a.update([s('app', 'IDLE')], 10, { minTurnMs: 0 })).toHaveLength(1);
  });
});

describe('phrase', () => {
  const done: Announcement = { kind: 'done', sessionId: 'a', project: 'ClawdDesk3D', durationMs: 185_000 };
  const perm: Announcement = { kind: 'permission', sessionId: 'a', project: 'web-app', tool: 'Bash' };

  it('speaks Korean', () => {
    expect(phrase(done, 'ko', false)).toBe('작업을 마쳤습니다. 3분 걸렸습니다.');
    expect(phrase(done, 'ko', true)).toBe('ClawdDesk3D 작업을 마쳤습니다. 3분 걸렸습니다.');
    expect(phrase(perm, 'ko', true)).toBe('web-app에서 Bash 실행 승인이 필요합니다.');
    expect(phrase({ ...perm, tool: null }, 'ko', false)).toBe('확인이 필요합니다.');
    expect(phrase({ kind: 'failed', sessionId: 'a', project: 'x' }, 'ko', false)).toBe('작업이 오류로 중단되었습니다.');
    expect(phrase({ kind: 'started', sessionId: 'a', project: 'x' }, 'ko', false)).toBe('x 세션이 연결되었습니다.');
  });

  it('speaks English and skips sub-minute durations', () => {
    expect(phrase({ ...done, durationMs: 20_000 }, 'en', false)).toBe('Task complete, sir.');
    expect(phrase(done, 'en', true)).toBe('ClawdDesk3D is complete, sir. It took 3 minutes.');
    expect(phrase(perm, 'en', false)).toBe('Sir, I need your authorization to run Bash.');
    expect(phrase(perm, 'en', true)).toBe('Sir, web-app requires your authorization to run Bash.');
    expect(phrase({ ...perm, tool: null }, 'en', false)).toBe('Sir, your attention is required.');
    expect(phrase({ kind: 'failed', sessionId: 'a', project: 'x' }, 'en', true)).toBe("I'm afraid x has stopped with an error, sir.");
    expect(phrase({ kind: 'started', sessionId: 'a', project: 'x' }, 'en', false)).toBe('x is online, sir.');
    expect(phrase({ kind: 'ended', sessionId: 'a', project: 'x' }, 'en', false)).toBe('x has gone offline, sir.');
    expect(phrase({ kind: 'ended', sessionId: 'a', project: 'x' }, 'ko', false)).toBe('x 세션이 종료되었습니다.');
  });
});

describe('pickVoice', () => {
  const v = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;
  const voices = [v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Yuna', 'ko-KR'), v('Google 한국의', 'ko-KR'), v('Thomas', 'fr-FR')];

  it('prefers the named voices, then the language', () => {
    expect(pickVoice(voices, 'ko')?.name).toBe('Yuna');
    expect(pickVoice([v('유나', 'ko-KR'), v('Eddy (한국어(대한민국))', 'ko-KR')], 'ko')?.name).toBe('유나');
    expect(pickVoice(voices, 'en')?.name).toBe('Daniel');
    expect(pickVoice([...voices, v('Daniel (Enhanced)', 'en-GB')], 'en')?.name).toBe('Daniel (Enhanced)');
    expect(pickVoice([...voices, v('Jamie (프리미엄)', 'en-GB')], 'en')?.name).toBe('Jamie (프리미엄)');
    expect(pickVoice([v('Samantha', 'en-US')], 'en')?.name).toBe('Samantha');
    expect(pickVoice([v('Thomas', 'fr-FR')], 'ko')).toBeNull();
  });
});

describe('effectiveSessions', () => {
  it('applies a dock override to the shown session only', () => {
    const sessions = [s('main', 'IDLE'), s('other', 'GENERATING')];
    const out = effectiveSessions({ sessions, primaryId: 'main', override: { state: 'TOOL_RUNNING', tool: 'Edit' }, state: 'TOOL_RUNNING', tool: 'Edit', running: 1 });
    expect(out.map((x) => [x.id, x.state, x.tool])).toEqual([
      ['main', 'TOOL_RUNNING', 'Edit'],
      ['other', 'GENERATING', null],
    ]);
    expect(effectiveSessions({ sessions, primaryId: 'main', override: null, state: 'IDLE', tool: null, running: 0 })).toBe(sessions);
  });
});

describe('statusReport', () => {
  it('reports nothing running', () => {
    expect(statusReport([s('old', 'OFFLINE')], 'en')).toBe('All quiet, sir. No sessions are running.');
    expect(statusReport([], 'ko')).toBe('지금 실행 중인 세션이 없습니다.');
  });

  it('names who is waiting and who is working', () => {
    const list = [s('web-app', 'WAITING'), s('api', 'GENERATING'), s('infra', 'TOOL_RUNNING'), s('docs', 'IDLE')];
    expect(statusReport(list, 'en')).toBe('Sir, 4 sessions are online. web-app is waiting for your approval. api and infra are working.');
    expect(statusReport(list, 'ko')).toBe('세션 4개가 연결되어 있습니다. web-app에서 승인을 기다리고 있습니다. api, infra 작업 중입니다.');
  });

  it('everyone idle', () => {
    expect(statusReport([s('a', 'IDLE')], 'en')).toBe('Sir, 1 session is online. It is standing by.');
    expect(statusReport([s('a', 'IDLE'), s('b', 'IDLE')], 'en')).toBe('Sir, 2 sessions are online. All are standing by.');
  });
});
