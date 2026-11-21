// Gate between raw per-frame angles and the filter/counter.
//
// Real-world sessions showed two failure modes that synthetic noise doesn't cover:
//  1. Tracking gaps (person leaves the frame, joints occluded). When tracking comes back the
//     first frames are often wrong, and a stale filter state turns them into a fake rep.
//  2. Single-frame landmark glitches that make the angle jump by >100° in ~30 ms.
//
// The gate: after a gap it asks the caller to reset filter/counter and skips a short warm-up;
// physically implausible jumps are dropped unless they persist (then they are real motion).

export class SignalGate {
  /**
   * @param {object} [o]
   * @param {number} [o.maxGapMs=400]          a gap longer than this resets the pipeline
   * @param {number} [o.warmupFrames=6]        valid frames to skip after (re)acquiring tracking
   * @param {number} [o.maxSpeedDegPerS=900]   faster apparent motion is treated as a glitch
   * @param {number} [o.maxConsecutiveRejects=3] after this many rejects in a row, accept the new level
   */
  constructor({ maxGapMs = 400, warmupFrames = 6, maxSpeedDegPerS = 900, maxConsecutiveRejects = 3 } = {}) {
    Object.assign(this, { maxGapMs, warmupFrames, maxSpeedDegPerS, maxConsecutiveRejects });
    this.reset();
  }

  reset() {
    this.lastT = null;      // time of the last valid sample
    this.lastAngle = null;  // last accepted raw angle
    this.warmup = this.warmupFrames;
    this.rejects = 0;
  }

  /**
   * @param {number} angle raw angle, or NaN when the joint is not visible
   * @param {number} tMs
   * @returns {{use: boolean, reset: boolean}} `reset`: caller must reset filter and abort an open rep;
   *   `use`: feed this sample to the filter/counter.
   */
  push(angle, tMs) {
    if (!Number.isFinite(angle)) return { use: false, reset: false };

    let reset = false;
    if (this.lastT !== null && tMs - this.lastT > this.maxGapMs) {
      reset = true;
      this.lastAngle = null;
      this.warmup = this.warmupFrames;
      this.rejects = 0;
    }

    if (this.lastAngle !== null) {
      const dt = Math.max((tMs - this.lastT) / 1000, 1e-3);
      const speed = Math.abs(angle - this.lastAngle) / dt;
      if (speed > this.maxSpeedDegPerS && this.rejects < this.maxConsecutiveRejects) {
        this.rejects += 1;
        this.lastT = tMs;
        return { use: false, reset };
      }
    }

    this.rejects = 0;
    this.lastT = tMs;
    this.lastAngle = angle;
    if (this.warmup > 0) {
      this.warmup -= 1;
      return { use: false, reset };
    }
    return { use: true, reset };
  }
}
