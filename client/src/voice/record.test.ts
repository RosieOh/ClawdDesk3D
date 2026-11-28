import { describe, expect, it } from 'vitest';
import { DEFAULT_RECORD, Endpointer, encodeWav } from './record';

function run(levels: Array<[ms: number, rms: number]>) {
  const ep = new Endpointer(DEFAULT_RECORD);
  let t = 0;
  for (const [ms, rms] of levels) {
    for (let x = 0; x < ms; x += 40) {
      const r = ep.feed(t, rms);
      if (r !== 'continue') return { r, t };
      t += 40;
    }
  }
  return { r: 'continue', t };
}

describe('Endpointer', () => {
  it('stops after a pause once something was said', () => {
    const { r, t } = run([[600, 0.003], [1500, 0.08], [2000, 0.003]]);
    expect(r).toBe('stop');
    expect(t).toBeGreaterThanOrEqual(2100 + 1200 - 40);
    expect(t).toBeLessThan(2100 + 1200 + 100);
  });

  it('gives up when nothing is said', () => {
    expect(run([[6000, 0.003]]).r).toBe('nothing');
  });

  it('short pauses inside a sentence do not end it', () => {
    expect(run([[300, 0.003], [800, 0.08], [700, 0.003], [800, 0.08], [400, 0.003]]).r).toBe('continue');
  });

  it('caps long recordings', () => {
    const { r, t } = run([[200, 0.003], [20_000, 0.08]]);
    expect(r).toBe('stop');
    expect(t).toBeGreaterThanOrEqual(DEFAULT_RECORD.maxMs);
  });
});

describe('encodeWav', () => {
  it('writes a 16 kHz mono PCM16 WAV, resampled', async () => {
    const blob = encodeWav(new Float32Array(48_000).fill(0.5), 48_000); // 1 s at 48 kHz
    const buf = new DataView(await blob.arrayBuffer());
    expect(String.fromCharCode(...new Uint8Array(buf.buffer, 0, 4))).toBe('RIFF');
    expect(buf.getUint32(24, true)).toBe(16_000);
    expect(buf.getUint16(22, true)).toBe(1);
    expect(buf.getUint32(40, true)).toBe(16_000 * 2);
    expect(buf.getInt16(44, true)).toBe(16383); // 0.5 × 32767, truncated by Int16Array
  });
});
