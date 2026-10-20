//
// metrics.js - Operate's Metrics: a broker's /admin/metrics (Prometheus text) as charts over time
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Sampled every 5 s while the panel is open, from every broker running here with the admin API, so that a
// broker selected later has its last minutes too; 120 samples (10 minutes) kept per broker. A counter is
// drawn as its rate between two samples, a gauge as it is, the request latency as the mean and the 95th
// percentile of the requests in the interval (from the histogram's buckets, interpolated). A read that
// fails is a break in the samples, and so is a request count that goes down (the broker started again):
// no rate across one.
//
import * as api from './api.js';

const PERIOD_MS = 5000;
const SAMPLES_MAX = 120;
const W = 300, H = 56;

const svgNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// parse - the Prometheus text format as a Map: name -> value, and for a histogram's buckets
// name_bucket -> [[le, cumulative count], ...]
//
export function parse(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line[0] === '#') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const v = Number(line.slice(sp + 1));
    const brace = key.indexOf('{');
    if (brace < 0) { m.set(key, v); continue; }
    const name = key.slice(0, brace);
    const le = /le="([^"]*)"/.exec(key);
    if (!le) continue;
    if (!m.has(name)) m.set(name, []);
    m.get(name).push([le[1] === '+Inf' ? Infinity : Number(le[1]), v]);
  }
  return m;
}

//
// The operation counters (ngsild_<op>_total, one per NGSI-LD operation): the reads, everything else a write
//
const OP_RE = /^ngsild_(entity|batch|attr|subscription|registration|csr_sub)_[a-z_]+_total$/;
const READS = new Set(['entity_retrieve', 'entity_query', 'batch_query', 'entity_types_get', 'entity_type_details',
  'entity_type_info', 'attr_types_get', 'attr_type_details', 'attr_type_info', 'subscription_retrieve',
  'subscription_query', 'registration_retrieve', 'registration_query', 'csr_sub_retrieve', 'csr_sub_query']
  .map((n) => 'ngsild_' + n + '_total'));

const isOp = (name) => OP_RE.test(name);
const opLabel = (name) => name.slice(7, -6).replace(/_/g, ' ');

//
// rate - a counter's increase per second between two samples; null when it went down (a restart) or is not there
//
function rate(a, b, name) {
  if (!a.v || !b.v) return null;
  const x = a.v.get(name), y = b.v.get(name);
  if (typeof x !== 'number' || typeof y !== 'number' || y < x) return null;
  return (y - x) / ((b.t - a.t) / 1000);
}

function rateSum(a, b, pick) {
  if (!a.v || !b.v) return null;
  let sum = 0, any = false;
  for (const name of b.v.keys()) {
    if (!pick(name)) continue;
    const r = rate(a, b, name);
    if (r === null) return null;
    sum += r;
    any = true;
  }
  return any ? sum : 0;
}

const gauge = (b, name) => (b.v && typeof b.v.get(name) === 'number' ? b.v.get(name) : null);

//
// sameRun - no break between two samples: both read, the request count not gone down
//
function sameRun(a, b) {
  if (!a.v || !b.v) return false;
  const x = a.v.get('ngsild_request_latency_seconds_count'), y = b.v.get('ngsild_request_latency_seconds_count');
  return !(typeof x === 'number' && typeof y === 'number' && y < x);
}

//
// latency - the mean and the 95th percentile, in ms, of the requests between two samples; null: none
//
function latencyMean(a, b) {
  const n = rate(a, b, 'ngsild_request_latency_seconds_count'), s = rate(a, b, 'ngsild_request_latency_seconds_sum');
  return (n && s !== null) ? (s / n) * 1000 : null;
}

function latencyP95(a, b) {
  if (!a.v || !b.v) return null;
  const x = a.v.get('ngsild_request_latency_seconds_bucket'), y = b.v.get('ngsild_request_latency_seconds_bucket');
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return null;
  const d = y.map(([le, c], i) => [le, c - x[i][1]]);
  const total = d[d.length - 1][1];
  if (!(total > 0) || d.some(([, c]) => c < 0)) return null;
  const want = total * 0.95;
  let lo = 0, below = 0;
  for (const [le, c] of d) {
    if (c >= want) {
      if (le === Infinity) return lo * 1000;                      // past the last bucket: its bound, a floor
      return (lo + (le - lo) * ((want - below) / Math.max(c - below, 1e-9))) * 1000;
    }
    lo = le;
    below = c;
  }
  return null;
}

//
// The charts: a title, a unit, gauge (drawn across a break too), and the series - each a label, a colour
// class and the value of an interval (a: the sample before, b: this one)
//
const CHARTS = [
  { title: 'Requests', unit: '/s', series: [
    { label: 'all',    cls: 's1', f: (a, b) => rate(a, b, 'ngsild_request_latency_seconds_count') },
    { label: 'reads',  cls: 's2', f: (a, b) => rateSum(a, b, (n) => READS.has(n)) },
    { label: 'writes', cls: 's3', f: (a, b) => rateSum(a, b, (n) => isOp(n) && !READS.has(n)) },
  ] },
  { title: 'Errors', unit: '/s', series: [
    { label: '4xx', cls: 's4', f: (a, b) => rate(a, b, 'ngsild_errors_4xx_total') },
    { label: '5xx', cls: 's5', f: (a, b) => rate(a, b, 'ngsild_errors_5xx_total') },
  ] },
  { title: 'Latency', unit: ' ms', series: [
    { label: 'mean', cls: 's1', f: latencyMean },
    { label: 'p95',  cls: 's3', f: latencyP95 },
  ] },
  { title: 'Notifications', unit: '/s', series: [
    { label: 'sent',           cls: 's1', f: (a, b) => rate(a, b, 'ngsild_notifications_sent_total') },
    { label: 'context source', cls: 's2', f: (a, b) => rate(a, b, 'ngsild_csource_notifications_sent_total') },
    { label: 'SSE events',     cls: 's3', f: (a, b) => rate(a, b, 'ngsild_sse_events_total') },
    { label: 'failed',         cls: 's5', f: (a, b) => rateSum(a, b, (n) => n === 'ngsild_notifications_failed_total' || n === 'ngsild_csource_notifications_failed_total') },
  ] },
  { title: 'Subscriptions', unit: '', gauge: true, series: [
    { label: 'entities',       cls: 's1', f: (a, b) => gauge(b, 'ngsild_subscription_cache_size') },
    { label: 'periodic',       cls: 's2', f: (a, b) => gauge(b, 'ngsild_pernot_cache_size') },
    { label: 'context source', cls: 's3', f: (a, b) => gauge(b, 'ngsild_csource_subscription_cache_size') },
    { label: 'SSE streams',    cls: 's4', f: (a, b) => gauge(b, 'ngsild_sse_streams') },
  ] },
  { title: 'Memory', unit: ' MiB', gauge: true, series: [
    { label: 'used',     cls: 's1', f: (a, b) => mibOf(gauge(b, 'ngsild_memory_used_bytes')) },
    { label: 'resident', cls: 's2', f: (a, b) => mibOf(gauge(b, 'ngsild_memory_resident_bytes')) },
    { label: 'budget',   cls: 's5', f: (a, b) => { const v = gauge(b, 'ngsild_memory_budget_bytes'); return v ? mibOf(v) : null; } },
  ] },
];

const mibOf = (v) => (v === null ? null : v / (1024 * 1024));

function fmt(v) {
  if (v === null || v === undefined) return '–';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.01 || a === 0 ? v.toFixed(2) : v.toExponential(1);
}

//
// niceMax - the top of a chart: 1, 2 or 5 times a power of ten, at or above the highest value
//
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export class Metrics {
  constructor() {
    this.samples = new Map();        // broker url -> [{t, v}]
    this.errors = new Map();         // broker url -> why the last read failed
    this.timer = null;
    this.urls = () => [];
    this.onSample = () => {};
  }

  //
  // start - read every PERIOD_MS the brokers urls() names, onSample() after each round; stop - no more
  //
  start(urls, onSample) {
    this.urls = urls;
    this.onSample = onSample;
    if (this.timer) return;
    const round = async () => {
      await Promise.all(this.urls().map((u) => this.read(u)));
      this.onSample();
    };
    this.timer = setInterval(round, PERIOD_MS);
    round();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async read(url) {
    const r = await api.brokerText(url, '/admin/metrics');
    if (!r.ok) {
      this.push(url, null);                                       // a break: no rate across it
      this.errors.set(url, r.reached ? 'GET /admin/metrics: HTTP ' + r.status + (r.status === 403 ? ' - the c3 backend is older than Metrics' : '')
        : 'the broker does not answer');
      return;
    }
    this.errors.delete(url);
    this.push(url, parse(r.text));
  }

  push(url, v) {
    const list = this.samples.get(url) || [];
    if (v === null && (!list.length || list[list.length - 1].v === null)) return;   // one break is enough
    list.push({ t: Date.now(), v });
    if (list.length > SAMPLES_MAX) list.splice(0, list.length - SAMPLES_MAX);
    this.samples.set(url, list);
  }

  //
  // summary - one line for the panel's summary: requests, latency, subscriptions; '' when not known yet
  //
  summary(url) {
    const s = this.samples.get(url) || [];
    if (s.length < 2) return '';
    const a = s[s.length - 2], b = s[s.length - 1];
    if (!sameRun(a, b)) return '';
    const req = rate(a, b, 'ngsild_request_latency_seconds_count');
    const lat = latencyMean(a, b);
    const subs = gauge(b, 'ngsild_subscription_cache_size');
    return [req !== null && fmt(req) + ' req/s', lat !== null && fmt(lat) + ' ms mean', subs !== null && subs + ' subscription' + (subs === 1 ? '' : 's')]
      .filter(Boolean).join(', ');
  }

  //
  // render - the charts of one broker, and its busiest operations over the last minute
  //
  render(url) {
    const box = el('div', 'mx');
    const s = this.samples.get(url) || [];
    const why = this.errors.get(url);
    if (why) box.append(el('div', 'rn-lvnote warn', why));
    if (s.length < 2) {
      if (!why) box.append(el('div', 'rn-lvnote', 'Reading /admin/metrics every 5 s - the first rates after the second read.'));
      return box;
    }
    const span = Math.round((s[s.length - 1].t - s[0].t) / 1000);
    box.append(el('div', 'rn-lvnote', `Every 5 s, the last ${span >= 60 ? Math.round(span / 60) + ' min' : span + ' s'} (10 min kept). A rate is per second over each 5 s.`));

    const grid = el('div', 'mx-grid');
    for (const c of CHARTS) grid.append(this.chart(c, s));
    box.append(grid);
    box.append(this.busiest(s));
    return box;
  }

  chart(c, s) {
    const pts = c.series.map((ser) => s.slice(1).map((b, i) => [b.t, (c.gauge || sameRun(s[i], b)) ? ser.f(s[i], b) : null]));
    if (c.series.every((ser, k) => pts[k].every(([, v]) => v === null))) {
      const empty = el('div', 'mx-chart');
      empty.append(el('div', 'mx-title', c.title), el('div', 'hrange', 'not served by this broker'));
      return empty;
    }
    const box = el('div', 'mx-chart');
    const head = el('div', 'mx-head');
    head.append(el('span', 'mx-title', c.title));
    const now = el('span', 'mx-now');
    c.series.forEach((ser, k) => {
      const last = pts[k].length ? pts[k][pts[k].length - 1][1] : null;
      if (last === null && pts[k].every(([, v]) => v === null)) return;
      const item = el('span', 'mx-item');
      item.append(el('i', 'mx-dot ' + ser.cls), document.createTextNode(ser.label + ' ' + fmt(last) + c.unit));
      now.append(item);
    });
    head.append(now);

    const t1 = s[s.length - 1].t, t0 = Math.min(s[0].t, t1 - 60 * 1000);   // what there is, a minute at least
    const hi = niceMax(Math.max(0, ...pts.flat().map(([, v]) => (v === null ? 0 : v))));
    const x = (t) => Math.max(0, ((t - t0) / (t1 - t0)) * W);
    const y = (v) => H - 2 - (v / hi) * (H - 6);

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'mx-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${c.title}, the last ${s.length} samples, up to ${fmt(hi)}${c.unit}`);
    c.series.forEach((ser, k) => {
      let d = '', pen = false;
      for (const [t, v] of pts[k]) {
        if (v === null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(t).toFixed(1) + ',' + y(v).toFixed(1);
        pen = true;
      }
      if (!d) return;
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', 'mx-line ' + ser.cls);
      svg.append(p);
    });
    const frame = el('div', 'mx-frame');
    frame.append(el('span', 'mx-max', fmt(hi) + c.unit), svg);
    box.append(head, frame);
    return box;
  }

  //
  // busiest - the operations with the most requests over the last minute (up to 12 samples back)
  //
  busiest(s) {
    let i = s.length - 1;
    while ((i > 0) && (i > s.length - 13) && sameRun(s[i - 1], s[i])) i--;
    const b = s[s.length - 1], a = s[i];
    const rows = [...b.v.keys()].filter(isOp).map((n) => [n, rate(a, b, n)]).filter(([, r]) => r > 0).sort((p, q) => q[1] - p[1]).slice(0, 8);
    const box = el('div', 'mx-ops');
    const secs = Math.round((b.t - a.t) / 1000);
    if (a === b || !b.v) {
      box.append(el('div', 'mx-title', 'Busiest operations'), el('div', 'hrange', 'from the next read on'));
      return box;
    }
    box.append(el('div', 'mx-title', `Busiest operations, the last ${secs} s`));
    if (!rows.length) {
      box.append(el('div', 'hrange', 'no NGSI-LD requests'));
      return box;
    }
    const tab = el('table', 'rn-cfgtab');
    for (const [n, r] of rows) {
      const tr = el('tr');
      tr.append(el('td', '', opLabel(n)), el('td', 'v', fmt(r) + '/s'));
      tab.append(tr);
    }
    box.append(tab);
    return box;
  }
}
