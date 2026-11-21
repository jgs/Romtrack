// One Euro filter (Casiez et al., CHI 2012): low lag when moving fast, strong smoothing when still.
// Applied to joint-angle streams so pose jitter does not create phantom repetitions.

function alpha(cutoff, dtSec) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSec);
}

export class OneEuroFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minCutoff=1.0] Hz — lower = smoother at rest
   * @param {number} [opts.beta=0.02]     speed coefficient — higher = less lag when moving
   * @param {number} [opts.dCutoff=1.0]   Hz — cutoff for the derivative
   */
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param {number} value  @param {number} tMs timestamp in milliseconds */
  filter(value, tMs) {
    if (!Number.isFinite(value)) return this.x ?? value;
    if (this.x === null || this.t === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
