'use strict';
// Starlink monitor: polls the dish's local gRPC API through grpcurl, keeps
// 7 days of 1-minute samples on disk, and serves a dashboard + JSON API.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 7000);
const DISH = process.env.DISH || '192.168.100.1:9200';
// The Starlink router (Gen 2/3) has the same API on :9000; '' turns the router section off.
const ROUTER = process.env.ROUTER ?? '192.168.1.1:9000';
const GRPCURL = process.env.GRPCURL || '/usr/local/bin/grpcurl';
// Other monitors to pass through, e.g. SITES=cottage=http://100.116.224.43:7000 serves that one's dashboard and API
// at /sites/cottage/ (so one address, with CORS, reaches a dish this server can't).
const SITES = Object.fromEntries((process.env.SITES || '').split(',').map((x) => x.trim().split('='))
  .filter(([k, v]) => k && v).map(([k, v]) => [k, v.replace(/\/$/, '')]));
const DATA_DIR = path.join(__dirname, 'data');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.jsonl');
const OUTAGES_FILE = path.join(DATA_DIR, 'outages.json');
const REBOOTS_FILE = path.join(DATA_DIR, 'reboots.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHART_JS = path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.min.js');

const LIVE_INTERVAL_MS = 10_000;
const ROUTER_INTERVAL_MS = 15_000;
const SAMPLE_INTERVAL_MS = 60_000;
const MAP_INTERVAL_MS = 10 * 60_000;
const SAMPLE_RETENTION_S = 7 * 86400;
const OUTAGE_RETENTION_S = 30 * 86400;
const GPS_TO_UNIX_S = 315964800 - 18; // GPS epoch offset minus leap seconds

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- dish access ---------------------------------------------------------

function dish(request, target = DISH) {
  return new Promise((resolve, reject) => {
    execFile(
      GRPCURL,
      ['-plaintext', '-max-time', '8', '-d', JSON.stringify(request), target, 'SpaceX.API.Device.Device/Handle'],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().slice(0, 200)));
        try {
          // grpcurl prints bare NaN/Infinity, which JSON.parse rejects
          resolve(JSON.parse(stdout.replace(/:\s*-?(NaN|Infinity)\b/g, ': null')));
        } catch (e) {
          reject(new Error('bad JSON from dish: ' + e.message));
        }
      },
    );
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v != null && Number.isFinite(+v) ? +v : null);
const avg = (arr) => {
  const f = arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
};

// The dish history is a 900-slot ring buffer; `current` counts total writes.
function unrollHistory(h) {
  const current = Number(h.current || 0);
  const fields = ['downlinkThroughputBps', 'uplinkThroughputBps', 'popPingLatencyMs', 'popPingDropRate', 'powerIn'];
  const n = (h.popPingLatencyMs || []).length;
  const count = Math.min(current, n);
  const start = current > n ? current % n : 0;
  const now = Math.floor(Date.now() / 1000);
  const out = { t: [], down: [], up: [], latency: [], drop: [], power: [] };
  const keys = ['down', 'up', 'latency', 'drop', 'power'];
  for (let i = 0; i < count; i++) {
    const idx = (start + i) % n;
    out.t.push(now - (count - 1 - i));
    fields.forEach((f, k) => out[keys[k]].push(num((h[f] || [])[idx])));
  }
  out.down = out.down.map((v) => (v == null ? null : v / 1e6));
  out.up = out.up.map((v) => (v == null ? null : v / 1e6));
  // latency is meaningless for seconds where every ping dropped
  out.latency = out.latency.map((v, i) => (out.drop[i] >= 1 || !v ? null : v));
  return out;
}

function summarizeStatus(s) {
  const obs = s.obstructionStats || {};
  const gps = s.gpsStats || {};
  const al = s.alignmentStats || {};
  const info = s.deviceInfo || {};
  return {
    uptimeS: num((s.deviceState || {}).uptimeS),
    downMbps: (num(s.downlinkThroughputBps) || 0) / 1e6,
    upMbps: (num(s.uplinkThroughputBps) || 0) / 1e6,
    latencyMs: num(s.popPingLatencyMs),
    signalQuality: num(s.signalQuality),
    snrAboveNoise: s.isSnrAboveNoiseFloor ?? null,
    obstructionFraction: num(obs.fractionObstructed) || 0,
    obstructionValidS: num(obs.validS),
    gpsValid: gps.gpsValid ?? null,
    gpsSats: num(gps.gpsSats),
    tiltDeg: num(al.tiltAngleDeg),
    azimuthDeg: num(s.boresightAzimuthDeg),
    elevationDeg: num(s.boresightElevationDeg),
    desiredAzimuthDeg: num(al.desiredBoresightAzimuthDeg),
    desiredElevationDeg: num(al.desiredBoresightElevationDeg),
    ethSpeedMbps: num(s.ethSpeedMbps),
    dlRestricted: s.dlBandwidthRestrictedReason || null,
    ulRestricted: s.ulBandwidthRestrictedReason || null,
    softwareVersion: info.softwareVersion || null,
    hardwareVersion: info.hardwareVersion || null,
    bootcount: num(info.bootcount),
    lastBootReason: info.boot?.lastReason || null,
    updateState: s.softwareUpdateState || null,
    rebootHour: num((s.config || {}).swupdateRebootHour),
    alerts: Object.keys(s.alerts || {}).filter((k) => s.alerts[k] === true),
    disablement: s.disablementCode || null,
  };
}

// ---- state + persistence ---------------------------------------------------

const state = {
  status: null,
  history: null,
  lastOk: null,
  lastError: null,
  obstructionMap: null,
  samples: [],
  outages: new Map(), // start second -> outage
  reboots: [], // dish and router boots, oldest first
  router: null,
  routerOk: null,
  routerError: null,
};

// ---- router ------------------------------------------------------------------

const BANDS = { RF_2GHZ: '2.4 GHz', RF_5GHZ: '5 GHz', RF_5GHZ_HIGH: '5 GHz high', ETH: 'Ethernet' };
// This server's own addresses, to name it in the client list (the router often has no host name for it).
function ownIps() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(a.address);
  return out;
}
const pos = (v) => (num(v) == null ? null : Math.max(0, num(v)));

function summarizeRouter(w) {
  const info = w.deviceInfo || {};
  const own = ownIps();
  const leases = new Map();
  for (const d of w.dhcpServers || []) for (const l of d.leases || []) leases.set(l.ipAddress, l);
  const clients = (w.clients || [])
    .filter((c) => c.role !== 'CONTROLLER')
    .map((c) => {
      const rx = c.rxStats || {}, tx = c.txStats || {};
      const eth = c.iface === 'ETH';
      // rx/tx are the router's view: rx = from the client (its upload), tx = to the client (its download).
      // Ethernet clients have no byte counters; downloadMb is plausible there, uploadMb is not (petabytes), so only down.
      const ip = c.ipAddress || null;
      return {
        id: String(c.clientId || c.macAddress),
        name: c.name || leases.get(ip)?.hostname || (own.has(ip) ? `${os.hostname()} (this server)` : null),
        ip,
        mac: c.macAddress || null,
        band: BANDS[c.iface] || c.iface || null,
        signal: num(c.signalStrength),
        snr: num(c.snr),
        width: num(c.channelWidth),
        linkDown: pos(tx.rateMbpsLast15s ?? tx.rateMbps),
        linkUp: pos(rx.rateMbpsLast15s ?? rx.rateMbps),
        nowDown: pos(tx.throughputMbpsLast15sAvg),
        nowUp: pos(rx.throughputMbpsLast15sAvg),
        bytesDown: eth ? (num(c.downloadMb) != null ? num(c.downloadMb) * 1e6 : null) : num(tx.bytes),
        bytesUp: eth ? null : num(rx.bytes),
        connectedS: num(c.associatedTimeS),
        idleS: num(c.noDataIdleS),
        hops: num(c.hopsFromController),
      };
    });
  const nets = (w.config?.networks || []).map((n) => ({
    subnet: n.ipv4 || null,
    ssids: [...new Set((n.basicServiceSets || []).map((b) => b.ssid))],
    bands: (n.basicServiceSets || []).map((b) => BANDS[b.band] || b.band),
  }));
  return {
    id: info.id || null,
    hardware: info.hardwareIndex ? info.hardwareIndex.replace(/^ROUTER_GEN_/, 'Gen ') : info.hardwareVersion || null,
    softwareVersion: info.softwareVersion || null,
    uptimeS: num(w.deviceState?.uptimeS),
    bootcount: num(info.bootcount),
    lastBootReason: info.boot?.lastReason || null,
    wanIp: w.ipv4WanAddress || null,
    publicIp: w.publicIpv4 || null,
    pingMs: num(w.pingLatencyMs),
    popPingMs: num(w.popPingLatencyMs),
    dishPingMs: num(w.dishPingLatencyMs),
    poeW: num(w.poeStats?.poePower),
    poeV: num(w.poeStats?.vsnsVin),
    updateState: w.softwareUpdateStats?.state || null,
    alerts: Object.entries(w.alerts || {}).filter(([, v]) => v === true).map(([k]) => k),
    networks: nets,
    clients,
  };
}

async function pollRouter() {
  try {
    const r = await dish({ get_status: {} }, ROUTER);
    state.router = summarizeRouter(r.wifiGetStatus || {});
    recordBoot('router', state.router);
    state.routerOk = Date.now();
    state.routerError = null;
  } catch (e) {
    state.routerError = e.message;
  }
}

function loadPersisted() {
  const cutoff = Date.now() / 1000 - SAMPLE_RETENTION_S;
  if (fs.existsSync(SAMPLES_FILE)) {
    for (const line of fs.readFileSync(SAMPLES_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (s.t >= cutoff) state.samples.push(s);
      } catch { /* skip corrupt line */ }
    }
  }
  if (fs.existsSync(OUTAGES_FILE)) {
    try {
      for (const o of JSON.parse(fs.readFileSync(OUTAGES_FILE, 'utf8'))) state.outages.set(o.start, o);
    } catch { /* start fresh */ }
  }
  if (fs.existsSync(REBOOTS_FILE)) {
    try {
      state.reboots = JSON.parse(fs.readFileSync(REBOOTS_FILE, 'utf8'));
    } catch { /* start fresh */ }
  }
  console.log(`loaded ${state.samples.length} samples, ${state.outages.size} outages, ${state.reboots.length} reboots`);
}

function compactSamplesFile() {
  const cutoff = Date.now() / 1000 - SAMPLE_RETENTION_S;
  state.samples = state.samples.filter((s) => s.t >= cutoff);
  const tmp = SAMPLES_FILE + '.tmp';
  fs.writeFileSync(tmp, state.samples.map((s) => JSON.stringify(s)).join('\n') + (state.samples.length ? '\n' : ''));
  fs.renameSync(tmp, SAMPLES_FILE);
}

function saveOutages() {
  const cutoff = Date.now() / 1000 - OUTAGE_RETENTION_S;
  for (const [k, o] of state.outages) if (o.start < cutoff) state.outages.delete(k);
  const tmp = OUTAGES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...state.outages.values()]));
  fs.renameSync(tmp, OUTAGES_FILE);
}

function recordOutages(h) {
  let added = 0;
  for (const o of h.outages || []) {
    const start = Math.round(Number(o.startTimestampNs) / 1e9 + GPS_TO_UNIX_S);
    if (!Number.isFinite(start) || state.outages.has(start)) continue;
    state.outages.set(start, { start, durationS: Number(o.durationNs) / 1e9, cause: o.cause || 'UNKNOWN', didSwitch: !!o.didSwitch });
    added++;
  }
  for (const e of (h.eventLog || {}).events || []) {
    const start = Math.round(Number(e.startTimestampNs) / 1e9);
    if (!Number.isFinite(start) || state.outages.has(start)) continue;
    const reason = String(e.reason || 'EVENT').replace(/^EVENT_REASON_/, '');
    state.outages.set(start, { start, durationS: Number(e.durationNs || 0) / 1e9, cause: reason, event: true });
    added++;
  }
  if (added) saveOutages();
}

// A boot is new when the boot count changed (or, without one, the boot time moved by over 2 minutes). Kept for good:
// a few a week. Software updates reboot in the night (dish: around its rebootHour), so this shows when they happen.
function recordBoot(device, s) {
  if (!s || s.uptimeS == null) return;
  const at = Math.round(Date.now() / 1000 - s.uptimeS);
  const last = state.reboots.filter((r) => r.device === device).at(-1);
  if (last && (s.bootcount != null ? last.bootcount === s.bootcount : Math.abs(last.at - at) < 120)) return;
  const boot = {
    device,
    at,
    reason: s.lastBootReason || null,
    softwareVersion: s.softwareVersion || null,
    previousVersion: last ? last.softwareVersion : null,
    bootcount: s.bootcount,
  };
  state.reboots.push(boot);
  console.log(`${device} booted ${new Date(at * 1000).toISOString()}: ${boot.reason}, ${boot.previousVersion || '?'} -> ${boot.softwareVersion}`);
  const tmp = REBOOTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state.reboots));
  fs.renameSync(tmp, REBOOTS_FILE);
}

// ---- pollers ----------------------------------------------------------------

async function pollLive() {
  try {
    const [st, hi] = await Promise.all([dish({ get_status: {} }), dish({ get_history: {} })]);
    state.status = summarizeStatus(st.dishGetStatus || {});
    recordBoot('dish', state.status);
    const h = hi.dishGetHistory || {};
    state.history = unrollHistory(h);
    recordOutages(h);
    state.lastOk = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    console.error('poll failed:', e.message);
  }
}

function recordSample() {
  const fresh = state.lastOk && Date.now() - state.lastOk < 30_000;
  const t = Math.floor(Date.now() / 1000);
  let sample;
  if (!fresh || !state.history) {
    sample = { t, offline: true };
  } else {
    const h = state.history;
    const last = (arr) => arr.slice(-60);
    const s = state.status;
    const r = (v, d = 3) => (v == null ? null : +v.toFixed(d));
    sample = {
      t,
      down: r(avg(last(h.down))),
      up: r(avg(last(h.up))),
      downPeak: r(Math.max(0, ...last(h.down).filter((v) => v != null))),
      latency: r(avg(last(h.latency)), 1),
      drop: r((avg(last(h.drop)) || 0) * 100, 2),
      power: r(avg(last(h.power)), 1),
      obstruction: r(s.obstructionFraction * 100, 3),
      gpsSats: s.gpsSats,
      signal: s.signalQuality,
    };
  }
  if (state.routerOk && Date.now() - state.routerOk < 60_000) {
    sample.clients = state.router.clients.length;
    sample.routerPing = state.router.pingMs == null ? null : +state.router.pingMs.toFixed(1);
  }
  state.samples.push(sample);
  fs.appendFile(SAMPLES_FILE, JSON.stringify(sample) + '\n', (e) => e && console.error('append failed:', e.message));
}

async function pollObstructionMap() {
  try {
    const m = (await dish({ dish_get_obstruction_map: {} })).dishGetObstructionMap || {};
    state.obstructionMap = {
      rows: m.numRows,
      cols: m.numCols,
      snr: (m.snr || []).map((v) => (v == null ? -1 : +(+v).toFixed(2))),
      minElevationDeg: m.minElevationDeg,
      maxThetaDeg: m.maxThetaDeg,
      t: Math.floor(Date.now() / 1000),
    };
  } catch (e) {
    console.error('obstruction map failed:', e.message);
  }
}

// ---- HTTP -----------------------------------------------------------------

function sendJson(res, obj, code = 200) {
  // CORS: lets other dashboards (e.g. the Home Assistant starlink-card) read the API from their own page.
  // Read-only GET data on the LAN, so any origin is fine.
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Downsample to at most `max` points by averaging buckets, so a 7-day view stays light.
function downsample(samples, max) {
  if (samples.length <= max) return samples;
  const size = Math.ceil(samples.length / max);
  const keys = ['down', 'up', 'downPeak', 'latency', 'drop', 'power', 'obstruction', 'gpsSats', 'signal', 'clients', 'routerPing'];
  const out = [];
  for (let i = 0; i < samples.length; i += size) {
    const b = samples.slice(i, i + size);
    const online = b.filter((s) => !s.offline);
    const o = { t: b[b.length - 1].t };
    if (!online.length) o.offline = true;
    else keys.forEach((k) => {
      const vals = online.map((s) => s[k]);
      if (vals.every((v) => v == null)) return;
      o[k] = k === 'downPeak' ? Math.max(...vals.filter((v) => v != null)) : avg(vals);
    });
    out.push(o);
  }
  return out;
}

function proxySite(req, res, base, rest) {
  const up = http.get(base + rest, { timeout: 8000 }, (r) => {
    const headers = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(r.statusCode, headers);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: `site unreachable: ${e.message}` }));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const site = p.match(/^\/sites\/([\w-]+)(\/.*)?$/);
  if (site) {
    const base = SITES[site[1]];
    if (!base) return sendJson(res, { error: 'unknown site' }, 404);
    if (!site[2]) {
      res.writeHead(301, { Location: `${p}/${url.search}` });
      return res.end();
    }
    return proxySite(req, res, base, site[2] + url.search);
  }
  if (p === '/api/live') {
    return sendJson(res, { status: state.status, history: state.history, lastOk: state.lastOk, lastError: state.lastError, dish: DISH });
  }
  if (p === '/api/samples') {
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 24 * 7);
    const cutoff = Date.now() / 1000 - hours * 3600;
    return sendJson(res, downsample(state.samples.filter((s) => s.t >= cutoff), 720));
  }
  if (p === '/api/outages') {
    return sendJson(res, [...state.outages.values()].sort((a, b) => b.start - a.start));
  }
  if (p === '/api/reboots') return sendJson(res, [...state.reboots].reverse());
  if (p === '/api/obstruction') return sendJson(res, state.obstructionMap);
  if (p === '/api/router') {
    return sendJson(res, { enabled: !!ROUTER, router: state.router, lastOk: state.routerOk, lastError: state.routerError, address: ROUTER || null });
  }
  if (p === '/vendor/chart.js') return sendFile(res, CHART_JS);
  const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  sendFile(res, file);
});

loadPersisted();
pollLive().then(() => {
  setInterval(pollLive, LIVE_INTERVAL_MS);
  setInterval(recordSample, SAMPLE_INTERVAL_MS);
});
pollObstructionMap();
setInterval(pollObstructionMap, MAP_INTERVAL_MS);
if (ROUTER) {
  pollRouter();
  setInterval(pollRouter, ROUTER_INTERVAL_MS);
}
setInterval(compactSamplesFile, 6 * 3600_000);
server.listen(PORT, '0.0.0.0', () => console.log(`starlink-monitor on :${PORT}, dish ${DISH}${ROUTER ? `, router ${ROUTER}` : ''}` +
  Object.entries(SITES).map(([k, v]) => `, /sites/${k}/ -> ${v}`).join('')));
