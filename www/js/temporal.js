//
// temporal.js - Explore's History panel: an attribute's history from the broker's temporal API, over a time
// range - as a graph (by the kind of its values) or as a table of its instances, raw or aggregated - and its
// instances added, modified and deleted
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The time range is the panel's, not one attribute's: a preset (the last hour, day, week, month - from the
// moment of each read) or a start and an end; it is kept per broker on this machine and every History opened
// later starts from it.
//
// The read: GET /ngsi-ld/v1/temporal/entities/{id}?attrs=<attr>&timerel=between&timeAt&endTimeAt&timeproperty,
// in pages of PAGE instances (firstN, ascending): the next page is the Link header's rel="intervalafter" -
// its offsetN; at most CAP instances, and a Stop. Aggregated: format=aggregatedValues&aggrMethods
// (&aggrPeriodDuration) - one answer, no pages.
//
// The writes: POST /temporal/entities/{id}/attrs (an instance added), PATCH and DELETE
// /temporal/entities/{id}/attrs/{attr}/{instanceId}, DELETE /temporal/entities/{id}/attrs/{attr} (the
// attribute's history - its default instances, a datasetId's, or all) and DELETE /temporal/entities/{id}.
//
import * as api from './api.js';
import { PALETTE } from './entity.js';
import { openMenu } from './menu.js';
import { t, tk, plural, number } from './i18n.js';

const PAGE = 1000;
const CAP = 20000;
const ROW_H = 180, BAND_H = 40, AGG_H = 100, YAXIS = 50;

const PRESETS = [
  ['1h', tk('1 h'), 3600e3],
  ['24h', tk('24 h'), 86400e3],
  ['7d', tk('7 d'), 7 * 86400e3],
  ['30d', tk('30 d'), 30 * 86400e3],
];
const METHODS = ['avg', 'min', 'max', 'sum', 'totalCount', 'distinctCount', 'stddev', 'sumsq'];
const PERIODS = [['', tk('the whole range')], ['PT1M', tk('per minute')], ['PT5M', tk('per 5 minutes')], ['PT15M', tk('per 15 minutes')],
  ['PT1H', tk('per hour')], ['P1D', tk('per day')], ['P7D', tk('per week')]];
const TIMEPROPS = ['observedAt', 'modifiedAt', 'createdAt'];

const svgNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function button(text, cls, onclick, title) {
  const b = el('button', cls || 'btn small', text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

const brokerError = (r) => t('the broker answered {status}: {detail}', { status: r.status, detail: [r.body && r.body.title, r.body && r.body.detail].filter(Boolean).join(' - ') });

//
// valueOf - an instance's value, whatever its kind: value, object, vocab, languageMap, json, valueList, objectList
//
export function valueOf(inst) {
  if (!inst || typeof inst !== 'object') return undefined;
  for (const k of ['value', 'object', 'vocab', 'languageMap', 'json', 'valueList', 'objectList']) if (k in inst) return inst[k];
  return undefined;
}

//
// shapeOf - how a list of values is drawn: 'number' (a line), 'boolean' (a step between false and true), 'category'
// (a band, a colour per value - strings, a Relationship's targets) or 'table' (objects, arrays: no graph)
//
export function shapeOf(values) {
  const vs = values.filter((v) => v !== undefined && v !== null);
  if (!vs.length) return 'table';
  if (vs.every((v) => typeof v === 'number')) return 'number';
  if (vs.every((v) => typeof v === 'boolean')) return 'boolean';
  if (vs.every((v) => typeof v === 'string')) return 'category';
  return 'table';
}

//
// intervalAfter - the offsetN of a Link header's rel="intervalafter" (the page with the later instances), or null
//
export function intervalAfter(link) {
  if (!link) return null;
  for (const part of link.split(/,(?=\s*<)/)) {
    if (!/rel="?intervalafter"?/.test(part)) continue;
    const m = part.match(/[?&]offsetN=(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

//
// The time range: a preset's span ending now, or a start and an end
//
export function rangeOf(r, now = Date.now()) {
  const p = PRESETS.find(([k]) => k === r.preset);
  if (p) return { from: now - p[2], to: now };
  return { from: r.from, to: r.to };
}

const pad = (n) => String(n).padStart(2, '0');
const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const iso = (ms) => new Date(ms).toISOString();
const fmtNum = (x) => (typeof x !== 'number' ? String(x) : Number.isInteger(x) ? number(x) : number(x, { maximumFractionDigits: Math.abs(x) < 10 ? 3 : 2 }));
const fmtValue = (v) => (v === undefined ? '–' : typeof v === 'number' ? fmtNum(v) : typeof v === 'string' ? v : JSON.stringify(v));

function fmtTime(ms, span) {
  const d = new Date(ms);
  if (span <= 2 * 86400e3) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: span <= 3600e3 ? '2-digit' : undefined });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

//
// ticks - about 'n' round instants between from and to
//
function ticks(from, to, n = 6) {
  const steps = [1e3, 5e3, 15e3, 30e3, 60e3, 300e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 30 * 86400e3];
  const want = (to - from) / n;
  const step = steps.find((s) => s >= want) || steps[steps.length - 1];
  const tz = new Date(from).getTimezoneOffset() * 60e3;
  const out = [];
  for (let x = Math.ceil((from - tz) / step) * step + tz; x <= to; x += step) out.push(x);
  return out;
}

export class Temporal {
  //
  // host: Connect - its broker, ask(), openWrite(), toast(), refetch()
  //
  constructor(host, root) {
    this.host = host;
    this.root = root;
    this.ctx = null;                  // { id, attr, kind, datasetId, entity }
    this.ticket = 0;
    this.view = 'graph';
    this.methods = new Set();
    this.period = '';
    this.timeprop = 'observedAt';
    this.instances = [];
    this.agg = null;
    this.state = '';                  // 'reading', 'done', 'stopped', 'capped', 'error'
    this.why = '';
    this.highlight = null;            // an instanceId, shown in the table
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('input, select')) { e.stopPropagation(); this.close(); } });
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (this.isOpen && !this.root.querySelector('.hp-edit, .hp-foot input')) this.render(); }, 150);
    });
  }

  get isOpen() { return !this.root.hidden; }

  //
  // The range - kept per broker
  //
  rangeKey() { return 'c3.history.range.' + (this.host.broker || ''); }

  loadRange() {
    try {
      const r = JSON.parse(localStorage.getItem(this.rangeKey()) || 'null');
      if (r && (PRESETS.some(([k]) => k === r.preset) || (r.preset === 'custom' && r.from < r.to))) return r;
    } catch { /* no storage */ }
    return { preset: '24h' };
  }

  saveRange(r) {
    this.range = r;
    try { localStorage.setItem(this.rangeKey(), JSON.stringify(r)); } catch { /* no storage */ }
  }

  //
  // open - an attribute's history: 'v' the attribute as the entity has it now (its kind, observedAt, datasetId)
  //
  open(entity, attr, v) {
    const inst = Array.isArray(v) ? v[0] : v;
    this.ctx = {
      id: entity.id,
      attr,
      kind: (inst && inst.type) || 'Property',
      datasetId: inst && typeof inst.datasetId === 'string' ? inst.datasetId : null,
    };
    this.range = this.loadRange();
    this.timeprop = 'observedAt';
    this.timepropAuto = true;
    this.methods = new Set();
    this.period = '';
    this.view = 'graph';
    this.highlight = null;
    this.returnFocus = document.activeElement;
    this.root.hidden = false;
    this.read();
  }

  close() {
    this.ticket++;
    this.root.hidden = true;
    this.root.textContent = '';
    this.ctx = null;
    if (this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus();
  }

  //
  // read - the instances (or the aggregation) of the range, page by page
  //
  async read() {
    const ticket = ++this.ticket;
    const c = this.ctx;
    const { from, to } = rangeOf(this.range);
    this.instances = [];
    this.agg = null;
    this.state = 'reading';
    this.why = '';
    this.render();

    const base = `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(c.id)}?attrs=${encodeURIComponent(c.attr)}` +
      `&timerel=between&timeAt=${encodeURIComponent(iso(from))}&endTimeAt=${encodeURIComponent(iso(to))}&timeproperty=${this.timeprop}` +
      (c.datasetId ? `&datasetId=${encodeURIComponent(c.datasetId)}` : '') +
      (this.timeprop !== 'observedAt' ? '&options=sysAttrs' : '');

    if (this.methods.size) {
      const q = `${base}&format=aggregatedValues&aggrMethods=${[...this.methods].join(',')}` + (this.period ? `&aggrPeriodDuration=${this.period}` : '');
      const r = await api.brokerGet(this.host.broker, q);
      if (ticket !== this.ticket) return;
      if (r.status !== 404 && (!r.ok || !r.body || typeof r.body !== 'object')) { this.fail(r); return; }
      const a = r.ok ? r.body[c.attr] : null;
      this.agg = (Array.isArray(a) ? a[0] : a) || {};
      this.state = 'done';
      this.render();
      return;
    }

    let offset = 0;
    for (;;) {
      const r = await api.brokerGet(this.host.broker, `${base}&firstN=${PAGE}` + (offset ? `&offsetN=${offset}` : ''));
      if (ticket !== this.ticket) return;
      //
      // 404: no instance matches (coraine's answer to a range, or a time property, with nothing in it) - an empty page
      //
      if (r.status === 404 && r.reached !== false) { this.state = 'done'; break; }
      if (!r.ok || !r.body || typeof r.body !== 'object') { this.fail(r); return; }
      const a = r.body[c.attr];
      const got = Array.isArray(a) ? a : a ? [a] : [];
      this.instances.push(...got);
      const next = intervalAfter(r.headers.get('Link'));
      if (next === null || !got.length) { this.state = 'done'; break; }
      if (this.instances.length >= CAP) { this.state = 'capped'; break; }
      offset = next;
      this.render();
    }
    //
    // observedAt, the spec's default, found nothing - the instances may have none (a value without observedAt):
    // modifiedAt then, unless the time property was chosen
    //
    if (this.timepropAuto && this.state === 'done' && !this.instances.length && this.timeprop === 'observedAt') {
      this.timeprop = 'modifiedAt';
      this.timepropAuto = false;
      this.read();
      return;
    }
    this.instances.sort((p, q) => this.timeOf(p) - this.timeOf(q));
    this.render();
  }

  //
  // width - the drawing's width in CSS pixels: the panel's, less its padding and the y axis' labels
  //
  width() { return Math.max(260, (this.root.clientWidth || 700) - 50 - YAXIS); }

  fail(r) {
    this.state = 'error';
    this.why = r.status === 0 || r.reached === false ? t('the broker is not reachable') : brokerError(r);
    this.render();
  }

  stop() {
    this.ticket++;
    this.state = 'stopped';
    this.instances.sort((p, q) => this.timeOf(p) - this.timeOf(q));
    this.render();
  }

  timeOf(inst) { return Date.parse((inst && inst[this.timeprop]) || '') || 0; }

  // ------------------------------------------------------------------ the panel

  render() {
    const c = this.ctx;
    if (!c) return;
    const keep = this.root.querySelector('.hp-body');
    const scroll = keep ? keep.scrollTop : 0;
    this.root.textContent = '';

    const head = el('div', 'jhead');
    const title = el('span', 'jtitle', `${c.attr} · ${c.id}`);
    title.title = c.datasetId ? `${c.attr} (${c.datasetId}) · ${c.id}` : `${c.attr} · ${c.id}`;
    head.append(title, button('×', 'btn', () => this.close(), t('Close the history')));
    head.lastChild.setAttribute('aria-label', t('Close the history'));
    this.root.append(head, this.controls(), this.statusLine());

    const body = el('div', 'hp-body');
    if (this.state === 'error') body.append(el('p', 'hp-why', this.why));
    else if (this.agg) body.append(this.aggView());
    else if (this.view === 'table' || this.shape() === 'table') body.append(this.table());
    else body.append(this.graph());
    this.root.append(body, this.foot());
    body.scrollTop = scroll;
    const hl = body.querySelector('tr.hl');
    if (hl) { hl.scrollIntoView({ block: 'center' }); this.highlight = null; }
  }

  shape() { return shapeOf(this.instances.map(valueOf)); }

  controls() {
    const box = el('div', 'hp-ctl');

    //
    // The range: presets, or a start and an end (typed: the range becomes those two)
    //
    const row = el('div', 'hp-row');
    const seg = el('div', 'cp-seg hp-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', t('Time range'));
    for (const [k, label] of PRESETS) {
      const b = button(t(label), null, () => { this.saveRange({ preset: k }); this.read(); });
      b.setAttribute('aria-pressed', String(this.range.preset === k));
      seg.append(b);
    }
    row.append(seg);
    const { from, to } = rangeOf(this.range);
    const inFrom = el('input', 'hp-time');
    const inTo = el('input', 'hp-time');
    for (const [inp, ms, label] of [[inFrom, from, t('From')], [inTo, to, t('To')]]) {
      inp.type = 'datetime-local';
      inp.value = localInput(ms);
      inp.setAttribute('aria-label', label);
      inp.title = label;
    }
    const typed = () => {
      const f = Date.parse(inFrom.value), u = Date.parse(inTo.value);
      if (!(f < u)) { this.host.toast(t('The start is before the end')); return; }
      this.saveRange({ preset: 'custom', from: f, to: u });
      this.read();
    };
    inFrom.addEventListener('change', typed);
    inTo.addEventListener('change', typed);
    row.append(inFrom, el('span', 'hp-dash', '–'), inTo);

    const tp = el('select', 'hp-tp');
    tp.setAttribute('aria-label', t('Time property'));
    tp.title = t('The time each instance is placed at: observedAt (when it was measured), modifiedAt (when the broker got it), createdAt');
    for (const p of TIMEPROPS) { const o = el('option', null, p); o.value = p; o.selected = p === this.timeprop; tp.append(o); }
    tp.onchange = () => { this.timeprop = tp.value; this.timepropAuto = false; this.read(); };
    row.append(tp);
    box.append(row);

    //
    // Shown as: graph or table - and the aggregation: methods and a period
    //
    const row2 = el('div', 'hp-row');
    const vseg = el('div', 'cp-seg hp-seg');
    vseg.setAttribute('role', 'group');
    vseg.setAttribute('aria-label', t('Shown as'));
    for (const [k, label] of [['graph', t('Graph')], ['table', t('Table')]]) {
      const b = button(label, null, () => { this.view = k; this.render(); });
      b.setAttribute('aria-pressed', String(this.view === k && !this.agg));
      b.disabled = !!this.agg || (k === 'graph' && this.state !== 'reading' && this.instances.length > 0 && this.shape() === 'table');
      vseg.append(b);
    }
    row2.append(vseg);

    const aggBox = el('details', 'hp-agg');
    aggBox.open = this.aggOpen || this.methods.size > 0;
    aggBox.addEventListener('toggle', () => { this.aggOpen = aggBox.open; });
    const sum = el('summary', 'hp-lbl', this.methods.size ? `${t('Aggregate')}: ${[...this.methods].join(', ')}` : t('Aggregate'));
    aggBox.append(sum);
    for (const m of METHODS) {
      const lab = el('label', 'hp-chip');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = this.methods.has(m);
      cb.onchange = () => { if (cb.checked) this.methods.add(m); else this.methods.delete(m); this.read(); };
      lab.append(cb, m);
      aggBox.append(lab);
    }
    const per = el('select', 'hp-per');
    per.setAttribute('aria-label', t('Aggregation period'));
    for (const [k, label] of PERIODS) { const o = el('option', null, t(label)); o.value = k; o.selected = k === this.period; per.append(o); }
    per.disabled = !this.methods.size;
    per.onchange = () => { this.period = per.value; this.read(); };
    aggBox.append(per);
    box.append(row2, aggBox);
    return box;
  }

  statusLine() {
    const p = el('div', 'hp-status');
    p.setAttribute('aria-live', 'polite');
    const n = this.instances.length;
    if (this.agg) p.append(t('aggregated by the broker'));
    else if (this.state === 'reading') {
      p.append(n ? plural(n, 'reading - {n} instance so far', 'reading - {n} instances so far') : t('reading…'));
      p.append(button(t('Stop'), 'btn small', () => this.stop()));
    } else if (this.state === 'stopped') p.append(plural(n, '{n} instance - stopped, there may be more', '{n} instances - stopped, there may be more'));
    else if (this.state === 'capped') p.append(plural(n, 'the first {n} instance - there are more: a shorter range shows them all', 'the first {n} instances - there are more: a shorter range shows them all'));
    else if (this.state === 'done') p.append(n ? plural(n, '{n} instance', '{n} instances') : t('no instances in this range'));
    return p;
  }

  // ------------------------------------------------------------------ the graph

  axis(g, from, to, y0) {
    const W = this.width();
    const span = to - from;
    for (const x of ticks(from, to)) {
      const px = ((x - from) / span) * W;
      g.append(svg('line', { x1: px, x2: px, y1: 0, y2: y0, class: 'hp-grid' }));
      const lab = svg('text', { x: px, y: y0 + 14, class: 'hp-tick', 'text-anchor': 'middle' });
      lab.textContent = fmtTime(x, span);
      g.append(lab);
    }
  }

  graph() {
    const box = el('div', 'hp-graph');
    const pts = this.instances.map((i) => [this.timeOf(i), valueOf(i), i]).filter(([x]) => x);
    if (!pts.length) return box;
    const W = this.width();
    const { from, to } = rangeOf(this.range);
    const span = to - from || 1;
    const px = (x) => ((x - from) / span) * W;
    const shape = this.shape();
    const h = shape === 'category' ? BAND_H : ROW_H;
    const s = svg('svg', { viewBox: `${-YAXIS} -8 ${W + YAXIS + 4} ${h + 30}`, width: W + YAXIS + 4, height: h + 30, class: 'hp-svg', role: 'img' });
    const g = svg('g');
    s.append(g);
    this.axis(g, from, to, h);
    const tip = el('div', 'hp-tip');
    tip.hidden = true;
    const marker = svg('line', { y1: 0, y2: h, class: 'hp-cursor', visibility: 'hidden' });

    let at;                                       // the instance nearest a pointer x, and its y
    if (shape === 'number' || shape === 'boolean') {
      const vals = pts.map((p) => (shape === 'boolean' ? (p[1] ? 1 : 0) : p[1]));
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (shape === 'boolean') { lo = 0; hi = 1; } else if (hi === lo) { hi += 1; lo -= 1; }
      const y = (v) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
      for (const [v, label] of shape === 'boolean' ? [[0, 'false'], [1, 'true']] : [[lo, fmtNum(lo)], [hi, fmtNum(hi)]]) {
        const lab = svg('text', { x: -6, y: y(v) + 4, class: 'hp-tick', 'text-anchor': 'end' });
        lab.textContent = label;
        g.append(lab);
      }
      let d = '';
      if (shape === 'boolean') {
        pts.forEach(([x], i) => { d += (i ? `H${px(x).toFixed(1)}V` : `M${px(x).toFixed(1)},`) + y(vals[i]).toFixed(1); });
        d += `H${px(Math.min(to, Date.now())).toFixed(1)}`;
        g.append(svg('path', { d: `${d}V${h - 6}H${px(pts[0][0]).toFixed(1)}Z`, class: 'hp-area' }));
      } else {
        pts.forEach(([x], i) => { d += `${i ? 'L' : 'M'}${px(x).toFixed(1)},${y(vals[i]).toFixed(1)}`; });
      }
      g.append(svg('path', { d, class: 'hp-line' }));
      if (pts.length <= 300) for (let i = 0; i < pts.length; i++) g.append(svg('circle', { cx: px(pts[i][0]).toFixed(1), cy: y(vals[i]).toFixed(1), r: 2.4, class: 'hp-dot' }));
      at = (i) => y(vals[i]);
      s.setAttribute('aria-label', plural(pts.length, '{attr}: {n} value, from {lo} to {hi}', '{attr}: {n} values, from {lo} to {hi}',
        { attr: this.ctx.attr, lo: fmtValue(Math.min(...pts.map((p) => p[1]))), hi: fmtValue(Math.max(...pts.map((p) => p[1]))) }));
    } else {
      //
      // A band: each value holds until the next instance; a colour per value, the legend its share of the time
      //
      const colour = new Map();
      const share = new Map();
      const end = Math.min(to, Date.now());
      pts.forEach(([x, v], i) => {
        if (!colour.has(v)) colour.set(v, PALETTE[colour.size % PALETTE.length]);
        const x2 = i + 1 < pts.length ? pts[i + 1][0] : end;
        share.set(v, (share.get(v) || 0) + Math.max(0, x2 - x));
        g.append(svg('rect', { x: px(x).toFixed(1), y: 4, width: Math.max(0.8, px(x2) - px(x)).toFixed(1), height: h - 8, fill: colour.get(v), class: 'hp-seg-r' }));
      });
      at = () => h / 2;
      const total = [...share.values()].reduce((a, b) => a + b, 0) || 1;
      const legend = el('div', 'hp-legend');
      for (const [v, c] of colour) {
        const item = el('span', 'hp-li');
        const sw = el('span', 'hp-sw');
        sw.style.background = c;
        item.append(sw, `${v} `, el('span', 'hp-pct', `${Math.round((share.get(v) / total) * 100)}%`));
        legend.append(item);
      }
      box.append(legend);
      s.setAttribute('aria-label', plural(colour.size, '{attr}: {n} distinct value', '{attr}: {n} distinct values', { attr: this.ctx.attr }));
    }
    g.append(marker);

    //
    // The pointer: the instance nearest it, its time and value; a click shows it in the table
    //
    const nearest = (ev) => {
      const r = s.getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * (W + YAXIS + 4) - YAXIS;
      const xt = from + (vx / W) * span;
      let best = 0;
      if (shape === 'category') { for (let i = 0; i < pts.length; i++) if (pts[i][0] <= xt) best = i; }
      else for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - xt) < Math.abs(pts[best][0] - xt)) best = i;
      return best;
    };
    s.addEventListener('pointermove', (ev) => {
      const i = nearest(ev);
      const [x, v] = pts[i];
      marker.setAttribute('x1', px(x).toFixed(1));
      marker.setAttribute('x2', px(x).toFixed(1));
      marker.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = `${new Date(x).toLocaleString()} · ${fmtValue(v)}`;
      const r = s.getBoundingClientRect();
      const bx = box.getBoundingClientRect();
      tip.style.left = `${Math.min(bx.width - 220, Math.max(0, ev.clientX - bx.left + 12))}px`;
      tip.style.top = `${Math.max(0, r.top - bx.top + ((at(i) + 8) / (h + 30)) * r.height - 28)}px`;
    });
    s.addEventListener('pointerleave', () => { tip.hidden = true; marker.setAttribute('visibility', 'hidden'); });
    s.addEventListener('click', (ev) => { this.highlight = pts[nearest(ev)][2].instanceId; this.view = 'table'; this.render(); });
    s.style.cursor = 'pointer';
    box.prepend(s);
    box.append(tip, el('p', 'hp-hint', t('A click shows the instance in the table - to modify or delete it')));
    return box;
  }

  // ------------------------------------------------------------------ the aggregation

  //
  // aggView - per method: with a period, a row of its own over the range (a step per period); without one,
  // its value
  //
  aggView() {
    const box = el('div', 'hp-aggview');
    const W = this.width();
    const { from, to } = rangeOf(this.range);
    const span = to - from || 1;
    const px = (x) => ((Math.min(to, Math.max(from, x)) - from) / span) * W;
    for (const m of METHODS) {
      if (!this.methods.has(m)) continue;
      const list = Array.isArray(this.agg[m]) ? this.agg[m] : [];
      const row = el('div', 'hp-arow');
      const head = el('div', 'hp-ahead');
      head.append(el('span', 'k', m));
      row.append(head);
      const pts = list.filter((e) => Array.isArray(e) && e.length >= 3).map(([v, a, b]) => [v, Date.parse(a), Date.parse(b)]);
      if (!pts.length) { head.append(el('span', 'hp-av', '–')); box.append(row); continue; }
      if (!this.period || pts.length === 1) {
        head.append(el('span', 'hp-av big', fmtValue(pts[0][0])));
        row.append(el('div', 'hp-range', `${new Date(pts[0][1]).toLocaleString()} – ${new Date(pts[0][2]).toLocaleString()}`));
        box.append(row);
        continue;
      }
      const nums = pts.map((p) => p[0]).filter((v) => typeof v === 'number');
      if (nums.length !== pts.length) {
        for (const [v, a] of pts) row.append(el('div', 'hp-range', `${new Date(a).toLocaleString()} · ${fmtValue(v)}`));
        box.append(row);
        continue;
      }
      let lo = Math.min(...nums), hi = Math.max(...nums);
      if (hi === lo) { hi += 1; lo -= 1; }
      //
      // The bars stand on the axis: counts and sums from 0, the others from a little under the lowest - so the
      // lowest has a height too
      //
      const counts = m === 'totalCount' || m === 'distinctCount' || m === 'sum' || m === 'sumsq';
      const base = counts ? Math.min(0, lo) : lo;
      lo = counts ? base : lo - (hi - lo) * 0.15;
      const h = AGG_H;
      const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
      const s = svg('svg', { viewBox: `${-YAXIS} -6 ${W + YAXIS + 4} ${h + 26}`, width: W + YAXIS + 4, height: h + 26, class: 'hp-svg', role: 'img' });
      s.setAttribute('aria-label', plural(pts.length, '{attr} {method}: {n} period, from {lo} to {hi}', '{attr} {method}: {n} periods, from {lo} to {hi}',
        { attr: this.ctx.attr, method: m, lo: fmtNum(Math.min(...nums)), hi: fmtNum(Math.max(...nums)) }));
      this.axis(s, from, to, h);
      for (const [v, label] of (y(base) - y(hi) >= 14 ? [[base, fmtNum(base)], [hi, fmtNum(hi)]] : [[hi, fmtNum(hi)]])) {
        const lab = svg('text', { x: -6, y: y(v) + 4, class: 'hp-tick', 'text-anchor': 'end' });
        lab.textContent = label;
        s.append(lab);
      }
      for (const [v, a, b] of pts) {
        const r = svg('rect', { x: px(a).toFixed(1), y: y(Math.max(v, lo)).toFixed(1), width: Math.max(1, px(b) - px(a) - 1).toFixed(1),
          height: Math.max(1, y(lo) - y(Math.max(v, lo))).toFixed(1), class: 'hp-bar' });
        const tt = svg('title');
        tt.textContent = `${new Date(a).toLocaleString()} – ${new Date(b).toLocaleString()}: ${fmtValue(v)}`;
        r.append(tt);
        s.append(r);
      }
      head.append(el('span', 'hp-av', `${fmtNum(Math.min(...nums))} – ${fmtNum(Math.max(...nums))}`));
      row.append(s);
      box.append(row);
    }
    return box;
  }

  // ------------------------------------------------------------------ the table, and the writes

  table() {
    const box = el('div', 'hp-tablebox');
    if (!this.instances.length) return box;
    const tbl = el('table', 'hp-table');
    const others = TIMEPROPS.filter((p) => p !== this.timeprop && this.instances.some((i) => i[p]));
    const hasDs = this.instances.some((i) => i.datasetId);
    const hr = el('tr');
    for (const h of [this.timeprop, t('value'), ...others, ...(hasDs ? ['datasetId'] : []), 'instanceId', '']) hr.append(el('th', null, h));
    const thead = el('thead');
    thead.append(hr);
    tbl.append(thead);
    const tb = el('tbody');
    for (const inst of [...this.instances].reverse()) {
      const tr = el('tr');
      if (this.highlight && inst.instanceId === this.highlight) tr.className = 'hl';
      tr.append(el('td', 'mono', inst[this.timeprop] || '–'));
      const vtd = el('td', 'mono hp-v', fmtValue(valueOf(inst)));
      if (inst.unitCode) vtd.append(el('span', 'hp-unit', ' ' + inst.unitCode));
      tr.append(vtd);
      for (const p of others) tr.append(el('td', 'mono dim', inst[p] || ''));
      if (hasDs) tr.append(el('td', 'mono dim', inst.datasetId || ''));
      const idtd = el('td', 'mono dim', inst.instanceId ? inst.instanceId.split(':').slice(-2).join(':') : '–');
      idtd.title = inst.instanceId || '';
      tr.append(idtd);
      const act = el('td', 'hp-act');
      if (inst.instanceId) {
        const del = button(t('Delete'), 'btn small', () => this.confirm(del, this.instanceWhat(inst), () => this.deleteInstance(inst)));
        act.append(button(t('Edit'), 'btn small', () => this.editRow(tr, inst)), del);
      }
      tr.append(act);
      tb.append(tr);
    }
    tbl.append(tb);
    box.append(tbl);
    return box;
  }

  //
  // parseValue - a value as typed: JSON when it is JSON (a number, true, an object), else the text itself
  //
  parseValue(text) {
    const s = text.trim();
    if (this.ctx.kind === 'Relationship' || this.ctx.kind === 'VocabProperty') return s;
    try { return JSON.parse(s); } catch { return text; }
  }

  instanceBody(value, observedAt, orig) {
    const k = this.ctx.kind;
    const inst = { type: k };
    const member = { Relationship: 'object', ListRelationship: 'objectList', VocabProperty: 'vocab', LanguageProperty: 'languageMap', JsonProperty: 'json', ListProperty: 'valueList' }[k] || 'value';
    inst[member] = value;
    if (observedAt) inst.observedAt = observedAt;
    if (orig && orig.unitCode) inst.unitCode = orig.unitCode;
    if (this.ctx.datasetId) inst.datasetId = this.ctx.datasetId;
    return { [this.ctx.attr]: [inst] };
  }

  //
  // editRow - the row's value and observedAt in fields: Save sends PATCH .../attrs/{attr}/{instanceId}
  //
  editRow(tr, inst) {
    tr.textContent = '';
    tr.className = 'editing';
    const td = el('td');
    td.colSpan = 99;
    const box = el('div', 'hp-edit');
    td.append(box);
    const v = el('input', 'hp-in mono');
    const cur = valueOf(inst);
    v.value = typeof cur === 'string' ? cur : JSON.stringify(cur);
    v.setAttribute('aria-label', t('value'));
    const at = el('input', 'hp-in mono');
    at.value = inst.observedAt || '';
    at.placeholder = 'observedAt';
    at.setAttribute('aria-label', 'observedAt');
    const save = button(t('Save'), 'btn small primary', async () => {
      const r = await api.brokerWrite(this.host.broker, 'PATCH', this.instancePath(inst.instanceId), this.instanceBody(this.parseValue(v.value), at.value.trim() || undefined, inst));
      if (!r.ok) { this.host.toast(t('Not saved - {why}', { why: brokerError(r) })); return; }
      this.host.toast(t('Saved the instance'));
      this.highlight = inst.instanceId;
      this.read();
    });
    box.append(el('span', 'hp-lbl', t('value')), v, el('span', 'hp-lbl', 'observedAt'), at, save, button(t('Cancel'), 'btn small', () => this.render()));
    tr.append(td);
    v.focus();
    v.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  }

  instancePath(instanceId) {
    return `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(this.ctx.id)}/attrs/${encodeURIComponent(this.ctx.attr)}/${encodeURIComponent(instanceId)}`;
  }

  instanceWhat(inst) { return t('the instance of {time}', { time: inst[this.timeprop] || inst.instanceId }); }

  async deleteInstance(inst) {
    const what = this.instanceWhat(inst);
    if (!(await this.host.openWrite(what))) return;
    const r = await api.brokerWrite(this.host.broker, 'DELETE', this.instancePath(inst.instanceId));
    if (!r.ok) { this.host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return; }
    this.host.toast(t('Deleted {what}', { what }));
    this.read();
  }

  foot() {
    const f = el('div', 'hp-foot');
    const json = ['GeoProperty', 'LanguageProperty', 'JsonProperty', 'ListProperty', 'ListRelationship'].includes(this.ctx.kind);
    f.append(button(t('Add an instance…'), 'btn small', () => this.addForm(f, json)));
    const del = button(t('Delete this history…'), 'btn small', () => this.confirm(del, this.historyWhat(), () => this.deleteHistory()));
    del.title = t('Every instance the broker keeps of this attribute, also outside the range - the attribute itself stays');
    f.append(del);
    return f;
  }

  //
  // confirm - the menu every delete in Explore asks with: 'Delete it - at the broker', Cancel
  //
  confirm(target, what, action) {
    const r = target.getBoundingClientRect();
    openMenu({ x: r.left, y: r.bottom + 2, label: what, returnFocus: target, items: [
      { label: t('Delete it - at the broker'), action },
      { label: t('Cancel'), action: () => {} },
    ] });
  }

  //
  // addForm - a value and its observedAt (now, by default): POST /temporal/entities/{id}/attrs
  //
  addForm(f, json = false) {
    f.textContent = '';
    const v = el('input', 'hp-in mono');
    v.placeholder = json ? t('the value, as JSON') : t('the value');
    v.setAttribute('aria-label', t('value'));
    const at = el('input', 'hp-in mono');
    at.value = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    at.setAttribute('aria-label', 'observedAt');
    const add = button(t('Add'), 'btn small primary', async () => {
      if (!v.value.trim()) { v.focus(); return; }
      const r = await api.brokerWrite(this.host.broker, 'POST', `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(this.ctx.id)}/attrs`,
        this.instanceBody(this.parseValue(v.value), at.value.trim() || undefined));
      if (!r.ok) { this.host.toast(t('Not added - {why}', { why: brokerError(r) })); return; }
      this.host.toast(t('Added an instance to the history of {attr}', { attr: this.ctx.attr }));
      this.read();
    });
    f.append(el('span', 'hp-lbl', t('value')), v, el('span', 'hp-lbl', 'observedAt'), at, add, button(t('Cancel'), 'btn small', () => this.render()));
    v.focus();
    v.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  }

  historyWhat() {
    const c = this.ctx;
    return c.datasetId ? t('the history of {attr} (datasetId {ds})', { attr: c.attr, ds: c.datasetId }) : t('the history of {attr}', { attr: c.attr });
  }

  async deleteHistory() {
    const c = this.ctx;
    const what = this.historyWhat();
    if (!(await this.host.openWrite(what))) return;
    const r = await api.brokerWrite(this.host.broker, 'DELETE', `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(c.id)}/attrs/${encodeURIComponent(c.attr)}` +
      (c.datasetId ? `?datasetId=${encodeURIComponent(c.datasetId)}` : ''));
    if (!r.ok) { this.host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return; }
    this.host.toast(t('Deleted {what}', { what }));
    this.read();
  }
}

//
// deleteEntityHistory - DELETE /temporal/entities/{id}: the entity's whole history (the entity itself stays) -
// asked first by the entity's menu
//
export async function deleteEntityHistory(host, id) {
  const what = t('the history of {entity}', { entity: id });
  if (!(await host.openWrite(what))) return false;
  const r = await api.brokerWrite(host.broker, 'DELETE', '/ngsi-ld/v1/temporal/entities/' + encodeURIComponent(id));
  if (!r.ok) { host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return false; }
  host.toast(t('Deleted {what}', { what }));
  return true;
}
