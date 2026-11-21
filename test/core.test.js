import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jointAngle, tiltFromVertical } from '../src/core/geometry.js';
import { OneEuroFilter } from '../src/core/oneEuro.js';
import { RepCounter, RepQuality } from '../src/core/repCounter.js';
import { EXERCISES, getExercise, autoSide } from '../src/core/exercises.js';
import { summarize, repsToCsv, downsample } from '../src/core/session.js';
import { generateSet } from './synth.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('jointAngle: right angle, straight line, degenerate', () => {
  close(jointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90);
  close(jointAngle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  assert.ok(Number.isNaN(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })));
});

test('tiltFromVertical: upright is 0°, 45° lean', () => {
  close(tiltFromVertical({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }), 0);
  close(tiltFromVertical({ x: 0.6, y: 0.4 }, { x: 0.5, y: 0.5 }), 45);
});

test('OneEuroFilter reduces jitter on a constant signal', () => {
  const f = new OneEuroFilter();
  let maxDev = 0;
  for (let i = 0; i < 300; i++) {
    const noisy = 90 + (i % 2 ? 4 : -4);
    const y = f.filter(noisy, i * 33);
    if (i > 30) maxDev = Math.max(maxDev, Math.abs(y - 90));
  }
  assert.ok(maxDev < 2, `residual jitter ${maxDev.toFixed(2)}° should be < 2°`);
});

test('RepCounter counts a clean increasing movement', () => {
  const c = new RepCounter({ rest: 15, target: 150 });
  const seq = [15, 20, 60, 100, 148, 150, 120, 60, 20, 15];
  let t = 0;
  for (const a of seq) c.update(a, (t += 200));
  assert.equal(c.reps.length, 1);
  assert.equal(c.reps[0].quality, RepQuality.COMPLETE);
  assert.equal(c.reps[0].peakAngle, 150);
});

test('RepCounter measures ROM from the most rested angle, not the band edge', () => {
  const c = new RepCounter({ rest: 15, target: 150 });
  let t = 0;
  for (const a of [12, 15, 30, 60, 100, 152, 100, 40, 20, 12]) c.update(a, (t += 200));
  assert.equal(c.reps[0].startAngle, 12);
  assert.equal(c.reps[0].romDeg, 140);
});

test('RepCounter works for decreasing movements (elbow flexion)', () => {
  const c = new RepCounter({ rest: 165, target: 45 });
  let t = 0;
  for (let r = 0; r < 3; r++) for (const a of [165, 120, 70, 48, 90, 160]) c.update(a, (t += 250));
  assert.equal(c.reps.length, 3);
  assert.ok(c.reps.every((r) => r.quality === RepQuality.COMPLETE));
});

test('RepCounter marks partial reps and fast reps', () => {
  const c = new RepCounter({ rest: 0, target: 100, minRepMs: 800 });
  let t = 0;
  for (const a of [0, 40, 60, 40, 5]) c.update(a, (t += 300)); // peaks at 60%
  for (const a of [0, 95, 0]) c.update(a, (t += 100)); // complete but very fast
  assert.equal(c.reps.length, 2);
  assert.equal(c.reps[0].quality, RepQuality.PARTIAL);
  assert.ok(c.reps[0].flags.includes('target_not_reached'));
  assert.ok(c.reps[1].flags.includes('too_fast'));
});

test('RepCounter hysteresis ignores oscillation inside the band', () => {
  const c = new RepCounter({ rest: 0, target: 100 });
  let t = 0;
  for (let i = 0; i < 50; i++) c.update(i % 2 ? 28 : 17, (t += 33)); // between endFrac and startFrac
  assert.equal(c.reps.length, 0);
});

test('RepCounter only keeps compensations present in enough frames', () => {
  const c = new RepCounter({ rest: 0, target: 100 });
  let t = 0;
  const angles = [0, 35, 50, 70, 90, 95, 90, 70, 50, 35, 20, 5];
  angles.forEach((a, i) => c.update(a, (t += 150), i === 4 ? ['trunk_lean'] : ['elbow_bent']));
  const flags = c.reps[0].flags;
  assert.ok(flags.includes('elbow_bent'));
  assert.ok(!flags.includes('trunk_lean'));
});

test('RepCounter rejects invalid configuration', () => {
  assert.throws(() => new RepCounter({ rest: 10, target: 10 }));
  assert.throws(() => new RepCounter({ rest: 0, target: 90, startFrac: 0.1, endFrac: 0.2 }));
});

test('noisy synthetic sets: count matches ground truth after filtering', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { samples, truth } = generateSet({ seed, noiseDeg: 4, spikeProb: 0.01 });
    const f = new OneEuroFilter();
    const c = new RepCounter({ rest: 15, target: 150 });
    for (const s of samples) c.update(f.filter(s.angle, s.t), s.t);
    assert.equal(c.reps.length, truth.length, `seed ${seed}`);
  }
});

test('every exercise produces a finite angle for a neutral standing pose', () => {
  const lm = neutralPose();
  for (const ex of EXERCISES) {
    for (const side of ['left', 'right']) {
      const m = ex.measure(lm, side);
      assert.ok(Number.isFinite(m.angle), `${ex.id}/${side}`);
      assert.ok(Array.isArray(m.flags));
    }
    assert.ok(ex.targetRange[0] <= ex.target && ex.target <= ex.targetRange[1], `${ex.id} target in range`);
  }
});

test('shoulder abduction: arm raised to horizontal reads ~90°', () => {
  const lm = neutralPose();
  // Person's left arm (image right side, larger x) raised horizontally; hip right below shoulder.
  lm[23] = { x: 0.6, y: 0.6, visibility: 1 };
  lm[24] = { x: 0.4, y: 0.6, visibility: 1 };
  lm[13] = { x: 0.72, y: 0.3, visibility: 1 };
  lm[15] = { x: 0.84, y: 0.3, visibility: 1 };
  const m = getExercise('shoulder_abduction').measure(lm, 'left');
  close(m.angle, 90, 1);
  assert.deepEqual(m.flags, []);
});

test('autoSide picks the more visible side', () => {
  const lm = neutralPose();
  for (const i of [12, 14, 16, 24]) lm[i].visibility = 0.1;
  assert.equal(autoSide(getExercise('shoulder_abduction'), lm), 'left');
});

test('summarize, csv and downsample', () => {
  const c = new RepCounter({ rest: 0, target: 100 });
  let t = 0;
  for (const peak of [100, 98, 60, 95]) for (const a of [0, 50, peak, 50, 0]) c.update(a, (t += 300));
  const s = summarize(c.reps, { rest: 0, target: 100 });
  assert.equal(s.totalReps, 4);
  assert.equal(s.completeReps, 3);
  assert.equal(s.completionRate, 75);
  assert.equal(s.bestPeakAngle, 100);
  assert.equal(repsToCsv(c.reps).split('\n').length, 5);
  const trace = Array.from({ length: 5000 }, (_, i) => ({ t: i, angle: i }));
  assert.ok(downsample(trace, 100).length <= 101);
});

function neutralPose() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  // Facing the camera, unmirrored: patient's left appears on the image's right.
  Object.assign(lm, {
    11: { x: 0.6, y: 0.3, visibility: 1 }, 12: { x: 0.4, y: 0.3, visibility: 1 },
    13: { x: 0.62, y: 0.45, visibility: 1 }, 14: { x: 0.38, y: 0.45, visibility: 1 },
    15: { x: 0.63, y: 0.58, visibility: 1 }, 16: { x: 0.37, y: 0.58, visibility: 1 },
    23: { x: 0.56, y: 0.6, visibility: 1 }, 24: { x: 0.44, y: 0.6, visibility: 1 },
    25: { x: 0.56, y: 0.78, visibility: 1 }, 26: { x: 0.44, y: 0.78, visibility: 1 },
    27: { x: 0.56, y: 0.95, visibility: 1 }, 28: { x: 0.44, y: 0.95, visibility: 1 },
  });
  return lm;
}
