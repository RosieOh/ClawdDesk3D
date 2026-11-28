import { describe, expect, it } from 'vitest';
import { ClapDetector } from './clap';

const FRAME = 5; // ms

/** Run frames through a detector; returns the times at which a double clap fired. */
function run(frames: Array<[peak: number, rms: number]>, det = new ClapDetector()) {
  const fired: number[] = [];
  frames.forEach(([p, r], i) => {
    if (det.frame(i * FRAME, p, r)) fired.push(i * FRAME);
  });
  return fired;
}

const quiet = (ms: number): Array<[number, number]> => Array.from({ length: ms / FRAME }, () => [0.02, 0.008]);
/** A clap: one very loud frame, a short tail, then back to the room. */
const clap = (): Array<[number, number]> => [
  [0.8, 0.3],
  [0.3, 0.08],
  [0.05, 0.015],
  ...quiet(85),
];
/** Speech / music: loud for a long time. */
const sustained = (ms: number): Array<[number, number]> => Array.from({ length: ms / FRAME }, () => [0.6, 0.25]);

describe('ClapDetector', () => {
  it('fires once for two claps ~350 ms apart', () => {
    const fired = run([...quiet(1000), ...clap(), ...quiet(250), ...clap(), ...quiet(500)]);
    expect(fired).toHaveLength(1);
  });

  it('a single clap does nothing', () => {
    expect(run([...quiet(1000), ...clap(), ...quiet(2000)])).toEqual([]);
  });

  it('claps too far apart do nothing', () => {
    expect(run([...quiet(1000), ...clap(), ...quiet(900), ...clap(), ...quiet(500)])).toEqual([]);
  });

  it('claps too close together (one clap with an echo) do nothing', () => {
    const echo: Array<[number, number]> = [[0.8, 0.3], ...quiet(20), [0.7, 0.25], ...quiet(200)];
    expect(run([...quiet(1000), ...echo, ...quiet(2000)])).toEqual([]);
  });

  it('sustained loud sound (talking, music) is not a clap and breaks a pending pair', () => {
    expect(run([...quiet(1000), ...sustained(400), ...quiet(200), ...sustained(400), ...quiet(500)])).toEqual([]);
    expect(run([...quiet(1000), ...clap(), ...quiet(50), ...sustained(200), ...clap(), ...quiet(500)])).toEqual([]);
  });

  it('a loud room raises the bar: the same clap is not enough over a high noise floor', () => {
    const noisy = (ms: number): Array<[number, number]> => Array.from({ length: ms / FRAME }, () => [0.15, 0.06]);
    const softClap: Array<[number, number]> = [[0.4, 0.15], [0.1, 0.06], ...noisy(85)];
    expect(run([...noisy(3000), ...softClap, ...noisy(250), ...softClap, ...noisy(500)])).toEqual([]);
  });

  it('cools down after firing, then works again', () => {
    const pair = [...clap(), ...quiet(250), ...clap()];
    const fired = run([...quiet(1000), ...pair, ...quiet(100), ...pair, ...quiet(1500), ...pair, ...quiet(300)]);
    expect(fired).toHaveLength(2);
  });
});
