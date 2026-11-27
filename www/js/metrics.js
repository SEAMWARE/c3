//
// metrics.js - Operate's Metrics: a broker's /admin/metrics (Prometheus text) as charts over time
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Sampled every 5 s while the panel is open (a broker just opened: at once and a second later), from every
// broker running here with the admin API, so that a broker selected later has its last minutes too; 120
// samples (10 minutes) kept per broker. A counter is
// drawn as its rate between two samples, a gauge as it is, the request latency as the mean and the 95th
// percentile of the requests in the interval (from the histogram's buckets, interpolated). A read that
// fails is a break in the samples, and so is a request count that goes down (the broker started again):
// no rate across one.
//
import * as api from './api.js';
import { t, tk, plural } from './i18n.js';
import { closeX } from './ui.js';

const PERIOD_MS = 5000;
const QUICK_MS = 1000;                 // the second read of a broker just opened (start)
const SAMPLES_MAX = 120;
const W = 300, H = 56;                // a chart in the row; a chart opened big (open): BW x BH
const BW = 900, BH = 300;
const COLOURS = 8;                     // s1..s8, cycled

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
// histMean - a histogram's mean over the interval: its _sum rate over its _count rate (times 'k')
//
const histMean = (name, k = 1) => (a, b) => {
  const n = rate(a, b, name + '_count'), s = rate(a, b, name + '_sum');
  return (n && s !== null) ? (s / n) * k : null;
};

//
// opsOf - one series per counter of an operation group (ngsild_<prefix>..._total) the broker serves, its rate
//
const opsOf = (re) => (b) => [...b.v.keys()].filter((n) => re.test(n)).sort()
  .map((n) => ({ label: opLabel(n), f: (x, y) => rate(x, y, n) }));

//
// The charts: a title, a unit, gauge (drawn across a break too), and the series - each a label, a colour
// class and the value of an interval (a: the sample before, b: this one)
//
const CHARTS = [
  { title: tk('Requests'), unit: '/s', series: [
    { label: tk('all'),    cls: 's1', f: (a, b) => rate(a, b, 'ngsild_request_latency_seconds_count') },
    { label: tk('reads'),  cls: 's2', f: (a, b) => rateSum(a, b, (n) => READS.has(n)) },
    { label: tk('writes'), cls: 's3', f: (a, b) => rateSum(a, b, (n) => isOp(n) && !READS.has(n)) },
  ] },
  { title: tk('Errors'), unit: '/s', series: [
    { label: '4xx', cls: 's4', f: (a, b) => rate(a, b, 'ngsild_errors_4xx_total') },
    { label: '5xx', cls: 's5', f: (a, b) => rate(a, b, 'ngsild_errors_5xx_total') },
  ] },
  { title: tk('Latency'), unit: ' ms', series: [
    { label: tk('mean'), cls: 's1', f: latencyMean },
    { label: 'p95',  cls: 's3', f: latencyP95 },
  ] },
  { title: tk('Notifications'), unit: '/s', series: [
    { label: tk('sent'),           cls: 's1', f: (a, b) => rate(a, b, 'ngsild_notifications_sent_total') },
    { label: tk('context source'), cls: 's2', f: (a, b) => rate(a, b, 'ngsild_csource_notifications_sent_total') },
    { label: tk('SSE events'),     cls: 's3', f: (a, b) => rate(a, b, 'ngsild_sse_events_total') },
    { label: tk('failed'),         cls: 's5', f: (a, b) => rateSum(a, b, (n) => n === 'ngsild_notifications_failed_total' || n === 'ngsild_csource_notifications_failed_total') },
  ] },
  { title: tk('Subscriptions'), unit: '', gauge: true, series: [
    { label: tk('entities'),       cls: 's1', f: (a, b) => gauge(b, 'ngsild_subscription_cache_size') },
    { label: tk('periodic'),       cls: 's2', f: (a, b) => gauge(b, 'ngsild_pernot_cache_size') },
    { label: tk('context source'), cls: 's3', f: (a, b) => gauge(b, 'ngsild_csource_subscription_cache_size') },
    { label: tk('SSE streams'),    cls: 's4', f: (a, b) => gauge(b, 'ngsild_sse_streams') },
    { label: tk('registrations'),  cls: 's6', f: (a, b) => gauge(b, 'ngsild_csource_registration_cache_size') },
  ] },
  { title: tk('Memory'), unit: ' MiB', gauge: true, series: [
    { label: tk('used'),     cls: 's1', f: (a, b) => mibOf(gauge(b, 'ngsild_memory_used_bytes')) },
    { label: tk('resident'), cls: 's2', f: (a, b) => mibOf(gauge(b, 'ngsild_memory_resident_bytes')) },
    { label: tk('budget'),   cls: 's5', f: (a, b) => { const v = gauge(b, 'ngsild_memory_budget_bytes'); return v ? mibOf(v) : null; } },
    { label: tk('entity map'), cls: 's6', f: (a, b) => mibOf(gauge(b, 'ngsild_entity_map_bytes')) },
  ] },
  { title: tk('Entity operations'), unit: '/s', ops: opsOf(/^ngsild_(entity|attr)_[a-z_]+_total$/) },
  { title: tk('Batch operations'), unit: '/s', ops: opsOf(/^ngsild_batch_[a-z_]+_total$/) },
  { title: tk('Subscription and registration operations'), unit: '/s', ops: opsOf(/^ngsild_(subscription|registration|csr_sub)_[a-z_]+_total$/) },
  { title: tk('Request handling'), unit: '/s', series: [
    { label: tk('inline'),               cls: 's1', f: (a, b) => rate(a, b, 'ngsild_requests_inline_total') },
    { label: tk('worker'),               cls: 's2', f: (a, b) => rate(a, b, 'ngsild_requests_worker_total') },
    { label: tk('refused, memory'),      cls: 's5', f: (a, b) => rate(a, b, 'ngsild_requests_refused_memory_total') },
    { label: tk('refused, store paused'), cls: 's4', f: (a, b) => rate(a, b, 'ngsild_requests_refused_store_paused_total') },
    { label: tk('SSE refused'),          cls: 's7', f: (a, b) => rate(a, b, 'ngsild_sse_streams_refused_total') },
  ] },
  { title: tk('Response bodies'), unit: ' KiB/s', series: [
    { label: tk('sent'), cls: 's1', f: (a, b) => { const r = rate(a, b, 'ngsild_response_body_bytes_total'); return r === null ? null : r / 1024; } },
  ] },
  { title: tk('Forwarding (distributed operations)'), unit: '/s', series: [
    { label: tk('forwarded'), cls: 's1', f: (a, b) => rate(a, b, 'ngsild_distop_forwarded_total') },
    { label: tk('failed'),    cls: 's5', f: (a, b) => rate(a, b, 'ngsild_distop_forward_failed_total') },
  ] },
  { title: tk('Forwarding latency'), unit: ' ms', series: [
    { label: tk('mean'), cls: 's1', f: histMean('ngsild_distop_forward_latency_seconds', 1000) },
  ] },
  { title: tk('Batch size'), unit: '', series: [
    { label: tk('mean entities'), cls: 's1', f: histMean('ngsild_batch_item_count') },
  ] },
  { title: tk('Entity map'), unit: '', gauge: true, series: [
    { label: tk('entities'), cls: 's1', f: (a, b) => gauge(b, 'ngsild_entity_map_store_size') },
  ] },
  { title: tk('Tenants and store'), unit: '', gauge: true, series: [
    { label: tk('tenants'),      cls: 's1', f: (a, b) => gauge(b, 'ngsild_tenants_total') },
    { label: tk('store paused'), cls: 's5', f: (a, b) => gauge(b, 'ngsild_store_paused') },
  ] },
  { title: tk('Other'), unit: '', other: true },
];

//
// KNOWN - every metric a chart above draws; 'Other' draws the rest a broker serves (a newer coraine's), a
// counter as its rate, a gauge as it is
//
const KNOWN = new Set(['ngsild_request_latency_seconds_count', 'ngsild_request_latency_seconds_sum', 'ngsild_request_latency_seconds_bucket',
  'ngsild_errors_4xx_total', 'ngsild_errors_5xx_total', 'ngsild_notifications_sent_total', 'ngsild_csource_notifications_sent_total',
  'ngsild_sse_events_total', 'ngsild_notifications_failed_total', 'ngsild_csource_notifications_failed_total', 'ngsild_subscription_cache_size',
  'ngsild_pernot_cache_size', 'ngsild_csource_subscription_cache_size', 'ngsild_sse_streams', 'ngsild_csource_registration_cache_size',
  'ngsild_memory_used_bytes', 'ngsild_memory_resident_bytes', 'ngsild_memory_budget_bytes', 'ngsild_entity_map_bytes',
  'ngsild_requests_inline_total', 'ngsild_requests_worker_total', 'ngsild_requests_refused_memory_total', 'ngsild_requests_refused_store_paused_total',
  'ngsild_sse_streams_refused_total', 'ngsild_response_body_bytes_total', 'ngsild_distop_forwarded_total', 'ngsild_distop_forward_failed_total',
  'ngsild_distop_forward_latency_seconds_count', 'ngsild_distop_forward_latency_seconds_sum', 'ngsild_distop_forward_latency_seconds_bucket',
  'ngsild_batch_item_count_count', 'ngsild_batch_item_count_sum', 'ngsild_batch_item_count_bucket', 'ngsild_entity_map_store_size',
  'ngsild_tenants_total', 'ngsild_store_paused']);

const otherOf = (b) => [...b.v.keys()].filter((n) => !KNOWN.has(n) && !isOp(n) && !Array.isArray(b.v.get(n))).sort()
  .map((n) => n.endsWith('_total') ? { label: n.slice(7, -6).replace(/_/g, ' ') + '/s', f: (x, y) => rate(x, y, n) }
    : { label: n.slice(7).replace(/_/g, ' '), f: (x, y) => gauge(y, n) });

//
// seriesOf - a chart's series: its own, or those of the operations or metrics the last sample has; a colour each
//
function seriesOf(c, s) {
  const b = s[s.length - 1];
  const list = c.series || (b && b.v ? (c.ops ? c.ops(b) : c.other ? otherOf(b) : []) : []);
  return list.map((x, i) => (x.cls ? x : { ...x, cls: 's' + ((i % COLOURS) + 1) }));
}

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
    this.quickAt = new Map();        // broker url -> when its quick start (start) began
    this.timer = null;
    this.urls = () => [];
    this.onSample = () => {};
  }

  //
  // start - read every PERIOD_MS the brokers urls() names, onSample() after each round; stop - no more
  //
  //
  // A broker without two recent reads (just opened, or not read for a while) is read at once and again after
  // QUICK_MS - its charts (rates need two reads) in a second, not after a whole period
  //
  start(urls, onSample) {
    this.urls = urls;
    this.onSample = onSample;
    const stale = (u) => {
      const s = this.samples.get(u) || [];
      return s.length < 2 || !s[s.length - 1].v || !s[s.length - 2].v || Date.now() - s[s.length - 1].t > 2 * PERIOD_MS;
    };
    const quick = this.urls().filter((u) => stale(u) && !(Date.now() - (this.quickAt.get(u) || 0) < 2 * QUICK_MS));
    for (const u of quick) this.quickAt.set(u, Date.now());   // one quick start at a time - start runs on every redraw
    if (quick.length) {
      const now = async () => { await Promise.all(quick.map((u) => this.read(u))); this.onSample(); };
      now().then(() => setTimeout(() => { if (this.timer) now(); }, QUICK_MS));
    }
    if (this.timer) return;
    this.timer = setInterval(async () => {
      await Promise.all(this.urls().map((u) => this.read(u)));
      this.onSample();
    }, PERIOD_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.close();
  }

  async read(url) {
    const r = await api.brokerText(url, '/admin/metrics');
    if (!r.ok) {
      this.push(url, null);                                       // a break: no rate across it
      this.errors.set(url, r.reached ? (r.status === 403 ? t('GET /admin/metrics: HTTP {status} - the c3 backend is older than Metrics', { status: r.status })
        : t('GET /admin/metrics: HTTP {status}', { status: r.status })) : t('the broker does not answer'));
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
    return [req !== null && t('{n} req/s', { n: fmt(req) }), lat !== null && t('{n} ms mean', { n: fmt(lat) }), subs !== null && plural(subs, '{n} subscription', '{n} subscriptions')]
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
      if (!why) box.append(el('div', 'rn-lvnote', t('Reading /admin/metrics every 5 s - the first rates after the second read.')));
      return box;
    }
    const span = Math.round((s[s.length - 1].t - s[0].t) / 1000);
    box.append(el('div', 'rn-lvnote', span >= 60 ? t('Every 5 s, the last {n} min (10 min kept). A rate is per second over each 5 s.', { n: Math.round(span / 60) })
      : t('Every 5 s, the last {n} s (10 min kept). A rate is per second over each 5 s.', { n: span })));

    const grid = el('div', 'mx-grid');
    for (const c of CHARTS) {
      if (c.other && !seriesOf(c, s).length) continue;           // nothing beyond the charts above
      grid.append(this.chart(c, s, url));
    }
    box.append(grid);
    if (this.big && this.big.url === url) this.bigDraw();
    box.append(this.busiest(s));
    return box;
  }

  //
  // chart - one chart in the row: its title, its series' last values (the busiest 4 when it has more - all of
  // them when opened), its lines; a click (Enter) opens it big (open)
  //
  chart(c, s, url, big = false) {
    const series = seriesOf(c, s);
    const pts = series.map((ser) => s.slice(1).map((b, i) => [b.t, (c.gauge || sameRun(s[i], b)) ? ser.f(s[i], b) : null]));
    if (series.every((ser, k) => pts[k].every(([, v]) => v === null))) {
      const empty = el('div', 'mx-chart');
      empty.append(el('div', 'mx-title', t(c.title)), el('div', 'hrange', t('not served by this broker')));
      return empty;
    }
    const box = el('div', 'mx-chart' + (big ? ' big' : ''));
    if (!big) {
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.title = t('{title} - open it big', { title: t(c.title) });
      box.addEventListener('click', () => this.open(c, url));
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(c, url); } });
    }
    const head = el('div', 'mx-head');
    head.append(el('span', 'mx-title', t(c.title)));
    const now = el('span', 'mx-now');
    const lastOf = (k) => (pts[k].length ? pts[k][pts[k].length - 1][1] : null);
    let shown = series.map((ser, k) => k).filter((k) => !(lastOf(k) === null && pts[k].every(([, v]) => v === null)));
    const more = !big && shown.length > 4 ? shown.length - 4 : 0;
    if (more) shown = shown.sort((p, q) => (lastOf(q) || 0) - (lastOf(p) || 0)).slice(0, 4);
    for (const k of shown) {
      const item = el('span', 'mx-item');
      item.append(el('i', 'mx-dot ' + series[k].cls), document.createTextNode(t(series[k].label) + ' ' + fmt(lastOf(k)) + c.unit));
      now.append(item);
    }
    if (more) now.append(el('span', 'mx-item', t('+{n} more', { n: more })));
    head.append(now);

    const w = big ? BW : W, h = big ? BH : H;
    const t1 = s[s.length - 1].t, t0 = Math.min(s[0].t, t1 - 60 * 1000);   // what there is, a minute at least
    const hi = niceMax(Math.max(0, ...pts.flat().map(([, v]) => (v === null ? 0 : v))));
    const x = (t) => Math.max(0, ((t - t0) / (t1 - t0)) * w);
    const y = (v) => h - 2 - (v / hi) * (h - 6);

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'mx-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('{title}, the last {n} samples, up to {max}', { title: t(c.title), n: s.length, max: fmt(hi) + c.unit }));
    if (big) {                                                   // grid lines: a quarter of the top each
      for (let q = 1; q <= 4; q++) {
        const g = document.createElementNS(svgNS, 'path');
        g.setAttribute('d', `M0,${y(hi * q / 4).toFixed(1)}H${w}`);
        g.setAttribute('class', 'mx-gridline');
        svg.append(g);
      }
    }
    series.forEach((ser, k) => {
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
    if (big) {                                                   // the time axis: its ends and middle, clock time
      const axis = el('div', 'mx-axis');
      const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      axis.append(el('span', '', hm(t0)), el('span', '', hm((t0 + t1) / 2)), el('span', '', hm(t1)));
      box.append(axis);
    }
    return box;
  }

  //
  // open - a chart big, in a dialog, every series named; drawn again with each sample until closed (× or Esc)
  //
  open(c, url) {
    this.close();
    const d = el('dialog', 'mx-dialog');
    d.setAttribute('aria-label', t(c.title));
    d.append(closeX(t('Close'), () => this.close(), true), el('div', 'mx-bigbody'));
    d.addEventListener('close', () => { if (this.big && this.big.d === d) this.close(); });   // Esc
    try {                                                        // its size as the user left it (dragged corner)
      const z = JSON.parse(localStorage.getItem('c3.metrics.big') || 'null');
      if (z && z.w > 0 && z.h > 0) { d.style.width = Math.min(z.w, innerWidth - 16) + 'px'; d.style.height = Math.min(z.h, innerHeight - 16) + 'px'; }
    } catch { /* the default size */ }
    document.body.append(d);
    new ResizeObserver(() => {                                   // a size dragged: kept for the next one
      if (!d.open || !d.offsetWidth) return;
      try { localStorage.setItem('c3.metrics.big', JSON.stringify({ w: d.offsetWidth, h: d.offsetHeight })); } catch { /* not kept */ }
    }).observe(d);
    this.big = { c, url, d };
    this.bigDraw();
    d.showModal();
  }

  bigDraw() {
    const { c, url, d } = this.big;
    const s = this.samples.get(url) || [];
    if (s.length >= 2) d.querySelector('.mx-bigbody').replaceChildren(this.chart(c, s, url, true));
  }

  close() {
    if (!this.big) return;
    const d = this.big.d;
    this.big = null;
    if (d.open) d.close();
    d.remove();
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
      box.append(el('div', 'mx-title', t('Busiest operations')), el('div', 'hrange', t('from the next read on')));
      return box;
    }
    box.append(el('div', 'mx-title', t('Busiest operations, the last {n} s', { n: secs })));
    if (!rows.length) {
      box.append(el('div', 'hrange', t('no NGSI-LD requests')));
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
export { CHARTS, seriesOf };                   // test/metrics.mjs
