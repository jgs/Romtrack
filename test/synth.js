// Synthetic joint-angle trajectories with known ground truth, used by tests and the benchmark.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate a set of repetitions.
 * @returns {{samples: {t:number, angle:number}[], truth: {peakAngle:number, complete:boolean}[]}}
 */
export function generateSet({
  rest = 15,
  target = 150,
  reps = 10,
  fps = 30,
  noiseDeg = 3,
  spikeProb = 0.01,
  spikeDeg = 25,
  partialProb = 0.2,
  seed = 1,
} = {}) {
  const rand = mulberry32(seed);
  const dt = 1000 / fps;
  const samples = [];
  const truth = [];
  let t = 0;
  const push = (clean) => {
    let a = clean + gauss(rand) * noiseDeg;
    if (rand() < spikeProb) a += (rand() < 0.5 ? -1 : 1) * spikeDeg;
    samples.push({ t, angle: a });
    t += dt;
  };
  const hold = (angle, ms) => {
    for (let k = 0; k < ms / dt; k++) push(angle);
  };
  const move = (from, to, ms) => {
    const n = Math.max(2, Math.round(ms / dt));
    for (let k = 0; k < n; k++) {
      const u = k / (n - 1);
      push(from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * u))); // smooth ease
    }
  };

  hold(rest, 800 + rand() * 1000);
  for (let i = 0; i < reps; i++) {
    const partial = rand() < partialProb;
    // Complete reps reach 95–105% of target; partial reps 45–75%.
    const frac = partial ? 0.45 + rand() * 0.3 : 0.95 + rand() * 0.1;
    const peak = rest + (target - rest) * frac;
    move(rest, peak, 700 + rand() * 900);
    hold(peak, 150 + rand() * 600);
    move(peak, rest, 700 + rand() * 900);
    hold(rest, 300 + rand() * 900);
    truth.push({ peakAngle: peak, complete: !partial });
  }
  return { samples, truth };
}
