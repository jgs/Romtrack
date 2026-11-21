// Repetition counter for a single joint-angle stream.
//
// The angle is normalised to "progress" between the rest angle (0) and the target angle (1),
// which makes the same logic work for movements where the angle increases (shoulder
// abduction, knee extension) or decreases (elbow flexion, squat).
//
// Hysteresis: a repetition starts when progress rises above `startFrac` and only ends when it
// falls back below `endFrac`. Noise that oscillates inside the band can never produce
// a second count.

export const RepQuality = Object.freeze({ COMPLETE: 'complete', PARTIAL: 'partial' });

export class RepCounter {
  /**
   * @param {object} cfg
   * @param {number} cfg.rest    angle (deg) at the resting position
   * @param {number} cfg.target  angle (deg) the therapist wants the patient to reach
   * @param {number} [cfg.startFrac=0.3]     progress needed to start a rep
   * @param {number} [cfg.endFrac=0.15]      progress below which the rep is closed
   * @param {number} [cfg.completeFrac=0.9]  peak progress for a rep to count as complete
   * @param {number} [cfg.minRepMs=800]      reps faster than this are flagged "too_fast"
   * @param {number} [cfg.flagMinShare=0.2]  share of active frames a compensation must be present in
   */
  constructor(cfg) {
    this.configure(cfg);
    this.reset();
  }

  configure({ rest, target, startFrac = 0.3, endFrac = 0.15, completeFrac = 0.9, minRepMs = 800, flagMinShare = 0.2 }) {
    if (!Number.isFinite(rest) || !Number.isFinite(target) || rest === target) {
      throw new Error('RepCounter: rest and target must be finite and different');
    }
    if (!(endFrac < startFrac && startFrac < completeFrac)) {
      throw new Error('RepCounter: expected endFrac < startFrac < completeFrac');
    }
    Object.assign(this, { rest, target, startFrac, endFrac, completeFrac, minRepMs, flagMinShare });
  }

  reset() {
    this.state = 'rest';
    this.reps = [];
    this._restAnchor = null; // last {t, angle} seen inside the rest band
    this._restMin = null; // most rested angle of the current rest phase
    this._cur = null;
  }

  /** Discard an unfinished repetition (e.g. tracking was lost mid-rep). Completed reps are kept. */
  abort() {
    this.state = 'rest';
    this._restAnchor = null;
    this._restMin = null;
    this._cur = null;
  }

  progress(angle) {
    return (angle - this.rest) / (this.target - this.rest);
  }

  /**
   * Feed one smoothed sample.
   * @param {number} angle  degrees
   * @param {number} tMs    timestamp in ms
   * @param {string[]} [flags] compensation flags active in this frame
   * @returns {object|null} the finished repetition, if this sample closed one
   */
  update(angle, tMs, flags = []) {
    if (!Number.isFinite(angle)) return null;
    const p = this.progress(angle);

    if (this.state === 'rest') {
      // Rep timing starts at the last sample inside the rest band (the moment the patient left it);
      // ROM is measured from the most "rested" angle of this rest phase.
      if (p <= this.endFrac || this._restAnchor === null) this._restAnchor = { t: tMs, angle };
      if (this._restMin === null || p < this.progress(this._restMin)) this._restMin = angle;
      if (p >= this.startFrac) {
        this.state = 'active';
        const anchor = this._restAnchor ?? { t: tMs, angle };
        this._cur = {
          startMs: anchor.t,
          startAngle: this._restMin ?? anchor.angle,
          peakProgress: p,
          peakAngle: angle,
          peakMs: tMs,
          frames: 0,
          flagCounts: new Map(),
        };
        this._accumulate(p, angle, tMs, flags);
      }
      return null;
    }

    // active
    this._accumulate(p, angle, tMs, flags);
    if (p <= this.endFrac) {
      const rep = this._finish(tMs, angle);
      this.state = 'rest';
      this._restAnchor = { t: tMs, angle };
      this._restMin = angle;
      this._cur = null;
      return rep;
    }
    return null;
  }

  /** Live info for the UI. */
  live(angle) {
    const p = Number.isFinite(angle) ? this.progress(angle) : NaN;
    return {
      state: this.state,
      progress: p,
      count: this.reps.length,
      complete: this.reps.filter((r) => r.quality === RepQuality.COMPLETE).length,
    };
  }

  _accumulate(p, angle, tMs, flags) {
    const c = this._cur;
    c.frames += 1;
    if (p > c.peakProgress) {
      c.peakProgress = p;
      c.peakAngle = angle;
      c.peakMs = tMs;
    }
    for (const f of flags) c.flagCounts.set(f, (c.flagCounts.get(f) ?? 0) + 1);
  }

  _finish(tMs, angle) {
    const c = this._cur;
    const durationMs = tMs - c.startMs;
    const minFrames = Math.max(2, Math.ceil(c.frames * this.flagMinShare));
    const flags = [...c.flagCounts.entries()].filter(([, n]) => n >= minFrames).map(([f]) => f);
    if (durationMs < this.minRepMs) flags.push('too_fast');
    const quality = c.peakProgress >= this.completeFrac ? RepQuality.COMPLETE : RepQuality.PARTIAL;
    if (quality === RepQuality.PARTIAL) flags.push('target_not_reached');
    const rep = {
      index: this.reps.length + 1,
      startMs: c.startMs,
      peakMs: c.peakMs,
      endMs: tMs,
      durationMs,
      startAngle: round1(c.startAngle),
      peakAngle: round1(c.peakAngle),
      endAngle: round1(angle),
      romDeg: round1(Math.abs(c.peakAngle - c.startAngle)),
      targetPct: Math.round(Math.max(0, c.peakProgress) * 100),
      quality,
      flags,
    };
    this.reps.push(rep);
    return rep;
  }
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
