//
// connect.js - Connect, read-only: a broker's entities as a graph
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
import * as api from './api.js';
import { loadEntities, edgesOf, typesOf, attributes, kindOf, relationshipTargets, valueText, shortId, boxAttrs, ENTITY_CAP } from './ngsild.js';
import { layout } from './layout.js';
import { Graph } from './graph.js';

const $ = (id) => document.getElementById(id);

//
// Type colours - by the type's place in the sorted list of the graph's types: the same graph, the same
// colours. Types beyond the palette repeat it.
//
const PALETTE = ['#A6ADBA', '#7FA3BC', '#6FA8FF', '#B48CFF', '#6FDCA0', '#5FB4E8', '#F2B84B', '#FF8A9A', '#E58AB1', '#C9D46A', '#4FD1C5', '#F59E6B'];

let colors = new Map();

function setTypeColors(types) {
  colors = new Map([...types].sort().map((t, i) => [t, PALETTE[i % PALETTE.length]]));
}

export function typeColor(type) {
  return colors.get(type) || PALETTE[0];
}

//
// typeLabel - a type as shown: the last part of an expanded IRI
//
function typeLabel(t) {
  const m = t.match(/[#/]([^#/]+)$/);
  return m && /^https?:/.test(t) ? m[1] : t;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Connect {
  constructor() {
    this.broker = null;
    this.entities = [];
    this.byId = new Map();
    this.hidden = new Set();
    this.loading = 0;                            // the load in progress; a newer one makes it stale

    this.graph = new Graph({
      viewport: $('viewport'), world: $('world'), svg: $('edges'),
      lines: $('edge-lines'), labels: $('edge-labels'), boxes: $('boxes'), pct: $('zoom-pct'),
    });
    this.graph.onSelect = (id) => this.showEntity(id);

    $('zoom-in').onclick = () => this.graph.zoomCenter(1.25);
    $('zoom-out').onclick = () => this.graph.zoomCenter(0.8);
    $('zoom-fit').onclick = () => this.graph.fit();
    $('connform').onsubmit = (e) => { e.preventDefault(); this.connect($('broker-url').value); };
    $('reload-btn').onclick = () => this.broker && this.connect(this.broker);
    $('types-all').onclick = () => this.setHidden([]);
    $('types-none').onclick = () => this.setHidden(this.typeList().map(([t]) => t));

    //
    // The graph's keys also work when nothing in particular has the focus
    //
    document.addEventListener('keydown', (e) => {
      if (e.target === document.body && !$('app').hidden) this.graph.onKey(e);
    });

    this.empty('Connect to a broker', 'Enter its URL above - for example http://localhost:1026. c³ reads its entities with ordinary NGSI-LD queries, through the backend.');
  }

  //
  // brokers - the configuration's brokers, for the URL field's list
  //
  setBrokers(brokers) {
    const list = $('broker-list');
    list.textContent = '';
    for (const b of brokers || []) {
      const o = document.createElement('option');
      o.value = b.url;
      o.label = b.name && b.name !== b.url.replace(/^https?:\/\//, '') ? b.name : '';
      list.append(o);
    }
  }

  setState(kind, label) {
    $('state').className = 'state ' + kind;
    $('state-label').textContent = label;
  }

  overlay(card) {
    const o = $('overlay');
    if (!card) { o.hidden = true; return; }
    const c = $('overlay-card');
    c.className = 'card ' + (card.cls || '');
    c.textContent = '';
    c.append(...card.children);
    o.hidden = false;
  }

  empty(title, text) {
    this.overlay({ children: [el('h3', null, title), el('p', null, text)] });
  }

  //
  // connect - load a broker's entities and draw them
  //
  async connect(input) {
    let url = String(input || '').trim();
    if (!url) { $('broker-url').focus(); return; }
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    url = url.replace(/\/+$/, '');
    $('broker-url').value = url;

    const ticket = ++this.loading;
    this.broker = url;
    $('chip').textContent = url;
    $('reload-btn').disabled = false;
    $('notice').hidden = true;
    $('counts').textContent = '';
    this.setState('busy', 'Loading');

    const bar = el('div');
    const line = el('p', null, 'Asking for the entities…');
    const progress = el('div', 'progress');
    progress.append(bar);
    this.overlay({ children: [el('h3', null, 'Loading'), el('p', 'mono', url), line, progress] });

    let result;
    try {
      result = await loadEntities(url, (n, total) => {
        if (ticket !== this.loading) return;
        const of = total !== null ? Math.min(total, ENTITY_CAP) : null;
        line.textContent = of ? `${n} of ${of} entities` : `${n} entities`;
        bar.style.width = of ? Math.round(100 * n / Math.max(of, 1)) + '%' : '50%';
      });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.failed(url, err);
      return;
    }
    if (ticket !== this.loading) return;

    this.draw(result.entities);
    this.setState('ok', 'Connected');

    const edges = this.graph.edges.length;
    $('counts').textContent = `${result.entities.length} entities · ${edges} relationship${edges === 1 ? '' : 's'}`;
    if (result.truncated) {
      $('notice').hidden = false;
      $('notice').textContent = `showing the first ${result.entities.length} of ${result.total} - c³ loads at most ${ENTITY_CAP}`;
    }

    if (result.entities.length === 0) this.empty('No entities', `${url} answered, and has no entities (in the default tenant).`);
    else this.overlay(null);

    try {
      const config = await api.brokerTouch(url);
      this.setBrokers(config.brokers);
    } catch (e) {
      console.warn('c3: the configuration was not saved:', e.message);
    }
  }

  failed(url, err) {
    this.setState('bad', err.reached === false ? 'Not reachable' : 'Error');
    this.draw([]);
    const retry = el('button', 'btn primary', 'Retry');
    retry.type = 'button';
    retry.onclick = () => this.connect(url);
    const actions = el('div', 'actions');
    actions.append(retry);
    const children = [
      el('h3', null, err.reached === false ? 'The broker cannot be reached' : `The broker answered ${err.status || ''}`.trim()),
      el('p', 'mono', url),
      el('p', null, [err.title, err.detail].filter(Boolean).join(' - ') || String(err.message || err)),
    ];
    if (err.reached === false) children.push(el('p', null, 'Is it running, and is the URL right? c³ reaches the broker from the machine c³ runs on.'));
    children.push(actions);
    this.overlay({ cls: 'bad', children });
  }

  //
  // draw - the entities as the graph
  //
  draw(entities) {
    const sorted = [...entities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.entities = sorted;
    this.byId = new Map(sorted.map((e) => [e.id, e]));
    const edges = edgesOf(sorted, this.byId);
    setTypeColors(new Set(sorted.flatMap((e) => typesOf(e))));

    const nodes = sorted.map((e) => {
      const types = typesOf(e);
      return {
        id: e.id, types,
        color: typeColor(types[0]),
        label: types.map(typeLabel).join(', '),
        short: shortId(e),
        attrs: boxAttrs(e),
      };
    });
    const positions = layout(nodes.map((n) => ({ id: n.id, type: n.types[0] })), edges);

    this.graph.set(nodes, edges, positions);
    const known = new Set(nodes.flatMap((n) => n.types));
    this.hidden = new Set([...this.hidden].filter((t) => known.has(t)));
    this.graph.setHidden(this.hidden);
    this.renderTypes();
    this.graph.fit();
    this.showEntity(null);
  }

  typeList() {
    const counts = new Map();
    for (const e of this.entities) for (const t of typesOf(e)) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts].sort((a, b) => (typeLabel(a[0]) < typeLabel(b[0]) ? -1 : typeLabel(a[0]) > typeLabel(b[0]) ? 1 : 0));
  }

  setHidden(types) {
    this.hidden = new Set(types);
    this.graph.setHidden(this.hidden);
    this.renderTypes();
  }

  renderTypes() {
    const list = $('typelist');
    list.textContent = '';
    const types = this.typeList();
    $('typeall').hidden = types.length < 2;
    for (const [t, n] of types) {
      const b = el('button', 'type');
      b.type = 'button';
      b.title = t;
      b.setAttribute('aria-pressed', this.hidden.has(t) ? 'false' : 'true');
      const sw = el('span', 'swatch');
      sw.style.background = typeColor(t);
      sw.style.color = typeColor(t);
      b.append(sw, el('span', 'name', typeLabel(t)), el('span', 'n', String(n)));
      b.onclick = () => {
        const h = new Set(this.hidden);
        if (h.has(t)) h.delete(t); else h.add(t);
        this.setHidden(h);
      };
      list.append(b);
    }
  }

  //
  // follow - a Relationship's target: shown (its type switched on), selected, centred
  //
  follow(id) {
    const e = this.byId.get(id);
    if (!e) return;
    const types = typesOf(e);
    if (types.every((t) => this.hidden.has(t))) {
      const h = new Set(this.hidden);
      types.forEach((t) => h.delete(t));
      this.setHidden(h);
    }
    this.graph.select(id, { center: true });
  }

  //
  // showEntity - the attribute panel
  //
  showEntity(id) {
    const body = $('entity-body');
    const e = id ? this.byId.get(id) : null;
    $('entity-empty').hidden = !!e;
    body.hidden = !e;
    body.textContent = '';
    if (!e) return;

    body.append(el('div', 'eid', e.id));
    const types = el('div', 'etypes');
    for (const t of typesOf(e)) {
      const s = el('span', 'etype', typeLabel(t));
      s.style.color = typeColor(t);
      s.title = t;
      types.append(s);
    }
    body.append(types);

    for (const [name, v] of attributes(e)) {
      const row = el('div', 'attr');
      const kind = kindOf(v);
      row.append(el('span', 'k', name), el('span', 'kind', kind));

      if (kind === 'Relationship' || kind === 'ListRelationship') {
        for (const target of relationshipTargets(v)) {
          const b = el('button', 'rel', target);
          b.type = 'button';
          if (this.byId.has(target)) b.onclick = () => this.follow(target);
          else { b.classList.add('missing'); b.disabled = true; }
          row.append(b);
        }
      } else {
        row.append(el('span', 'v', valueText(v, 400)));
      }

      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (['type', 'value', 'object', 'objectList', 'languageMap', 'valueList', 'vocab', 'json', 'unitCode'].includes(sk)) continue;
          const sub = el('span', 'sub');
          sub.append(sk + ' ', el('span', 'mono', typeof sv === 'object' && sv !== null && 'type' in sv ? valueText(sv, 120) : (typeof sv === 'string' ? sv : JSON.stringify(sv))));
          row.append(sub);
        }
      }
      body.append(row);
    }

    const raw = el('details', 'raw');
    raw.append(el('summary', null, 'JSON'), el('pre', null, JSON.stringify(e, null, 2)));
    body.append(raw);
  }
}
