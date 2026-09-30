'use strict';

const css = getComputedStyle(document.documentElement);
const C = (name) => css.getPropertyValue(name).trim();
const COLORS = { down: C('--accent'), up: C('--up'), latency: C('--warn'), drop: C('--bad'), power: C('--good'), muted: C('--muted'), grid: C('--border') };

Chart.defaults.color = COLORS.muted;
Chart.defaults.borderColor = COLORS.grid;
Chart.defaults.font.size = 11;
Chart.defaults.animation = false;

let rangeHours = 24;

// ---- formatting -------------------------------------------------------------

const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
function fmtDuration(s) {
  if (s == null) return '—';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : `${h} h ${m} m`;
}
const clock = (t, withDate) => new Date(t * 1000).toLocaleString([], withDate
  ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pretty = (s) => (s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// ---- charts -----------------------------------------------------------------

function makeChart(id, datasets, opts = {}) {
  const scales = {
    x: { type: 'linear', ticks: { maxTicksLimit: 7, callback: (v) => clock(v, opts.withDate && rangeHours > 24) } },
    y: { beginAtZero: true, ticks: { maxTicksLimit: 6 }, ...(opts.y || {}) },
  };
  if (opts.y2) scales.y2 = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ...opts.y2 };
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { datasets: datasets.map((d) => ({ pointRadius: 0, borderWidth: 1.5, tension: 0.2, spanGaps: false, data: [], ...d })) },
    options: {
      responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 10, boxHeight: 2 } },
        tooltip: { callbacks: { title: (items) => items.length ? clock(items[0].parsed.x, true) : '' } },
      },
      scales,
    },
  });
}

const charts = {
  liveThroughput: makeChart('liveThroughput', [
    { label: 'Download', borderColor: COLORS.down, backgroundColor: COLORS.down + '22', fill: true },
    { label: 'Upload', borderColor: COLORS.up },
  ]),
  liveLatency: makeChart('liveLatency', [
    { label: 'Latency ms', borderColor: COLORS.latency },
    { label: 'Ping drop %', borderColor: COLORS.drop, backgroundColor: COLORS.drop + '33', fill: true, yAxisID: 'y2', stepped: true, tension: 0 },
  ], { y2: { max: 100, ticks: { maxTicksLimit: 5 } } }),
  histThroughput: makeChart('histThroughput', [
    { label: 'Download avg', borderColor: COLORS.down, backgroundColor: COLORS.down + '22', fill: true },
    { label: 'Download peak', borderColor: COLORS.down + '66', borderDash: [3, 3] },
    { label: 'Upload avg', borderColor: COLORS.up },
  ], { withDate: true }),
  histLatency: makeChart('histLatency', [{ label: 'Latency', borderColor: COLORS.latency }], { withDate: true }),
  histDrop: makeChart('histDrop', [{ label: 'Drop', borderColor: COLORS.drop, backgroundColor: COLORS.drop + '33', fill: true }], { withDate: true }),
  histPower: makeChart('histPower', [{ label: 'Power', borderColor: COLORS.power }], { withDate: true }),
};

function setData(chart, series) {
  series.forEach((pts, i) => { chart.data.datasets[i].data = pts; });
  chart.update('none');
}

// ---- live -------------------------------------------------------------------

function tile(label, value, sub = '', cls = '') {
  return `<div class="tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
}

async function refreshLive() {
  let live;
  try {
    live = await (await fetch('/api/live')).json();
  } catch {
    setState(false, 'Monitor unreachable');
    return;
  }
  const s = live.status, h = live.history;
  const fresh = live.lastOk && Date.now() - live.lastOk < 30000;
  setState(fresh, fresh ? 'Online' : `Dish unreachable${live.lastError ? ': ' + live.lastError : ''}`);
  document.getElementById('meta').textContent = s
    ? `${s.softwareVersion || ''} · ${s.hardwareVersion || ''} · updated ${live.lastOk ? new Date(live.lastOk).toLocaleTimeString() : '—'}`
    : '';
  if (!s || !h) return;

  const drop15 = avgOf(h.drop) * 100;
  const lat15 = avgOf(h.latency);
  const power = avgOf(h.power.slice(-60));
  const obs = s.obstructionFraction * 100;
  document.getElementById('tiles').innerHTML = [
    tile('Download now', `${fmt(s.downMbps, 2)}<small> Mbps</small>`, `15-min peak ${fmt(Math.max(0, ...h.down.filter(Number.isFinite)), 1)}`),
    tile('Upload now', `${fmt(s.upMbps, 2)}<small> Mbps</small>`, `15-min peak ${fmt(Math.max(0, ...h.up.filter(Number.isFinite)), 1)}`),
    tile('Latency', `${fmt(s.latencyMs, 0)}<small> ms</small>`, `15-min avg ${fmt(lat15, 1)} ms`, s.latencyMs > 80 ? 'warn' : ''),
    tile('Ping drop', `${fmt(drop15, 2)}<small> %</small>`, 'last 15 min', drop15 > 2 ? 'bad' : drop15 > 0.5 ? 'warn' : 'good'),
    tile('Obstructed', `${fmt(obs, 2)}<small> %</small>`, `over ${fmtDuration(s.obstructionValidS)}`, obs > 1 ? 'warn' : 'good'),
    tile('Uptime', fmtDuration(s.uptimeS), `boot #${s.bootcount ?? '—'} · update reboot ${s.rebootHour ?? '—'}:00`),
    tile('Power draw', `${fmt(power, 0)}<small> W</small>`, 'last minute avg'),
    tile('GPS', `${s.gpsSats ?? '—'}<small> sats</small>`, s.gpsValid ? 'fix valid' : 'no fix', s.gpsValid ? '' : 'bad'),
    tile('Signal', s.snrAboveNoise ? 'Good' : 'Low', `quality ${fmt(s.signalQuality, 2)}`, s.snrAboveNoise ? 'good' : 'bad'),
    tile('Alerts', s.alerts.length ? s.alerts.length : 'None', s.alerts.map(pretty).join(', ') || (s.dlRestricted && s.dlRestricted !== 'NO_LIMIT' ? `DL limit: ${pretty(s.dlRestricted)}` : ''), s.alerts.length ? 'warn' : 'good'),
  ].join('');

  const pts = (arr) => h.t.map((t, i) => ({ x: t, y: arr[i] }));
  setData(charts.liveThroughput, [pts(h.down), pts(h.up)]);
  setData(charts.liveLatency, [pts(h.latency), pts(h.drop.map((v) => (v == null ? null : v * 100)))]);

  document.getElementById('align').innerHTML = `
    <dt>Tilt</dt><dd>${fmt(s.tiltDeg, 1)}°</dd>
    <dt>Pointing</dt><dd>az ${fmt(s.azimuthDeg, 1)}° · el ${fmt(s.elevationDeg, 1)}°</dd>
    <dt>Ideal</dt><dd>az ${fmt(s.desiredAzimuthDeg, 1)}° · el ${fmt(s.desiredElevationDeg, 1)}°</dd>
    <dt>Ethernet</dt><dd>${s.ethSpeedMbps ?? '—'} Mbps</dd>
    <dt>Update</dt><dd>${pretty(s.updateState)}</dd>
    <dt>Download cap</dt><dd>${pretty(s.dlRestricted) || '—'}</dd>`;
}

function avgOf(arr) {
  const f = arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

function setState(ok, text) {
  const el = document.getElementById('state');
  el.className = `pill ${ok ? 'ok' : 'bad'}`;
  el.textContent = text;
}

// ---- history ----------------------------------------------------------------

async function refreshHistory() {
  const samples = await (await fetch(`/api/samples?hours=${rangeHours}`)).json();
  const pts = (key) => samples.map((s) => ({ x: s.t, y: s.offline ? null : s[key] }));
  setData(charts.histThroughput, [pts('down'), pts('downPeak'), pts('up')]);
  setData(charts.histLatency, [pts('latency')]);
  setData(charts.histDrop, [pts('drop')]);
  setData(charts.histPower, [pts('power')]);
}

document.getElementById('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  rangeHours = Number(b.dataset.h);
  document.querySelectorAll('#ranges button').forEach((x) => x.classList.toggle('active', x === b));
  refreshHistory();
});

// ---- outages ----------------------------------------------------------------

async function refreshOutages() {
  const list = await (await fetch('/api/outages')).json();
  document.getElementById('outages').innerHTML = list.length
    ? list.slice(0, 200).map((o) => `<tr><td>${clock(o.start, true)}</td><td>${fmtDuration(o.durationS)}</td><td>${pretty(o.cause)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--muted)">None recorded yet</td></tr>';
}

// ---- obstruction map ----------------------------------------------------------

async function refreshMap() {
  const m = await (await fetch('/api/obstruction')).json();
  const cv = document.getElementById('map');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!m || !m.rows) return;
  const cw = cv.width / m.cols, ch = cv.height / m.rows;
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const v = m.snr[r * m.cols + c];
      if (v < 0) continue; // no data for this patch of sky
      ctx.fillStyle = v >= 1 ? '#3b82c4' : `rgb(229,${Math.round(83 + 120 * v)},75)`;
      ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
  ctx.strokeStyle = '#ffffff22';
  [0.33, 0.66, 1].forEach((f) => { ctx.beginPath(); ctx.arc(cv.width / 2, cv.height / 2, (cv.width / 2 - 1) * f, 0, Math.PI * 2); ctx.stroke(); });
}

// ---- loop -------------------------------------------------------------------

refreshLive(); refreshHistory(); refreshOutages(); refreshMap();
setInterval(refreshLive, 10_000);
setInterval(refreshHistory, 60_000);
setInterval(refreshOutages, 60_000);
setInterval(refreshMap, 10 * 60_000);
