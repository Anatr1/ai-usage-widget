'use strict';

const REFRESH_MS = 60_000; // re-fetch data every minute
const TICK_MS = 30_000; // re-render countdowns every 30s

let lastData = null;
let barMode = 'fuel'; // 'fuel' = bars show remaining and drain; 'usage' = bars fill as you consume
let layout = 'bars'; // 'bars' = stacked bars per provider; 'gauge' = four concentric rings

const $ = (id) => document.getElementById(id);

function fitWindow() {
  requestAnimationFrame(() => window.widget.resize($('card').offsetHeight));
}

function fmtCountdown(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function fmtAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function windowLabel(fallback, minutes) {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Normalizes a usage window: in 'fuel' mode `shown` is what's left, in 'usage' mode what's consumed.
function windowStats(w) {
  if (!w || typeof w.usedPercent !== 'number') return null;
  const expired = w.resetsAt && w.resetsAt <= Date.now();
  const used = expired ? 0 : Math.min(100, Math.max(0, w.usedPercent));
  const remaining = 100 - used;
  return {
    used,
    remaining,
    shown: barMode === 'usage' ? used : remaining,
    expired,
    resetsAt: w.resetsAt || null,
  };
}

function sevClass(remaining) {
  return remaining <= 10 ? 'crit' : remaining <= 30 ? 'warn' : '';
}

function renderRow(label, w, accent) {
  const row = document.createElement('div');
  row.className = 'row';
  const stats = windowStats(w);
  if (!stats) {
    row.innerHTML = `<div class="row-top"><span class="row-label"></span><span class="row-reset">no data</span></div>`;
    row.querySelector('.row-label').textContent = label;
    return row;
  }

  const { expired, shown } = stats;
  const cls = sevClass(stats.remaining);

  const top = document.createElement('div');
  top.className = 'row-top';

  const lbl = document.createElement('span');
  lbl.className = 'row-label';
  lbl.textContent = label;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = `bar-fill ${accent || ''} ${cls}`.trim();
  fill.style.width = `${shown}%`;
  bar.appendChild(fill);

  const pctEl = document.createElement('span');
  pctEl.className = 'row-pct';
  pctEl.textContent = `${Math.round(shown)}%`;

  top.append(lbl, bar, pctEl);

  const reset = document.createElement('div');
  reset.className = 'row-reset';
  if (expired) {
    reset.textContent = 'window reset — unused';
  } else if (w.resetsAt) {
    reset.textContent = `resets ${fmtClock(w.resetsAt)} · in ${fmtCountdown(w.resetsAt - Date.now())}`;
  } else {
    reset.textContent = 'reset time unknown';
  }

  row.append(top, reset);
  return row;
}

function renderProvider(bodyId, planId, data, fiveHourLabel, weekLabel, accent) {
  const body = $(bodyId);
  body.replaceChildren();
  $(planId).textContent = (data && data.plan) || '';

  if (!data || data.error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = data ? data.error : 'no data';
    body.appendChild(err);
    return;
  }

  body.appendChild(renderRow(windowLabel(fiveHourLabel, data.fiveHour && data.fiveHour.windowMinutes), data.fiveHour, accent));
  body.appendChild(renderRow(windowLabel(weekLabel, data.week && data.week.windowMinutes), data.week, accent));

  if (data.extraUsage) {
    const note = document.createElement('div');
    note.className = 'note';
    const { usedCredits, monthlyLimit, currency } = data.extraUsage;
    note.textContent = `extra usage: ${(usedCredits / 100).toFixed(2)} / ${(monthlyLimit / 100).toFixed(0)} ${currency}`;
    body.appendChild(note);
  }

  if (data.capturedAt && Date.now() - data.capturedAt > 2 * 60_000) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `snapshot from ${fmtAgo(data.capturedAt)} (updates when Codex runs)`;
    body.appendChild(note);
  }

  if (data.stale) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `${data.staleReason || 'update failed'} — showing ${fmtAgo(data.fetchedAt)} data`;
    body.appendChild(note);
  }
}

// ----- concentric ring gauge (car-dashboard style) -----

const GAUGE_START = 225; // degrees clockwise from 12 o'clock: opens at the bottom like a speedometer
const GAUGE_SWEEP = 270;

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function ringColor(stats, base) {
  return stats.remaining <= 10 ? '#f87171' : stats.remaining <= 30 ? '#fbbf24' : base;
}

function gaugeRings() {
  const claude = lastData.claude || {};
  const codex = lastData.codex || {};
  return [
    { label: '5h', group: 'claude', stats: windowStats(claude.fiveHour), base: '#d97757' },
    { label: '7d', group: 'claude', stats: windowStats(claude.week), base: '#e8a288' },
    { label: '5h', group: 'codex', stats: windowStats(codex.fiveHour), base: '#69b3a2' },
    { label: '7d', group: 'codex', stats: windowStats(codex.week), base: '#a3d4c6' },
  ];
}

function renderGauge() {
  const rings = gaugeRings();
  const C = 70;
  const radii = [62, 50, 38, 26];

  let svg = '';
  rings.forEach((ring, i) => {
    const r = radii[i];
    svg += `<path d="${arcPath(C, C, r, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}" stroke="rgba(255,255,255,0.09)" stroke-width="9" fill="none" stroke-linecap="round"/>`;
    if (ring.stats) {
      ring.color = ringColor(ring.stats, ring.base);
      if (ring.stats.shown > 0.5) {
        const end = GAUGE_START + (GAUGE_SWEEP * ring.stats.shown) / 100;
        svg += `<path d="${arcPath(C, C, r, GAUGE_START, end)}" stroke="${ring.color}" stroke-width="9" fill="none" stroke-linecap="round"/>`;
      }
    }
  });

  $('gauge-svg').innerHTML = `<svg width="150" height="150" viewBox="0 0 140 140">${svg}</svg>`;

  const legend = $('gauge-legend');
  legend.replaceChildren();
  for (const group of ['claude', 'codex']) {
    const head = document.createElement('div');
    head.className = 'g-head';
    const dot = document.createElement('span');
    dot.className = `dot ${group}-dot`;
    head.append(dot, group === 'claude' ? 'Claude Code' : 'Codex');
    legend.appendChild(head);

    for (const ring of rings.filter((r) => r.group === group)) {
      const row = document.createElement('div');
      row.className = 'g-row';
      const rdot = document.createElement('span');
      rdot.className = 'g-dot';
      if (ring.color) rdot.style.background = ring.color;
      const label = document.createElement('span');
      label.className = 'g-label';
      label.textContent = ring.label;
      const pct = document.createElement('span');
      pct.className = 'g-pct';
      pct.textContent = ring.stats ? `${Math.round(ring.stats.shown)}%` : '—';
      const reset = document.createElement('span');
      reset.className = 'g-reset';
      if (!ring.stats) reset.textContent = 'no data';
      else if (ring.stats.expired) reset.textContent = 'reset';
      else if (ring.stats.resetsAt) reset.textContent = `in ${fmtCountdown(ring.stats.resetsAt - Date.now())}`;
      row.append(rdot, label, pct, reset);
      legend.appendChild(row);
    }
  }

  const notes = $('gauge-notes');
  notes.replaceChildren();
  const addNote = (cls, text) => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    notes.appendChild(el);
  };
  const { claude, codex } = lastData;
  if (claude && claude.error) addNote('error', `Claude: ${claude.error}`);
  if (claude && claude.stale) addNote('note', `Claude: ${claude.staleReason || 'update failed'} — showing ${fmtAgo(claude.fetchedAt)} data`);
  if (codex && codex.error) addNote('error', `Codex: ${codex.error}`);
  if (codex && codex.capturedAt && Date.now() - codex.capturedAt > 2 * 60_000) {
    addNote('note', `Codex snapshot from ${fmtAgo(codex.capturedAt)} (updates when Codex runs)`);
  }
}

function render() {
  if (!lastData) return;
  const gaugeMode = layout === 'gauge';
  $('claude-section').hidden = gaugeMode;
  $('codex-section').hidden = gaugeMode;
  $('gauge-section').hidden = !gaugeMode;
  if (gaugeMode) {
    renderGauge();
  } else {
    renderProvider('claude-body', 'claude-plan', lastData.claude, '5h', '7d', 'claude');
    renderProvider('codex-body', 'codex-plan', lastData.codex, '5h', '7d', '');
  }
  $('status').textContent = `updated ${fmtClock(Date.now())}`;
  fitWindow();
}

async function refresh(force = false) {
  $('status').textContent = 'refreshing…';
  try {
    lastData = await window.widget.getUsage(force);
  } catch (err) {
    lastData = { claude: { error: String(err) }, codex: { error: String(err) } };
  }
  render();
}

async function initPinButton() {
  const btn = $('btn-pin');
  const setState = (pinned) => btn.classList.toggle('active', pinned);
  setState(await window.widget.getPin());
  btn.addEventListener('click', async () => setState(await window.widget.togglePin()));
}

function syncSegButtons() {
  for (const b of document.querySelectorAll('#barmode-seg .seg-btn')) {
    b.classList.toggle('active', b.dataset.mode === barMode);
  }
  for (const b of document.querySelectorAll('#layout-seg .seg-btn')) {
    b.classList.toggle('active', b.dataset.layout === layout);
  }
}

function initSettings() {
  const panel = $('settings-panel');
  $('btn-settings').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    $('btn-settings').classList.toggle('active', !panel.hidden);
    fitWindow();
  });
  for (const b of document.querySelectorAll('#barmode-seg .seg-btn')) {
    b.addEventListener('click', async () => {
      const s = await window.widget.setSettings({ barMode: b.dataset.mode });
      barMode = s.barMode;
      syncSegButtons();
      render();
    });
  }
  for (const b of document.querySelectorAll('#layout-seg .seg-btn')) {
    b.addEventListener('click', async () => {
      const s = await window.widget.setSettings({ layout: b.dataset.layout });
      layout = s.layout;
      syncSegButtons();
      render();
    });
  }
}

$('btn-refresh').addEventListener('click', () => refresh(true));
$('btn-hide').addEventListener('click', () => window.widget.hide());
window.widget.onRefreshRequested(() => refresh(true));

(async function init() {
  initPinButton();
  initSettings();
  try {
    const s = await window.widget.getSettings();
    barMode = s.barMode || 'fuel';
    layout = s.layout || 'bars';
  } catch {
    /* defaults are fine */
  }
  syncSegButtons();
  refresh();
  setInterval(() => refresh(false), REFRESH_MS);
  setInterval(render, TICK_MS);
})();
