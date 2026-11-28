import { describe, expect, it } from 'vitest';
import { parseIntent, spokenSummary, stripWake } from './intents';

describe('parseIntent', () => {
  it('strips the wake word', () => {
    expect(stripWake('Hey Jarvis, run the tests')).toBe('run the tests');
    expect(stripWake('자비스 테스트 돌려줘')).toBe('테스트 돌려줘');
    expect(stripWake('run the tests')).toBe('run the tests');
  });

  it('handles status, mute and cancel on the desk', () => {
    for (const t of ['status', 'Jarvis, status?', "What's the status?", 'how is it going', '상태 알려줘', '자비스, 지금 상황 어때?', '보고해줘'])
      expect(parseIntent(t), t).toEqual({ kind: 'status' });
    for (const t of ['Be quiet.', 'mute', '조용히 해줘']) expect(parseIntent(t), t).toEqual({ kind: 'mute' });
    for (const t of ['never mind', 'Cancel.', '취소']) expect(parseIntent(t), t).toEqual({ kind: 'cancel' });
  });

  it('sends everything else to Claude, wake word removed', () => {
    expect(parseIntent('Jarvis, run the tests and tell me what fails.')).toEqual({
      kind: 'claude',
      prompt: 'run the tests and tell me what fails.',
    });
    expect(parseIntent('자비스 README 오타 고쳐줘')).toEqual({ kind: 'claude', prompt: 'README 오타 고쳐줘' });
  });

  it('ignores silence and filler that Whisper hallucinates', () => {
    for (const t of ['', '   ', 'Jarvis', 'Thank you.', 'you', 'uh']) expect(parseIntent(t), JSON.stringify(t)).toEqual({ kind: 'none' });
  });
});

describe('spokenSummary', () => {
  it('drops code and markdown and keeps short answers whole', () => {
    expect(spokenSummary('All **12** tests pass. Run `npm test` again?\n```\nok\n```')).toBe('All 12 tests pass. Run npm test again?');
  });

  it('cuts long answers at a sentence boundary', () => {
    const long = 'The build failed in the client package. ' + 'It is missing a dependency on three-stdlib which the scene imports. '.repeat(5);
    const s = spokenSummary(long, 120);
    expect(s.length).toBeLessThanOrEqual(121);
    expect(s.endsWith('.')).toBe(true);
  });
});
