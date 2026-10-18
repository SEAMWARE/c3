//
// history.js - the Entity panel's History: an entity's numeric Properties over the last minutes, as sparklines
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Read once when the entity is selected - GET /ngsi-ld/v1/temporal/entities/{id}?timerel=after&timeAt=<10
// minutes ago>&attrs=<its numeric Properties>, on modifiedAt (every change, whether it has an observedAt or
// not) - then grown from the live values while it stays selected. A broker without a temporal API (no
// TRoE) shows the live values only, from the moment it was selected.
//
import * as api from './api.js';

const WINDOW_MS = 10 * 60 * 1000;
const POINTS_MAX = 600;                          // per attribute
const W = 300, H = 44;

const svgNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// numericAttrs - the Properties with a number for a value
//
export function numericAttrs(e) {
  const out = [];
  for (const [k, v] of Object.entries(e)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.type === 'Property' || v.type === undefined) && typeof v.value === 'number') out.push(k);
  }
  return out.sort();
}

const timeOf = (inst) => Date.parse(inst.observedAt || inst.modifiedAt || inst.createdAt || '') || null;

const fmt = (x) => (Math.abs(x) >= 1000 || Number.isInteger(x) ? String(Math.round(x)) : x.toFixed(Math.abs(x) < 10 ? 2 : 1));

export class History {
  constructor() {
    this.id = null;
    this.broker = null;
    this.series = new Map();                     // attr -> [[t, v]]
    this.state = 'none';                         // 'loading', 'ok', 'live' (no temporal API), 'none'
    this.why = '';
    this.onLoaded = () => {};                    // the panel to draw again
  }

  //
  // select - the entity shown: its history read when it is another one
  //
  select(broker, e) {
    if (!e) { this.id = null; return; }
    if (e.id === this.id && broker === this.broker) { this.append(e); return; }
    this.id = e.id;
    this.broker = broker;
    this.series = new Map();
    this.state = 'loading';
    const attrs = numericAttrs(e);
    if (!attrs.length) { this.state = 'none'; return; }
    for (const a of attrs) this.series.set(a, []);
    this.append(e);
    this.load(broker, e.id, attrs);
  }

  async load(broker, id, attrs) {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const path = `/ngsi-ld/v1/temporal/entities/${encodeURIComponent(id)}?timerel=after&timeAt=${encodeURIComponent(since)}` +
      `&attrs=${attrs.map(encodeURIComponent).join(',')}&timeproperty=modifiedAt&options=sysAttrs&lastN=${POINTS_MAX}`;
    const r = await api.brokerGet(broker, path);
    if (id !== this.id || broker !== this.broker) return;
    if (!r.ok || !r.body || typeof r.body !== 'object') {
      this.state = 'live';
      this.why = r.status === 0 || r.reached === false ? 'the broker is not reachable' : `the broker has no history for it (${r.status}${r.body && r.body.title ? ' ' + r.body.title : ''})`;
      this.onLoaded();
      return;
    }
    for (const a of attrs) {
      const inst = Array.isArray(r.body[a]) ? r.body[a] : r.body[a] ? [r.body[a]] : [];
      const pts = inst.map((x) => [timeOf(x), x && x.value]).filter(([t, v]) => t && typeof v === 'number');
      const live = this.series.get(a) || [];
      const merged = [...pts, ...live.filter(([t]) => !pts.length || t > pts[pts.length - 1][0])].sort((p, q) => p[0] - q[0]);
      this.series.set(a, merged.slice(-POINTS_MAX));
    }
    this.state = 'ok';
    this.onLoaded();
  }

  //
  // append - the entity's values now, from the live values: a point where a value changed (or time passed)
  //
  append(e) {
    for (const [a, pts] of this.series) {
      const v = e[a] && typeof e[a] === 'object' ? e[a].value : undefined;
      if (typeof v !== 'number') continue;
      const t = Date.parse(e[a].observedAt || '') || Date.now();
      const last = pts[pts.length - 1];
      if (last && last[0] >= t) continue;
      if (last && last[1] === v && t - last[0] < 5000) continue;
      pts.push([t, v]);
      if (pts.length > POINTS_MAX) pts.shift();
    }
  }

  //
  // render - the History section
  //
  render(e) {
    const box = el('details', 'history');
    box.open = this.open !== false;
    box.addEventListener('toggle', () => { this.open = box.open; });
    const sum = el('summary', null, 'History');
    box.append(sum);
    if (!e || e.id !== this.id) return box;
    if (this.state === 'none') { sum.append(el('span', 'hnote', 'no numeric Properties')); return box; }
    sum.append(el('span', 'hnote', this.state === 'loading' ? 'reading…' : this.state === 'live' ? 'since selected' : 'last 10 minutes'));
    if (this.state === 'live') box.append(el('p', 'hwhy', `Live values only: ${this.why}. A broker with TRoE (coraine --troe corDB) answers the last 10 minutes.`));

    const now = Date.now();
    const t0 = now - WINDOW_MS;
    for (const [a, all] of this.series) {
      const pts = all.filter(([t]) => t >= t0);
      const row = el('div', 'hrow');
      const head = el('div', 'hhead');
      head.append(el('span', 'k', a));
      const unit = e[a] && e[a].unitCode ? ' ' + e[a].unitCode : '';
      const cur = pts.length ? pts[pts.length - 1][1] : null;
      head.append(el('span', 'hv', cur === null ? '–' : fmt(cur) + unit));
      row.append(head);

      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('class', 'spark');
      svg.setAttribute('role', 'img');
      if (pts.length) {
        let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
        if (hi === lo) { hi += 1; lo -= 1; }
        const x = (t) => ((t - t0) / WINDOW_MS) * W;
        const y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
        //
        // A step line: a value holds until the next one; on to now
        //
        let d = '';
        pts.forEach(([t, v], i) => { d += (i ? `H${x(t).toFixed(1)}V` : `M${x(t).toFixed(1)},`) + y(v).toFixed(1); });
        d += `H${W}`;
        const area = document.createElementNS(svgNS, 'path');
        area.setAttribute('d', `${d}V${H}H${x(pts[0][0]).toFixed(1)}Z`);
        area.setAttribute('class', 'sa');
        const line = document.createElementNS(svgNS, 'path');
        line.setAttribute('d', d);
        line.setAttribute('class', 'sl');
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', String(W - 2));
        dot.setAttribute('cy', y(pts[pts.length - 1][1]).toFixed(1));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('class', 'sd');
        svg.append(area, line, dot);
        svg.setAttribute('aria-label', `${a}: ${pts.length} values, from ${fmt(lo)} to ${fmt(hi)}`);
        const range = el('div', 'hrange', `${fmt(Math.min(...pts.map((p) => p[1])))} – ${fmt(Math.max(...pts.map((p) => p[1])))}${unit} · ${pts.length} value${pts.length === 1 ? '' : 's'}`);
        row.append(svg, range);
      } else {
        svg.setAttribute('aria-label', `${a}: no values in the last 10 minutes`);
        row.append(svg, el('div', 'hrange', 'no values in the last 10 minutes'));
      }
      box.append(row);
    }
    return box;
  }
}
