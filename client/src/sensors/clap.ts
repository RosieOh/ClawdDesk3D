// Double-clap detection from microphone level frames. Pure logic (no audio APIs), so it can be unit-tested.
//
// A clap is a sharp peak well above the room's noise floor that dies away almost immediately; speech and
// music stay loud for longer, so a candidate is only confirmed once the level has fallen back shortly after.
// Two confirmed claps 150–700 ms apart make a double clap.

export interface ClapOptions {
  /** absolute minimum peak (0..1 full scale) */
  minPeak: number;
  /** a clap must be this many times louder than the noise floor (RMS) */
  overFloor: number;
  /** when to check that the sound has died away (ms after the onset) */
  decayMs: number;
  /** by then the RMS must be below this fraction of the clap's peak */
  decayRatio: number;
  /** allowed gap between the two claps (ms) */
  minGapMs: number;
  maxGapMs: number;
  /** after a double clap, ignore everything for this long (ms) */
  cooldownMs: number;
}

export const DEFAULT_CLAP: ClapOptions = {
  minPeak: 0.2,
  overFloor: 10,
  decayMs: 80,
  decayRatio: 0.12,
  minGapMs: 150,
  maxGapMs: 700,
  cooldownMs: 1200,
};

export class ClapDetector {
  private floor = 0.01;
  private candidate: { t: number; peak: number } | null = null;
  private lastClapAt: number | null = null;
  private quietUntil = 0;

  constructor(private readonly opts: ClapOptions = DEFAULT_CLAP) {}

  /**
   * Feed one analysis frame (~5 ms). `peak` is the max |sample|, `rms` the frame's RMS, both 0..1.
   * Returns true exactly when a double clap completes.
   */
  frame(t: number, peak: number, rms: number): boolean {
    const o = this.opts;

    // Confirm or reject the pending candidate once its decay window has passed.
    if (this.candidate && t - this.candidate.t >= o.decayMs) {
      const c = this.candidate;
      this.candidate = null;
      if (rms < c.peak * o.decayRatio) {
        if (this.lastClapAt != null && c.t - this.lastClapAt >= o.minGapMs && c.t - this.lastClapAt <= o.maxGapMs) {
          this.lastClapAt = null;
          this.quietUntil = t + o.cooldownMs;
          return true;
        }
        this.lastClapAt = c.t;
      } else {
        // Sustained sound (voice, music, a door slam with ringing): not a clap, and it breaks a pair.
        this.lastClapAt = null;
      }
    }
    if (this.lastClapAt != null && t - this.lastClapAt > o.maxGapMs + o.decayMs) this.lastClapAt = null;

    const isOnset = peak >= o.minPeak && peak >= this.floor * o.overFloor;
    if (isOnset && !this.candidate && t >= this.quietUntil) {
      this.candidate = { t, peak };
    } else if (!this.candidate && !isOnset) {
      // Track the room's noise floor only on ordinary frames (slow EMA, ~1 s).
      this.floor = Math.max(0.002, this.floor * 0.995 + rms * 0.005);
    }
    return false;
  }

  get noiseFloor() {
    return this.floor;
  }
}
