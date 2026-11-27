//
// temporal.js - Explore's History panel: an attribute's history from the broker's temporal API, over a time
// range - as a graph (by the kind of its values) or as a table of its instances, raw or aggregated - and its
// instances added, modified and deleted; or an entity's: the attributes ticked, a row each on one time axis, or
// one table (a row per instant), as CSV too
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The time range is the panel's, not one attribute's: a preset (the last hour, day, week, month - from the
// moment of each read) or a start and an end; it is kept per broker on this machine and every History opened
// later starts from it.
//
// The read: GET /ngsi-ld/v1/temporal/entities/{id}?attrs=<attr,...>&timerel=between&timeAt&endTimeAt&timeproperty,
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
// emptyRange - a temporal read's answer that is "no instance matches": 404 ResourceNotFound from the broker (coraine's
// answer to a range, or a time property, with nothing in it) - not a broker without the temporal API (another 404)
//
export function emptyRange(r) {
  return r.status === 404 && r.reached !== false && !!r.body && typeof r.body.type === 'string' && /ResourceNotFound$/.test(r.body.type);
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

//
// timeline - several attributes' instances as one table: a row per instant (ascending) that any of them has, a
// cell per attribute - its value at that instant ('fresh'), else the value it had then (the one before, held
// until the next instance; none before its first)
//
//   series: Map attr -> [instance, ...] (any order); timeOf(instance) -> ms
//   returns [{ t, cells: [{ v, fresh } | null, ...] }] - the cells in the order of 'attrs'
//
export function timeline(attrs, series, timeOf) {
  const lists = attrs.map((a) => (series.get(a) || []).map((i) => [timeOf(i), valueOf(i)]).filter(([x]) => x).sort((p, q) => p[0] - q[0]));
  const times = [...new Set(lists.flat().map(([x]) => x))].sort((p, q) => p - q);
  const ix = attrs.map(() => 0);
  const held = attrs.map(() => null);
  const rows = [];
  for (const x of times) {
    const cells = lists.map((l, k) => {
      //
      // Every instant is a row: an instance is taken at its own - fresh there, held after
      //
      let fresh = false;
      while (ix[k] < l.length && l[ix[k]][0] === x) { held[k] = l[ix[k]][1]; fresh = true; ix[k]++; }
      return ix[k] === 0 ? null : { v: held[k], fresh };
    });
    rows.push({ t: x, cells });
  }
  return rows;
}

//
// csvOf - the timeline as CSV (RFC 4180): the time (ISO 8601) and a column per attribute, the values as the table
// shows them - held until the next instance; objects as JSON
//
export function csvOf(attrs, rows, timeHeader = 'time') {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = (c) => (!c || c.v === undefined || c.v === null ? '' : q(typeof c.v === 'string' ? c.v : JSON.stringify(c.v)));
  return [[timeHeader, ...attrs].map(q).join(','), ...rows.map((r) => [new Date(r.t).toISOString(), ...r.cells.map(cell)].join(','))].join('\r\n') + '\r\n';
}

//
// The attribute's kind, as the entity has it now, and its datasetId
//
function attrInfo(v) {
  const inst = Array.isArray(v) ? v[0] : v;
  return {
    kind: (inst && typeof inst === 'object' && inst.type) || 'Property',
    datasetId: inst && typeof inst.datasetId === 'string' ? inst.datasetId : null,
    graphable: shapeOf([valueOf(inst)]) !== 'table',
  };
}

const MEMBER = { Relationship: 'object', ListRelationship: 'objectList', VocabProperty: 'vocab', LanguageProperty: 'languageMap', JsonProperty: 'json', ListProperty: 'valueList' };
const JSON_KINDS = ['GeoProperty', 'LanguageProperty', 'JsonProperty', 'ListProperty', 'ListRelationship'];

export class Temporal {
  //
  // host: Connect - its broker, ask(), confirmDelete(), toast()
  //
  constructor(host, root) {
    this.host = host;
    this.root = root;
    this.ctx = null;                  // { id, entity, attr (null: the entity's history), attrs: [ticked], info: Map attr -> attrInfo }
    this.ticks = null;                // { id, attrs } - the last entity's ticks, again when it is opened again
    this.ticket = 0;
    this.view = 'graph';
    this.methods = new Set();
    this.period = '';
    this.timeprop = 'observedAt';
    this.series = new Map();          // attr -> [instance] of the range
    this.aggs = null;                 // attr -> its aggregation, when aggregated
    this.state = '';                  // 'reading', 'done', 'stopped', 'capped', 'error'
    this.why = '';
    this.highlight = null;            // an instanceId, shown in the table
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('input, select')) { e.preventDefault(); e.stopPropagation(); this.close(); } });
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (this.isOpen && !this.root.querySelector('.hp-edit, .hp-foot input')) this.render(); }, 150);
    });
  }

  get isOpen() { return !this.root.hidden; }

  // The one attribute's instances (an attribute's history)
  get instances() { return (this.ctx && this.ctx.attr && this.series.get(this.ctx.attr)) || []; }

  total() { let n = 0; for (const l of this.series.values()) n += l.length; return n; }

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
  // start - the panel open on 'ctx': the range kept, the rest as new
  //
  start(ctx, keepView = false) {
    if (!this.isOpen) this.returnFocus = document.activeElement;
    this.ctx = ctx;
    this.range = this.loadRange();
    this.timeprop = 'observedAt';
    this.timepropAuto = true;
    this.methods = new Set();
    this.period = '';
    if (!keepView) this.view = 'graph';
    this.root.hidden = false;
    this.read();
  }

  //
  // open - an attribute's history: the entity as Explore has it (the attribute's kind, its datasetId)
  //
  open(entity, attr, highlight = null) {
    const info = new Map([[attr, attrInfo(entity[attr])]]);
    this.highlight = highlight;
    this.start({ id: entity.id, entity, attr, attrs: [attr], info }, !!highlight);
    if (highlight) this.view = 'table';
  }

  //
  // openEntity - the entity's history: its attributes to tick, those with a number, a boolean or a text ticked
  //
  openEntity(entity) {
    const info = new Map();
    for (const [k, v] of Object.entries(entity)) {
      if (k === 'id' || k === 'type' || k === '@context' || k === 'scope' || !v || typeof v !== 'object') continue;
      info.set(k, attrInfo(v));
    }
    const names = [...info.keys()].sort();
    const prev = this.ticks && this.ticks.id === entity.id ? this.ticks.attrs.filter((a) => info.has(a)) : null;
    const attrs = prev || names.filter((k) => info.get(k).graphable);
    this.ticks = { id: entity.id, attrs };
    this.highlight = null;
    this.start({ id: entity.id, entity, attr: null, attrs: attrs.length ? attrs : names.slice(0, 1), info, names });
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
    this.series = new Map(c.attrs.map((a) => [a, []]));
    this.aggs = null;
    this.state = 'reading';
    this.why = '';
    this.render();
    if (!c.attrs.length) { this.state = 'done'; this.render(); return; }

    const ds = c.attr && c.info.get(c.attr).datasetId;
    const base = `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(c.id)}?attrs=${c.attrs.map(encodeURIComponent).join(',')}` +
      `&timerel=between&timeAt=${encodeURIComponent(iso(from))}&endTimeAt=${encodeURIComponent(iso(to))}&timeproperty=${this.timeprop}` +
      (ds ? `&datasetId=${encodeURIComponent(ds)}` : '') +
      (this.timeprop !== 'observedAt' ? '&options=sysAttrs' : '');
    const listOf = (body, a) => { const x = body && body[a]; return Array.isArray(x) ? x : x ? [x] : []; };

    if (this.methods.size) {
      const q = `${base}&format=aggregatedValues&aggrMethods=${[...this.methods].join(',')}` + (this.period ? `&aggrPeriodDuration=${this.period}` : '');
      const r = await api.brokerGet(this.host.broker, q);
      if (ticket !== this.ticket) return;
      if (!emptyRange(r) && (!r.ok || !r.body || typeof r.body !== 'object')) { this.fail(r); return; }
      this.aggs = new Map(c.attrs.map((a) => [a, (r.ok && listOf(r.body, a)[0]) || {}]));
      this.state = 'done';
      this.render();
      return;
    }

    //
    // firstN is per attribute: a page holds up to PAGE instances of each; the next one is there while any has more
    //
    let offset = 0;
    for (;;) {
      const r = await api.brokerGet(this.host.broker, `${base}&firstN=${PAGE}` + (offset ? `&offsetN=${offset}` : ''));
      if (ticket !== this.ticket) return;
      //
      // No instance matches: an empty page
      //
      if (emptyRange(r)) { this.state = 'done'; break; }
      if (!r.ok || !r.body || typeof r.body !== 'object') { this.fail(r); return; }
      let got = 0;
      for (const a of c.attrs) { const l = listOf(r.body, a); got += l.length; this.series.get(a).push(...l); }
      const next = intervalAfter(r.headers.get('Link'));
      if (next === null || !got) { this.state = 'done'; break; }
      if (this.total() >= CAP) { this.state = 'capped'; break; }
      offset = next;
      this.render();
    }
    //
    // observedAt, the spec's default, found nothing - the instances may have none (a value without observedAt):
    // modifiedAt then, unless the time property was chosen
    //
    if (this.timepropAuto && this.state === 'done' && !this.total() && this.timeprop === 'observedAt') {
      this.timeprop = 'modifiedAt';
      this.timepropAuto = false;
      this.read();
      return;
    }
    this.sortAll();
    this.render();
  }

  sortAll() { for (const l of this.series.values()) l.sort((p, q) => this.timeOf(p) - this.timeOf(q)); }

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
    this.sortAll();
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
    if (c.attr) {
      const up = button('↑', 'btn', () => this.openEntity(c.entity), t("The entity's history"));
      up.setAttribute('aria-label', t("The entity's history"));
      head.append(up);
    }
    const ds = c.attr && c.info.get(c.attr).datasetId;
    const name = c.attr ? `${c.attr} · ${c.id}` : c.id;
    const title = el('span', 'jtitle', name);
    title.title = ds ? `${c.attr} (${ds}) · ${c.id}` : name;
    head.append(title, button('×', 'btn', () => this.close(), t('Close the history')));
    head.lastChild.setAttribute('aria-label', t('Close the history'));
    this.root.append(head, this.controls(), this.statusLine());

    const body = el('div', 'hp-body');
    if (this.state === 'error') body.append(el('p', 'hp-why', this.why));
    else if (!c.attrs.length) body.append(el('p', 'hp-hint', t('Tick the attributes to see')));
    else if (this.aggs) body.append(this.aggView());
    else if (!c.attr) body.append(this.view === 'table' ? this.entityTable() : this.entityGraph());
    else if (this.view === 'table' || this.shape() === 'table') body.append(this.table());
    else {
      body.append(this.graphRow(c.attr, this.instances, ROW_H, (inst) => { this.highlight = inst.instanceId; this.view = 'table'; this.render(); }));
      if (this.instances.length) body.append(el('p', 'hp-hint', t('A click shows the instance in the table - to modify or delete it')));
    }
    this.root.append(body, c.attr ? this.foot() : this.entityFoot());
    body.scrollTop = scroll;
    const hl = body.querySelector('tr.hl');
    if (hl) { hl.scrollIntoView({ block: 'center' }); this.highlight = null; }
  }

  shape() { return shapeOf(this.instances.map(valueOf)); }

  controls() {
    const c = this.ctx;
    const box = el('div', 'hp-ctl');

    //
    // The entity's: its attributes, ticked to be shown
    //
    if (!c.attr) {
      const picks = el('div', 'hp-picks');
      picks.setAttribute('role', 'group');
      picks.setAttribute('aria-label', t('Attributes'));
      for (const a of c.names) {
        const lab = el('label', 'hp-chip');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = c.attrs.includes(a);
        cb.onchange = () => { c.attrs = c.names.filter((n) => (n === a ? cb.checked : c.attrs.includes(n))); this.ticks = { id: c.id, attrs: c.attrs }; this.read(); };
        lab.append(cb, a);
        picks.append(lab);
      }
      box.append(picks);
    }

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
      b.setAttribute('aria-pressed', String(this.view === k && !this.aggs));
      b.disabled = !!this.aggs || (k === 'graph' && !!c.attr && this.state !== 'reading' && this.instances.length > 0 && this.shape() === 'table');
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
    const n = this.total();
    if (this.aggs) p.append(t('aggregated by the broker'));
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

  //
  // graphRow - one attribute's instances over the range, drawn by its values: a line (numbers), a step (booleans),
  // a band (texts); 'h' the height of a line or a step; 'onPick' the instance clicked
  //
  graphRow(attr, instances, h0, onPick) {
    const box = el('div', 'hp-graph');
    const pts = instances.map((i) => [this.timeOf(i), valueOf(i), i]).filter(([x]) => x);
    if (!pts.length) return box;
    const W = this.width();
    const { from, to } = rangeOf(this.range);
    const span = to - from || 1;
    const px = (x) => ((x - from) / span) * W;
    const shape = shapeOf(pts.map((p) => p[1]));
    if (shape === 'table') { box.append(el('p', 'hp-hint', t('{attr}: values without a graph - in the table', { attr }))); return box; }
    const h = shape === 'category' ? BAND_H : h0;
    const s = svg('svg', { viewBox: `${-YAXIS} -8 ${W + YAXIS + 4} ${h + 30}`, width: W + YAXIS + 4, height: h + 30, class: 'hp-svg', role: 'img' });
    const g = svg('g');
    s.append(g);
    this.axis(g, from, to, h);
    const tip = el('div', 'hp-tip');
    tip.hidden = true;
    const marker = svg('line', { y1: 0, y2: h, class: 'hp-cursor', visibility: 'hidden' });

    let at;                                       // the y of the instance nearest the pointer
    if (shape === 'number' || shape === 'boolean') {
      const vals = pts.map((p) => (shape === 'boolean' ? (p[1] ? 1 : 0) : p[1]));
      const vLo = Math.min(...vals), vHi = Math.max(...vals);
      let lo = vLo, hi = vHi;
      if (shape === 'boolean') { lo = 0; hi = 1; } else if (hi === lo) { hi += 1; lo -= 1; }
      const y = (v) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
      for (const [v, label] of shape === 'boolean' ? [[0, 'false'], [1, 'true']] : vLo === vHi ? [[vLo, fmtNum(vLo)]] : [[vLo, fmtNum(vLo)], [vHi, fmtNum(vHi)]]) {
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
        { attr, lo: fmtValue(Math.min(...pts.map((p) => p[1]))), hi: fmtValue(Math.max(...pts.map((p) => p[1]))) }));
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
      s.setAttribute('aria-label', plural(colour.size, '{attr}: {n} distinct value', '{attr}: {n} distinct values', { attr }));
    }
    g.append(marker);

    //
    // The pointer: the instance nearest it, its time and value; a click picks it
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
    s.addEventListener('click', (ev) => onPick(pts[nearest(ev)][2]));
    s.style.cursor = 'pointer';
    box.prepend(s);
    box.append(tip);
    return box;
  }

  //
  // entityGraph - a row per ticked attribute, on the same time axis; a click: that attribute's History, at the
  // instance clicked
  //
  entityGraph() {
    const c = this.ctx;
    const box = el('div', 'hp-rows');
    for (const a of c.attrs) {
      const row = el('div', 'hp-erow');
      const head = el('div', 'hp-ehead');
      const name = button(a, 'hp-aname', () => this.open(c.entity, a), t('Its history - to modify it'));
      const l = this.series.get(a) || [];
      head.append(name, el('span', 'hp-av', l.length ? fmtValue(valueOf(l[l.length - 1])) + (l[l.length - 1].unitCode ? ' ' + l[l.length - 1].unitCode : '') : '–'));
      row.append(head);
      if (l.length) row.append(this.graphRow(a, l, 90, (inst) => this.open(c.entity, a, inst.instanceId)));
      else row.append(el('p', 'hp-range', t('no instances in this range')));
      box.append(row);
    }
    if (this.total()) box.append(el('p', 'hp-hint', t("A click opens the attribute's history at that instance - to modify or delete it")));
    return box;
  }

  //
  // entityTable - a row per instant, a column per ticked attribute: the value at that instant, or (dimmed) the one
  // it had then
  //
  entityTable() {
    const c = this.ctx;
    const box = el('div', 'hp-tablebox');
    const rows = timeline(c.attrs, this.series, (i) => this.timeOf(i));
    if (!rows.length) return box;
    const tbl = el('table', 'hp-table');
    const hr = el('tr');
    hr.append(el('th', null, this.timeprop));
    for (const a of c.attrs) hr.append(el('th', null, a));
    const thead = el('thead');
    thead.append(hr);
    tbl.append(thead);
    const tb = el('tbody');
    for (const r of [...rows].reverse()) {
      const tr = el('tr');
      tr.append(el('td', 'mono', new Date(r.t).toISOString()));
      for (const cell of r.cells) {
        const td = el('td', 'mono hp-v' + (cell && !cell.fresh ? ' held' : ''), cell ? fmtValue(cell.v) : '');
        if (cell && !cell.fresh) td.title = t('the value it had then - its last instance before');
        tr.append(td);
      }
      tb.append(tr);
    }
    tbl.append(tb);
    box.append(tbl);
    return box;
  }

  // ------------------------------------------------------------------ the aggregation

  //
  // aggView - per attribute, per method: with a period, a row of its own over the range (a bar per period);
  // without one, its value
  //
  aggView() {
    const c = this.ctx;
    const box = el('div', 'hp-aggview');
    for (const a of c.attrs) {
      if (!c.attr) box.append(button(a, 'hp-aname hp-agghead', () => this.open(c.entity, a), t('Its history - to modify it')));
      this.aggRows(box, a, this.aggs.get(a) || {});
    }
    return box;
  }

  aggRows(box, attr, agg) {
    const W = this.width();
    const { from, to } = rangeOf(this.range);
    const span = to - from || 1;
    const px = (x) => ((Math.min(to, Math.max(from, x)) - from) / span) * W;
    for (const m of METHODS) {
      if (!this.methods.has(m)) continue;
      const list = Array.isArray(agg[m]) ? agg[m] : [];
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
      const nLo = Math.min(...nums), nHi = Math.max(...nums);
      let lo = nLo, hi = nHi;
      if (hi === lo) { hi += 1; lo -= 1; }
      //
      // The bars stand on the axis: counts and sums from 0, the others from a little under the lowest - so the
      // lowest has a height too
      //
      const counts = m === 'totalCount' || m === 'distinctCount' || m === 'sum' || m === 'sumsq';
      const base = counts ? Math.min(0, nLo) : nLo;
      lo = counts ? Math.min(base, lo) : lo - (hi - lo) * 0.15;
      const h = AGG_H;
      const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
      const s = svg('svg', { viewBox: `${-YAXIS} -6 ${W + YAXIS + 4} ${h + 26}`, width: W + YAXIS + 4, height: h + 26, class: 'hp-svg', role: 'img' });
      s.setAttribute('aria-label', plural(pts.length, '{attr} {method}: {n} period, from {lo} to {hi}', '{attr} {method}: {n} periods, from {lo} to {hi}',
        { attr, method: m, lo: fmtNum(Math.min(...nums)), hi: fmtNum(Math.max(...nums)) }));
      this.axis(s, from, to, h);
      for (const [v, label] of (y(base) - y(nHi) >= 14 ? [[base, fmtNum(base)], [nHi, fmtNum(nHi)]] : [[nHi, fmtNum(nHi)]])) {
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
      head.append(el('span', 'hp-av', nLo === nHi ? fmtNum(nLo) : `${fmtNum(nLo)} – ${fmtNum(nHi)}`));
      row.append(s);
      box.append(row);
    }
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
        const del = button(t('Delete…'), 'btn small', () => this.deleteInstance(inst));
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
  // parseValue - a value as typed for an attribute of kind 'kind': JSON when it is JSON (a number, true, an
  // object), else the text itself; a Relationship's target and a vocab as typed
  //
  parseValue(text, kind) {
    const s = text.trim();
    if (kind === 'Relationship' || kind === 'VocabProperty') return s;
    try { return JSON.parse(s); } catch { return text; }
  }

  //
  // instance - an instance of 'attr', as its kind takes the value, with its datasetId
  //
  instance(attr, value, observedAt, orig) {
    const { kind, datasetId } = this.ctx.info.get(attr);
    const inst = { type: kind };
    inst[MEMBER[kind] || 'value'] = value;
    if (observedAt) inst.observedAt = observedAt;
    if (orig && orig.unitCode) inst.unitCode = orig.unitCode;
    if (datasetId) inst.datasetId = datasetId;
    return inst;
  }

  //
  // editRow - the row's value and observedAt in fields: Save sends PATCH .../attrs/{attr}/{instanceId}
  //
  editRow(tr, inst) {
    const a = this.ctx.attr;
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
      const body = { [a]: [this.instance(a, this.parseValue(v.value, this.ctx.info.get(a).kind), at.value.trim() || undefined, inst)] };
      const r = await api.brokerWrite(this.host.broker, 'PATCH', this.instancePath(inst.instanceId), body);
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
    if (!(await this.host.confirmDelete(what))) return;
    const r = await api.brokerWrite(this.host.broker, 'DELETE', this.instancePath(inst.instanceId));
    if (!r.ok) { this.host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return; }
    this.host.toast(t('Deleted {what}', { what }));
    this.read();
  }

  foot() {
    const f = el('div', 'hp-foot');
    f.append(button(t('Add an instance…'), 'btn small', () => this.addForm(f, [this.ctx.attr])));
    const del = button(t('Delete this history…'), 'btn small', () => this.deleteHistory());
    del.title = t('Every instance the broker keeps of this attribute, also outside the range - the attribute itself stays');
    f.append(del);
    return f;
  }

  //
  // entityFoot - values added at one instant, the table as CSV, the entity's history deleted
  //
  entityFoot() {
    const c = this.ctx;
    const f = el('div', 'hp-foot');
    const add = button(t('Add values…'), 'btn small', () => this.addForm(f, c.attrs));
    add.title = t('A value for each ticked attribute, at one instant');
    add.disabled = !c.attrs.length;
    const csv = button(t('Download CSV'), 'btn small', () => this.download());
    csv.title = t('The table: a row per instant, a column per ticked attribute');
    csv.disabled = !this.total() || !!this.aggs;
    const del = button(t('Delete its history…'), 'btn small', async () => { if (await deleteEntityHistory(this.host, c.id)) this.read(); });
    del.title = t('Every instance of every attribute the broker keeps of this entity - the entity itself stays');
    f.append(add, csv, del);
    return f;
  }

  download() {
    const c = this.ctx;
    const text = csvOf(c.attrs, timeline(c.attrs, this.series, (i) => this.timeOf(i)), this.timeprop);
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const { from, to } = rangeOf(this.range);
    a.download = `${c.id.split(':').pop()}-${iso(from).slice(0, 16)}-${iso(to).slice(0, 16)}.csv`.replace(/[^\w.-]/g, '_');
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  //
  // addForm - a value per attribute (an empty one: none for it) and their observedAt (now, by default):
  // POST /temporal/entities/{id}/attrs - one instance each
  //
  addForm(f, attrs) {
    const c = this.ctx;
    f.textContent = '';
    const fields = attrs.map((a) => {
      const v = el('input', 'hp-in mono');
      v.placeholder = JSON_KINDS.includes(c.info.get(a).kind) ? t('the value, as JSON') : t('the value');
      v.setAttribute('aria-label', attrs.length > 1 ? a : t('value'));
      return [a, v];
    });
    const at = el('input', 'hp-in mono');
    at.value = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    at.setAttribute('aria-label', 'observedAt');
    const add = button(t('Add'), 'btn small primary', async () => {
      const body = {};
      for (const [a, v] of fields) if (v.value.trim()) body[a] = [this.instance(a, this.parseValue(v.value, c.info.get(a).kind), at.value.trim() || undefined)];
      if (!Object.keys(body).length) { fields[0][1].focus(); return; }
      const r = await api.brokerWrite(this.host.broker, 'POST', `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(c.id)}/attrs`, body);
      if (!r.ok) { this.host.toast(t('Not added - {why}', { why: brokerError(r) })); return; }
      const n = Object.keys(body).length;
      this.host.toast(c.attr ? t('Added an instance to the history of {attr}', { attr: c.attr }) : plural(n, 'Added {n} instance at {time}', 'Added {n} instances at {time}', { time: at.value.trim() || '–' }));
      this.read();
    });
    const box = el('div', 'hp-addbox');
    for (const [a, v] of fields) box.append(el('span', 'hp-lbl', attrs.length > 1 ? a : t('value')), v);
    box.append(el('span', 'hp-lbl', 'observedAt'), at);
    f.append(box, add, button(t('Cancel'), 'btn small', () => this.render()));
    fields[0][1].focus();
    for (const [, v] of fields) v.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  }

  historyWhat() {
    const c = this.ctx;
    const ds = c.info.get(c.attr).datasetId;
    return ds ? t('the history of {attr} (datasetId {ds})', { attr: c.attr, ds }) : t('the history of {attr}', { attr: c.attr });
  }

  async deleteHistory() {
    const c = this.ctx;
    const what = this.historyWhat();
    const ds = c.info.get(c.attr).datasetId;
    if (!(await this.host.confirmDelete(what))) return;
    const r = await api.brokerWrite(this.host.broker, 'DELETE', `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(c.id)}/attrs/${encodeURIComponent(c.attr)}` +
      (ds ? `?datasetId=${encodeURIComponent(ds)}` : ''));
    if (!r.ok) { this.host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return; }
    this.host.toast(t('Deleted {what}', { what }));
    this.read();
  }
}

//
// deleteEntityHistory - DELETE /temporal/entities/{id}: the entity's whole history (the entity itself stays) -
// asked first (confirmDelete)
//
export async function deleteEntityHistory(host, id) {
  const what = t('the history of {entity}', { entity: id });
  if (!(await host.confirmDelete(what))) return false;
  const r = await api.brokerWrite(host.broker, 'DELETE', '/ngsi-ld/v1/temporal/entities/' + encodeURIComponent(id));
  if (!r.ok) { host.toast(t('Not deleted - {why}', { why: brokerError(r) })); return false; }
  host.toast(t('Deleted {what}', { what }));
  return true;
}
