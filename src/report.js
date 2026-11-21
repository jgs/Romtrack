// Report rendering, chart, downloads and local session history (DOM side).

import { t, getLang } from './i18n.js';
import { repsToCsv } from './core/session.js';

const HISTORY_KEY = 'romtrack.history.v1';

const fmt = (x, unit = '') => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x}${unit}`);

export function renderReport({ summary, reps, trace }) {
  const $ = (id) => document.getElementById(id);
  const durationS = Math.round((summary.endedAt - summary.startedAt) / 1000);
  const date = new Date(summary.startedAt).toLocaleString(getLang());

  $('reportTitle').textContent = `${t('ex.' + summary.exerciseId)} · ${t('side_' + summary.side)}`;
  $('reportMeta').textContent = `${t('date')}: ${date} · ${t('duration')}: ${Math.floor(durationS / 60)}m ${durationS % 60}s · ${t('target')}: ${summary.target}° · ${t('rest')}: ${summary.rest}°`;

  const flags = Object.entries(summary.flagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${t('flag.' + f)} (${n})`)
    .join(' · ');
  const drift = summary.romDriftDeg;
  const cards = [
    [t('total_reps'), fmt(summary.totalReps)],
    [t('complete_reps'), fmt(summary.completeReps)],
    [t('completion_rate'), fmt(summary.completionRate, '%')],
    [t('mean_rom'), fmt(summary.meanRomDeg, '°')],
    [t('max_rom'), fmt(summary.maxRomDeg, '°')],
    [t('best_angle'), fmt(summary.bestPeakAngle, '°')],
    [t('mean_time'), fmt(summary.meanDurationS, ' s')],
    [t('rom_drift'), drift === null ? '—' : `${drift > 0 ? '+' : ''}${drift}°`],
  ];
  const cardsEl = $('summaryCards');
  cardsEl.replaceChildren(
    ...cards.map(([k, v]) => card(k, v)),
    card(t('compensations'), flags || t('none'), true),
  );

  drawChart($('chart'), trace, summary, reps);
  renderTable($('repTable'), reps);
}

function card(k, v, wide = false) {
  const el = document.createElement('div');
  el.className = 'card' + (wide ? ' wide' : '');
  const kEl = document.createElement('div');
  kEl.className = 'k';
  kEl.textContent = k;
  const vEl = document.createElement('div');
  vEl.className = 'v' + (wide ? ' small' : '');
  vEl.textContent = v;
  el.append(kEl, vEl);
  return el;
}

function renderTable(table, reps) {
  const head = ['col_rep', 'col_duration', 'col_peak', 'col_rom', 'col_target', 'col_quality', 'col_flags'];
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = t(h);
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of reps) {
    const tr = document.createElement('tr');
    const cells = [r.index, (r.durationMs / 1000).toFixed(1), `${r.peakAngle}°`, r.romDeg, `${r.targetPct}%`];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    const q = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${r.quality}`;
    pill.textContent = t('quality_' + r.quality);
    q.append(pill);
    const f = document.createElement('td');
    f.textContent = r.flags.filter((x) => x !== 'target_not_reached').map((x) => t('flag.' + x)).join(', ') || '—';
    tr.append(q, f);
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

/** Angle-vs-time chart with rest/target guides and shaded repetitions. */
export function drawChart(canvas, trace, { rest, target }, reps = []) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 1000;
  const cssH = Math.round(cssW * 0.28);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const w = cssW - pad.l - pad.r, h = cssH - pad.t - pad.b;
  if (!trace.length) return;
  const t0 = trace[0].t, t1 = trace[trace.length - 1].t || t0 + 1;
  const angles = trace.map((p) => p.angle).filter(Number.isFinite);
  const lo = Math.floor(Math.min(rest, target, ...angles) / 10) * 10;
  const hi = Math.ceil(Math.max(rest, target, ...angles) / 10) * 10;
  const x = (tt) => pad.l + ((tt - t0) / Math.max(t1 - t0, 1)) * w;
  const y = (a) => pad.t + (1 - (a - lo) / Math.max(hi - lo, 1)) * h;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#5d6b68';
  ctx.strokeStyle = '#e1e6e4';
  ctx.lineWidth = 1;
  for (let a = lo; a <= hi; a += hi - lo > 100 ? 30 : 10) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(a));
    ctx.lineTo(pad.l + w, y(a));
    ctx.stroke();
    ctx.fillText(`${a}°`, 6, y(a) + 4);
  }
  const secs = (t1 - t0) / 1000;
  const stepS = secs > 300 ? 60 : secs > 60 ? 15 : 5;
  for (let s = 0; s <= secs; s += stepS) ctx.fillText(`${s}s`, x(t0 + s * 1000) - 8, cssH - 8);

  for (const r of reps) {
    ctx.fillStyle = r.quality === 'complete' ? 'rgba(21,128,61,0.08)' : 'rgba(180,83,9,0.10)';
    ctx.fillRect(x(r.startMs), pad.t, Math.max(1, x(r.endMs) - x(r.startMs)), h);
  }

  const guide = (a, color, label) => {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(a));
    ctx.lineTo(pad.l + w, y(a));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(label, pad.l + w - ctx.measureText(label).width - 4, y(a) - 4);
  };
  guide(target, '#0f766e', `${t('target')} ${target}°`);
  guide(rest, '#94a3b8', `${t('rest')} ${rest}°`);

  ctx.strokeStyle = '#14201e';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  for (const p of trace) {
    if (!Number.isFinite(p.angle)) { started = false; continue; }
    if (!started) { ctx.moveTo(x(p.t), y(p.angle)); started = true; }
    else ctx.lineTo(x(p.t), y(p.angle));
  }
  ctx.stroke();
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCsv(reps, summary) {
  download(`romtrack_${summary.exerciseId}_${stamp(summary.startedAt)}.csv`, repsToCsv(reps), 'text/csv');
}

export function exportJson(session) {
  download(`romtrack_${session.summary.exerciseId}_${stamp(session.summary.startedAt)}.json`, JSON.stringify(session, null, 2), 'application/json');
}

function stamp(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

// ---- History (per browser, best effort) ----

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveToHistory(summary) {
  try {
    const h = loadHistory();
    h.unshift(summary);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 50)));
  } catch {
    /* storage unavailable: history is optional */
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

export function renderHistory(container) {
  const h = loadHistory();
  if (!h.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('history_empty');
    container.replaceChildren(p);
    return;
  }
  container.replaceChildren(
    ...h.slice(0, 12).map((s) => {
      const row = document.createElement('div');
      row.className = 'history-item';
      const left = document.createElement('span');
      left.textContent = `${new Date(s.startedAt).toLocaleDateString(getLang())} · ${t('ex.' + s.exerciseId)}`;
      const right = document.createElement('b');
      right.textContent = `${s.completeReps}/${s.totalReps} · ${fmt(s.bestPeakAngle, '°')}`;
      row.append(left, right);
      return row;
    }),
  );
}
