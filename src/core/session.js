// Session aggregation and export (pure, no DOM) so it can be unit-tested.

import { RepQuality } from './repCounter.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Summarise a list of repetitions produced by RepCounter. */
export function summarize(reps, { exerciseId, side, rest, target, startedAt, endedAt } = {}) {
  const complete = reps.filter((r) => r.quality === RepQuality.COMPLETE);
  const roms = reps.map((r) => r.romDeg);
  const flagCounts = {};
  for (const r of reps) for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const half = Math.floor(reps.length / 2);
  // Fatigue indicator: ROM in the second half of the set vs the first half.
  const romDrift = reps.length >= 4 ? r1(mean(roms.slice(half)) - mean(roms.slice(0, half))) : null;
  return {
    exerciseId,
    side,
    rest,
    target,
    startedAt,
    endedAt,
    totalReps: reps.length,
    completeReps: complete.length,
    completionRate: reps.length ? Math.round((complete.length / reps.length) * 100) : null,
    meanRomDeg: r1(mean(roms)),
    maxRomDeg: reps.length ? r1(Math.max(...roms)) : null,
    bestPeakAngle: reps.length
      ? r1(target > rest ? Math.max(...reps.map((r) => r.peakAngle)) : Math.min(...reps.map((r) => r.peakAngle)))
      : null,
    meanDurationS: r1(mean(reps.map((r) => r.durationMs)) / 1000),
    romDriftDeg: romDrift,
    flagCounts,
  };
}

/** Reduce a dense {t, angle} trace to at most `maxPoints` for storage and charting. */
export function downsample(trace, maxPoints = 600) {
  if (trace.length <= maxPoints) return trace.slice();
  const step = trace.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(trace[Math.floor(i * step)]);
  out.push(trace[trace.length - 1]);
  return out;
}

export function repsToCsv(reps) {
  const header = ['rep', 'start_s', 'duration_s', 'start_angle', 'peak_angle', 'rom_deg', 'target_pct', 'quality', 'flags'];
  const rows = reps.map((r) => [
    r.index,
    (r.startMs / 1000).toFixed(2),
    (r.durationMs / 1000).toFixed(2),
    r.startAngle,
    r.peakAngle,
    r.romDeg,
    r.targetPct,
    r.quality,
    `"${r.flags.join(';')}"`,
  ]);
  return [header, ...rows].map((row) => row.join(',')).join('\n');
}
