// Benchmark of the counting pipeline on synthetic trajectories with known ground truth.
// Compares the raw signal vs. the One Euro–filtered signal at several noise levels.
//
//   node scripts/benchmark.js            # prints a Markdown table
//
// NOTE: synthetic data validates the signal-processing logic (filter + hysteresis counter).
// It does not measure pose-estimation error on real people; see README → "Validation".

import { OneEuroFilter } from '../src/core/oneEuro.js';
import { RepCounter, RepQuality } from '../src/core/repCounter.js';
import { generateSet } from '../test/synth.js';

const SETS = 500;
const NOISE_LEVELS = [2, 4, 6, 8];
const rest = 15, target = 150;

function run(noiseDeg, useFilter) {
  let exact = 0, absErr = 0, qualOk = 0, qualN = 0, peakErr = 0, peakN = 0, totalTruth = 0;
  for (let seed = 1; seed <= SETS; seed++) {
    const { samples, truth } = generateSet({ rest, target, noiseDeg, spikeProb: 0.01, reps: 10, seed: seed * 7919 + noiseDeg });
    const f = new OneEuroFilter();
    const c = new RepCounter({ rest, target });
    for (const s of samples) c.update(useFilter ? f.filter(s.angle, s.t) : s.angle, s.t);
    totalTruth += truth.length;
    const err = Math.abs(c.reps.length - truth.length);
    absErr += err;
    if (err === 0) {
      exact++;
      c.reps.forEach((r, i) => {
        qualN++;
        if ((r.quality === RepQuality.COMPLETE) === truth[i].complete) qualOk++;
        peakErr += Math.abs(r.peakAngle - truth[i].peakAngle);
        peakN++;
      });
    }
  }
  return {
    exactPct: (exact / SETS) * 100,
    countErrPct: (absErr / totalTruth) * 100,
    qualityAcc: qualN ? (qualOk / qualN) * 100 : NaN,
    peakMae: peakN ? peakErr / peakN : NaN,
  };
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
console.log(`Synthetic benchmark — ${SETS} sets × 10 reps per noise level, 30 fps, 1% outlier spikes (±25°), 20% partial reps\n`);
console.log('| Noise σ | Pipeline | Sets counted exactly | Count error | Complete/partial accuracy | Peak-angle MAE |');
console.log('|---|---|---|---|---|---|');
for (const n of NOISE_LEVELS) {
  for (const useFilter of [false, true]) {
    const r = run(n, useFilter);
    console.log(`| ${n}° | ${useFilter ? 'One Euro + hysteresis' : 'raw + hysteresis'} | ${f1(r.exactPct)}% | ${f1(r.countErrPct)}% | ${f1(r.qualityAcc)}% | ${f1(r.peakMae)}° |`);
  }
}
