// ROMtrack — browser app: camera/video → MediaPipe Pose → joint angle → filter → rep counter → report.

import { EXERCISES, getExercise, autoSide, LM } from './core/exercises.js';
import { OneEuroFilter } from './core/oneEuro.js';
import { RepCounter } from './core/repCounter.js';
import { SignalGate } from './core/signalGate.js';
import { summarize, downsample } from './core/session.js';
import { t, setLang, getLang, applyI18n } from './i18n.js';
import { renderReport, exportCsv, exportJson, saveToHistory, renderHistory, clearHistory, drawChart } from './report.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const MIN_VISIBILITY = 0.5;
const AUTO_SIDE_FRAMES = 20;  // frames used to decide the side in "auto" mode
const FLAG_PERSIST = 8;       // frames a compensation must persist before it is shown live

const BODY = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), video: $('video'), overlay: $('overlay'), placeholder: $('placeholder'), statusText: $('statusText'),
  repCount: $('repCount'), repGoal: $('repGoal'), completeCount: $('completeCount'), angleVal: $('angleVal'),
  progressFill: $('progressFill'), feedback: $('feedback'), hint: $('hint'),
  exerciseSel: $('exerciseSel'), sideSel: $('sideSel'), targetRange: $('targetRange'), targetVal: $('targetVal'),
  restVal: $('restVal'), calibrateBtn: $('calibrateBtn'), goalInput: $('goalInput'), fileInput: $('fileInput'),
  soundChk: $('soundChk'), startBtn: $('startBtn'), stopBtn: $('stopBtn'), langBtn: $('langBtn'),
  historyList: $('historyList'), clearHistoryBtn: $('clearHistoryBtn'),
  sessionView: $('sessionView'), reportView: $('reportView'),
};

const state = {
  landmarker: null,
  exercise: EXERCISES[0],
  rest: EXERCISES[0].rest,
  target: EXERCISES[0].target,
  goal: 10,
  running: false,
  source: 'camera',
  stream: null,
  side: null,
  sideVotes: { left: 0, right: 0 },
  filter: new OneEuroFilter({ minCutoff: 1.0, beta: 0.02 }),
  gate: new SignalGate(),
  counter: null,
  trace: [],
  t0: 0,
  lastDetectTs: 0,
  lastVideoTime: -1,
  lastAngle: NaN,
  flagStreak: new Map(),
  feedbackTimer: 0,
  goalAnnounced: false,
  startedAt: 0,
  lastSession: null,
};

// ---------------------------------------------------------------- setup

function init() {
  for (const ex of EXERCISES) {
    const o = document.createElement('option');
    o.value = ex.id;
    els.exerciseSel.append(o);
  }
  refreshTexts();
  selectExercise(EXERCISES[0].id);
  renderHistory(els.historyList);
  bindEvents();
  loadModel();
}

function refreshTexts() {
  applyI18n();
  els.langBtn.textContent = getLang() === 'es' ? 'EN' : 'ES';
  [...els.exerciseSel.options].forEach((o) => (o.textContent = t('ex.' + o.value)));
  els.hint.textContent = `${t(state.exercise.view === 'front' ? 'view_front' : 'view_side')}. ${t('hint.' + state.exercise.id)}`;
  if (!state.landmarker) els.statusText.textContent = t('loading_model');
  else if (!state.running) els.statusText.textContent = t('model_ready');
  renderHistory(els.historyList);
  if (state.lastSession && !els.reportView.hidden) renderReport(state.lastSession);
}

function selectExercise(id) {
  const ex = getExercise(id);
  state.exercise = ex;
  state.rest = ex.rest;
  state.target = ex.target;
  els.exerciseSel.value = id;
  els.targetRange.min = ex.targetRange[0];
  els.targetRange.max = ex.targetRange[1];
  els.targetRange.value = ex.target;
  updateConfigLabels();
  refreshTexts();
}

function updateConfigLabels() {
  els.targetVal.textContent = state.target;
  els.restVal.textContent = Math.round(state.rest);
  els.repGoal.textContent = state.goal;
}

function bindEvents() {
  els.exerciseSel.addEventListener('change', (e) => selectExercise(e.target.value));
  els.targetRange.addEventListener('input', (e) => {
    state.target = Number(e.target.value);
    updateConfigLabels();
    reconfigureCounter();
  });
  els.goalInput.addEventListener('change', (e) => {
    state.goal = Math.max(1, Math.min(100, Number(e.target.value) || 10));
    e.target.value = state.goal;
    updateConfigLabels();
  });
  document.querySelectorAll('input[name="source"]').forEach((r) =>
    r.addEventListener('change', (e) => (state.source = e.target.value)),
  );
  els.calibrateBtn.addEventListener('click', calibrateRest);
  els.startBtn.addEventListener('click', start);
  els.stopBtn.addEventListener('click', stop);
  els.langBtn.addEventListener('click', () => {
    setLang(getLang() === 'es' ? 'en' : 'es');
    refreshTexts();
  });
  els.clearHistoryBtn.addEventListener('click', () => {
    clearHistory();
    renderHistory(els.historyList);
  });
  $('csvBtn').addEventListener('click', () => state.lastSession && exportCsv(state.lastSession.reps, state.lastSession.summary));
  $('jsonBtn').addEventListener('click', () => state.lastSession && exportJson(state.lastSession));
  $('printBtn').addEventListener('click', () => window.print());
  $('newBtn').addEventListener('click', () => {
    els.reportView.hidden = true;
    els.sessionView.hidden = false;
  });
  window.addEventListener('resize', () => {
    if (state.lastSession && !els.reportView.hidden) {
      drawChart($('chart'), state.lastSession.trace, state.lastSession.summary, state.lastSession.reps);
    }
  });
}

async function loadModel() {
  try {
    const { PoseLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const create = (delegate) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    try {
      state.landmarker = await create('GPU');
    } catch {
      state.landmarker = await create('CPU');
    }
    els.statusText.textContent = t('model_ready');
    els.startBtn.disabled = false;
  } catch (err) {
    console.error(err);
    els.statusText.textContent = t('model_error');
  }
}

// ---------------------------------------------------------------- session

function reconfigureCounter() {
  if (!state.counter || state.counter.state !== 'rest') return;
  try {
    state.counter.configure({ rest: state.rest, target: state.target });
  } catch (e) {
    console.warn(e.message);
  }
}

function calibrateRest() {
  if (!Number.isFinite(state.lastAngle)) return;
  const a = Math.round(state.lastAngle);
  // Rest must stay on the opposite side of the target from where it was.
  const dir = Math.sign(state.exercise.target - state.exercise.rest);
  if (Math.sign(state.target - a) !== dir || Math.abs(state.target - a) < 20) return;
  state.rest = a;
  updateConfigLabels();
  reconfigureCounter();
  showFeedback(t('calibrated'), 'good');
}

async function start() {
  if (!state.landmarker || state.running) return;
  try {
    if (state.source === 'camera') {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      els.video.srcObject = state.stream;
      els.stage.classList.add('mirrored');
    } else {
      const file = await pickFile();
      if (!file) return;
      els.video.srcObject = null;
      els.video.src = URL.createObjectURL(file);
      els.stage.classList.remove('mirrored');
      els.video.onended = () => stop();
    }
    await els.video.play();
  } catch (err) {
    console.error(err);
    els.statusText.textContent = t('camera_error');
    return;
  }

  Object.assign(state, {
    running: true,
    side: els.sideSel.value === 'auto' ? null : els.sideSel.value,
    sideVotes: { left: 0, right: 0 },
    counter: new RepCounter({ rest: state.rest, target: state.target }),
    trace: [],
    t0: performance.now(),
    lastVideoTime: -1,
    lastAngle: NaN,
    goalAnnounced: false,
    startedAt: Date.now(),
  });
  state.filter.reset();
  state.gate.reset();
  state.flagStreak.clear();
  els.placeholder.hidden = true;
  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  els.calibrateBtn.disabled = false;
  els.exerciseSel.disabled = els.sideSel.disabled = true;
  updateHud(NaN);
  requestAnimationFrame(loop);
}

function pickFile() {
  return new Promise((resolve) => {
    els.fileInput.value = '';
    els.fileInput.onchange = () => resolve(els.fileInput.files[0] || null);
    els.fileInput.click();
  });
}

function stop() {
  if (!state.running) return;
  state.running = false;
  els.video.pause();
  if (state.stream) {
    state.stream.getTracks().forEach((tr) => tr.stop());
    state.stream = null;
  }
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  els.calibrateBtn.disabled = true;
  els.exerciseSel.disabled = els.sideSel.disabled = false;
  els.placeholder.hidden = false;
  els.statusText.textContent = t('model_ready');

  const reps = state.counter.reps;
  const summary = summarize(reps, {
    exerciseId: state.exercise.id,
    side: state.side ?? 'left',
    rest: Math.round(state.rest),
    target: state.target,
    startedAt: state.startedAt,
    endedAt: Date.now(),
  });
  state.lastSession = { app: 'romtrack', version: 1, summary, reps, trace: downsample(state.trace) };
  if (reps.length) saveToHistory(summary);
  renderHistory(els.historyList);

  els.sessionView.hidden = true;
  els.reportView.hidden = false;
  renderReport(state.lastSession);
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- per-frame

function loop() {
  if (!state.running) return;
  const v = els.video;
  if (v.readyState >= 2 && v.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = v.currentTime;
    processFrame();
  }
  requestAnimationFrame(loop);
}

function processFrame() {
  const v = els.video;
  const now = performance.now();
  const ts = Math.max(now, state.lastDetectTs + 1); // detectForVideo needs strictly increasing timestamps
  state.lastDetectTs = ts;
  const tMs = state.source === 'file' ? v.currentTime * 1000 : now - state.t0;

  const result = state.landmarker.detectForVideo(v, ts);
  const lm = result.landmarks?.[0];
  sizeOverlay();
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);

  if (!lm) {
    state.trace.push({ t: tMs, angle: NaN });
    showFeedback(t('no_person'), 'warn', 400);
    updateHud(NaN);
    return;
  }

  const ex = state.exercise;
  if (!state.side) {
    state.sideVotes[autoSide(ex, lm)] += 1;
    const total = state.sideVotes.left + state.sideVotes.right;
    if (total >= AUTO_SIDE_FRAMES) state.side = state.sideVotes.left >= state.sideVotes.right ? 'left' : 'right';
  }
  const side = state.side ?? autoSide(ex, lm);
  const m = ex.measure(lm, side);
  drawPose(ctx, lm, ex, side, m.visibility >= MIN_VISIBILITY);

  if (m.visibility < MIN_VISIBILITY || !Number.isFinite(m.angle)) {
    state.trace.push({ t: tMs, angle: NaN });
    showFeedback(t('low_visibility'), 'warn', 400);
    updateHud(NaN);
    return;
  }

  const g = state.gate.push(m.angle, tMs);
  if (g.reset) {
    // Tracking came back after a gap: start clean instead of bridging the gap.
    state.filter.reset();
    state.counter.abort();
  }
  if (!g.use) {
    state.trace.push({ t: tMs, angle: NaN });
    updateHud(NaN);
    return;
  }

  const angle = state.filter.filter(m.angle, tMs);
  state.lastAngle = angle;
  state.trace.push({ t: tMs, angle });

  const rep = state.counter.update(angle, tMs, m.flags);
  liveFlags(m.flags);
  if (rep) onRep(rep);
  updateHud(angle);
}

function onRep(rep) {
  const shown = rep.flags.filter((f) => f !== 'target_not_reached');
  if (rep.quality === 'complete' && !shown.length) {
    showFeedback(t('good'), 'good');
    beep(880);
  } else if (rep.quality === 'complete') {
    showFeedback(t('flag.' + shown[0]), 'warn', 1600);
    beep(660);
  } else {
    showFeedback(t('flag.target_not_reached'), 'warn', 1600);
    beep(440);
  }
  if (!state.goalAnnounced && state.counter.reps.length >= state.goal) {
    state.goalAnnounced = true;
    setTimeout(() => showFeedback(t('goal_reached'), 'good', 2500), 1200);
  }
}

function liveFlags(flags) {
  const active = new Set(flags);
  for (const f of [...state.flagStreak.keys()]) if (!active.has(f)) state.flagStreak.delete(f);
  for (const f of flags) {
    const n = (state.flagStreak.get(f) ?? 0) + 1;
    state.flagStreak.set(f, n);
    if (n === FLAG_PERSIST && state.counter.state === 'active') showFeedback(t('flag.' + f), 'warn', 1200);
  }
}

function updateHud(angle) {
  const live = state.counter ? state.counter.live(angle) : { count: 0, complete: 0, progress: NaN };
  els.repCount.textContent = live.count;
  els.completeCount.textContent = live.complete;
  els.angleVal.textContent = Number.isFinite(angle) ? Math.round(angle) : '—';
  const p = Number.isFinite(live.progress) ? Math.max(0, Math.min(1.1, live.progress)) : 0;
  els.progressFill.style.width = `${(p / 1.1) * 100}%`;
  els.progressFill.classList.toggle('reached', p >= 0.9);
}

// ---------------------------------------------------------------- drawing & feedback

function sizeOverlay() {
  const { videoWidth: w, videoHeight: h } = els.video;
  if (w && (els.overlay.width !== w || els.overlay.height !== h)) {
    els.overlay.width = w;
    els.overlay.height = h;
  }
}

function drawPose(ctx, lm, ex, side, good) {
  const W = els.overlay.width, H = els.overlay.height;
  const P = (i) => [lm[i].x * W, lm[i].y * H];
  const scale = Math.max(2, W / 400);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = scale;
  for (const [a, b] of BODY) {
    ctx.beginPath();
    ctx.moveTo(...P(a));
    ctx.lineTo(...P(b));
    ctx.stroke();
  }
  const [ia, ib, ic] = ex.triple.map((name) => LM[side][name]);
  ctx.strokeStyle = good ? '#5eead4' : '#fbbf24';
  ctx.lineWidth = scale * 2.2;
  ctx.beginPath();
  ctx.moveTo(...P(ia));
  ctx.lineTo(...P(ib));
  ctx.lineTo(...P(ic));
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const i of [ia, ib, ic]) {
    ctx.beginPath();
    ctx.arc(...P(i), scale * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function showFeedback(text, kind = '', ms = 900) {
  const el = els.feedback;
  el.textContent = text;
  el.className = `feedback show ${kind}`;
  clearTimeout(state.feedbackTimer);
  state.feedbackTimer = setTimeout(() => (el.className = 'feedback'), ms);
}

let audioCtx = null;
function beep(freq) {
  if (!els.soundChk.checked) return;
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.2);
  } catch {
    /* audio is optional */
  }
}

init();
