import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveVoicepackPath } from './voicepack-server';

const root = path.resolve('/tmp/pack');

describe('resolveVoicepackPath', () => {
  it('ignores other URLs', () => {
    expect(resolveVoicepackPath('/src/main.tsx', root)).toBeNull();
    expect(resolveVoicepackPath(undefined, root)).toBeNull();
  });

  it('maps encoded names (spaces, Korean) inside the root', () => {
    expect(resolveVoicepackPath('/voicepack/voicepack.json', root)).toBe(path.join(root, 'voicepack.json'));
    expect(resolveVoicepackPath('/voicepack/jarvis/at%20ur%20service.wav?x=1', root)).toBe(path.join(root, 'jarvis/at ur service.wav'));
    expect(resolveVoicepackPath(`/voicepack/${encodeURIComponent('자비스')}/a.mp3`, root)).toBe(path.join(root, '자비스/a.mp3'));
  });

  it('refuses escapes, odd encodings and non-audio files', () => {
    expect(resolveVoicepackPath('/voicepack/../secret.wav', root)).toBe('forbidden');
    expect(resolveVoicepackPath('/voicepack/%2e%2e/%2e%2e/etc/passwd', root)).toBe('forbidden');
    expect(resolveVoicepackPath('/voicepack/a/../../x.wav', root)).toBe('forbidden');
    expect(resolveVoicepackPath('/voicepack/%E0%A4%A', root)).toBe('forbidden');
    expect(resolveVoicepackPath('/voicepack/notes.txt', root)).toBe('forbidden');
    expect(resolveVoicepackPath('/voicepack/', root)).toBe('forbidden');
  });
});
