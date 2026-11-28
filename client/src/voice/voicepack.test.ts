import { describe, expect, it } from 'vitest';
import { clipUrl, parsePack, pickClip } from './voicepack';

describe('parsePack', () => {
  it('keeps known kinds with safe audio paths and defaults the rest', () => {
    const pack = parsePack({
      clips: {
        greeting: ['jarvis/at ur service.wav', 'jarvis/welcome.wav'],
        done: ['jarvis/you got it.wav', '../escape.wav', '/abs.wav', 'jarvis/notes.txt', 42],
        dance: ['jarvis/x.wav'],
        failed: [],
      },
    });
    expect(pack).toEqual({
      name: 'Voice pack',
      volume: 0.9,
      clips: { greeting: ['jarvis/at ur service.wav', 'jarvis/welcome.wav'], done: ['jarvis/you got it.wav'] },
    });
  });

  it('reads name and volume, rejects out-of-range volume', () => {
    expect(parsePack({ name: ' JARVIS ', volume: 0.5, clips: { done: ['a.mp3'] } })).toMatchObject({ name: 'JARVIS', volume: 0.5 });
    expect(parsePack({ volume: 3, clips: { done: ['a.mp3'] } })?.volume).toBe(0.9);
  });

  it('a pack without any usable clip is no pack', () => {
    expect(parsePack({ clips: { done: ['x.txt'] } })).toBeNull();
    expect(parsePack(null)).toBeNull();
    expect(parsePack('nope')).toBeNull();
  });
});

describe('pickClip', () => {
  const pack = parsePack({ clips: { done: ['a.wav', 'b.wav'], started: ['only.wav'] } });

  it('picks from the kind, avoiding an immediate repeat', () => {
    expect(pickClip(pack, 'done', 'a.wav', () => 0)).toBe('b.wav');
    expect(pickClip(pack, 'done', null, () => 0.99)).toBe('b.wav');
    expect(pickClip(pack, 'started', 'only.wav')).toBe('only.wav');
  });

  it('returns null when the kind has no clips, so speech takes over', () => {
    expect(pickClip(pack, 'failed')).toBeNull();
    expect(pickClip(null, 'done')).toBeNull();
  });

  it('encodes each path segment', () => {
    expect(clipUrl('jarvis/at ur service.wav')).toBe('/voicepack/jarvis/at%20ur%20service.wav');
    expect(clipUrl('자비스/a.wav')).toBe(`/voicepack/${encodeURIComponent('자비스')}/a.wav`);
  });
});
