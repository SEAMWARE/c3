//
// connect.js - Connect, read-only: what a broker holds (discovery), the types picked as a graph or on a
// map, and a menu on each entity
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
import * as api from './api.js';
import {
  loadEntities, discover, entityGet, entitiesQuery, relationshipNames, linked, typeParam,
  edgesOf, typesOf, attributes, kindOf, relationshipTargets, valueText, shortId, boxAttrs, ENTITY_CAP,
} from './ngsild.js';
import { layout } from './layout.js';
import { Graph } from './graph.js';
import { openMenu, closeMenu } from './menu.js';
import { EntityMap, geometries, nameOf } from './map.js';
import { OfflinePanel } from './offline.js';

const $ = (id) => document.getElementById(id);

//
// A broker with this many entities or fewer is loaded whole on the first connect; a larger one waits
// for the types to be picked
//
const SMALL_BROKER = 300;

//
// The neighbourhood of an entity: at most this many entities pointing at it
//
const HOOD_IN_MAX = 300;

//
// Type colours - by the type's place in the sorted list of the broker's types (discovery), or of the
// graph's types when the broker has no discovery: the same broker, the same colours, whatever is picked.
// Types beyond the palette repeat it.
//
const PALETTE = ['#5FB4E8', '#F2B84B', '#6FDCA0', '#B48CFF', '#FF8A9A', '#6FA8FF', '#C9D46A', '#4FD1C5', '#F59E6B', '#E58AB1', '#7FA3BC', '#A6ADBA'];

let colors = new Map();

function setTypeColors(types) {
  colors = new Map([...new Set(types)].sort().map((t, i) => [t, PALETTE[i % PALETTE.length]]));
}

export function typeColor(type) {
  return colors.get(type) || PALETTE[0];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

//
// typeLabel - a type as shown: the last part of an expanded IRI
//
function typeLabel(t) {
  const m = t.match(/[#/]([^#/]+)$/);
  return m && /^https?:/.test(t) ? m[1] : t;
}

//
// targetLabel - an entity id that is not loaded, as shown: urn:ngsi-ld:Dock:dock3 -> Dock:dock3
//
function targetLabel(id) {
  return shortId({ id, type: [] });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class Connect {
  constructor() {
    this.broker = null;
    this.disc = null;                            // discover()'s answer, null when the broker has none
    this.picks = [];                             // the types ticked, sorted
    this.loadedPicks = null;                     // the types the loaded entities are of (null: all)
    this.loaded = [];                            // the entities of the picked types
    this.loadedById = new Map();
    this.entities = [];                          // the entities shown: the loaded ones, or a neighbourhood
    this.byId = new Map();
    this.mode = null;                            // null, or { kind: 'hood', id, text }
    this.hidden = new Set();
    this.open = new Set();                       // types whose attribute list is open
    this.typeRels = [];                          // [{from, name, to, n}] from the loaded entities
    this.unresolved = 0;                         // Relationships to entities not loaded
    this.loadedKinds = new Map();                // type -> attribute -> Set(kind), from the loaded entities
    this.loading = 0;                            // the load in progress; a newer one makes it stale
    this.view = 'graph';                         // 'graph' or 'map' - kept per broker
    this.mapView = null;                         // the map's view kept for the broker: {center, zoom, ...}
    this.colourBy = 'type';                      // the map's markers: by type, or by a Relationship's target
    this.edges = [];

    this.graph = new Graph({
      viewport: $('viewport'), world: $('world'), svg: $('edges'),
      lines: $('edge-lines'), labels: $('edge-labels'), boxes: $('boxes'), pct: $('zoom-pct'),
    });
    this.graph.onSelect = (id) => { this.showEntity(id); this.emap.select(id); };
    this.graph.onMenu = (id, at, target) => this.menu(id, at, target);
    this.graph.onCollapse = (id) => {
      const n = this.graph.nodes.get(id);
      if (n) n.el.focus({ preventScroll: true });
    };

    //
    // The map
    //
    this.emap = new EntityMap({ container: $('mapview') });
    this.emap.onSelect = (id) => this.graph.select(id);
    this.emap.onMenu = (id, at, target) => this.menu(id, at, target);
    this.emap.onView = (v) => {
      this.mapView = v;
      clearTimeout(this.viewTimer);
      const url = this.broker;
      this.viewTimer = setTimeout(() => url && api.brokerConnect(url, { map: v }).catch(() => {}), 800);
    };
    this.emap.onOnline = (ok) => { $('map-offline').hidden = ok; };
    this.offline = new OfflinePanel({ map: this.emap, toast: (t) => this.toast(t), onAreas: (areas, fonts) => this.emap.setAreas(areas, fonts) });
    $('view-graph').onclick = () => this.setView('graph', true);
    $('view-map').onclick = () => this.setView('map', true);
    $('map-in').onclick = () => this.emap.zoomBy(1);
    $('map-out').onclick = () => this.emap.zoomBy(-1);
    $('map-fit').onclick = () => this.emap.fit();
    $('map-download').onclick = () => (this.offline.isOpen() ? this.offline.close() : this.offline.open());
    $('colour-by').onchange = () => {
      this.colourBy = $('colour-by').value;
      this.renderMapChrome();
      if (this.broker) api.brokerConnect(this.broker, { colourBy: this.colourBy }).catch(() => {});
    };

    $('zoom-in').onclick = () => this.graph.zoomCenter(1.25);
    $('zoom-out').onclick = () => this.graph.zoomCenter(0.8);
    $('zoom-fit').onclick = () => this.graph.fit();
    $('connform').onsubmit = (e) => { e.preventDefault(); this.connect($('broker-url').value); };
    $('reload-btn').onclick = () => this.broker && this.connect(this.broker);
    $('pick-all').onclick = () => this.setPicks(this.disc ? this.disc.types.map((t) => t.name) : []);
    $('pick-none').onclick = () => this.setPicks([]);
    $('load-btn').onclick = () => this.loadPicks(true);
    $('mode-back').onclick = () => this.back();
    $('json-close').onclick = () => this.closeJson();
    $('json-copy').onclick = () => this.copy($('json-pre').textContent, 'the JSON');
    $('jsonpanel').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeJson(); }
    });

    //
    // The graph's keys also work when nothing in particular has the focus
    //
    document.addEventListener('keydown', (e) => {
      if (e.target === document.body && !$('app').hidden && this.view === 'graph') this.graph.onKey(e);
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

  progressCard(title, url, text) {
    const bar = el('div');
    const line = el('p', null, text);
    const progress = el('div', 'progress');
    progress.append(bar);
    this.overlay({ children: [el('h3', null, title), el('p', 'mono', url), line, progress] });
    return {
      set(t, frac) { line.textContent = t; bar.style.width = frac === null ? '50%' : Math.round(100 * frac) + '%'; },
    };
  }

  toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  //
  // connect - what the broker holds, then the entities of the types picked
  //
  async connect(input) {
    let url = String(input || '').trim();
    if (!url) { $('broker-url').focus(); return; }
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    url = url.replace(/\/+$/, '');
    $('broker-url').value = url;

    const ticket = ++this.loading;
    this.broker = url;
    this.mode = null;
    $('modebar').hidden = true;
    this.closeJson();
    closeMenu(false);
    $('chip').textContent = url;
    $('reload-btn').disabled = false;
    $('notice').hidden = true;
    $('counts').textContent = '';
    this.setState('busy', 'Discovering');

    const card = this.progressCard('Discovering', url, 'Asking for the entity types…');

    let disc;
    try {
      disc = await discover(url, (n, of) => {
        if (ticket === this.loading) card.set(`${n} of ${plural(of, 'type')}`, n / Math.max(of, 1));
      });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.disc = null;
      this.failed(url, err);
      return;
    }
    if (ticket !== this.loading) return;
    this.disc = disc;

    //
    // The broker answered: it goes into the configuration, which also holds the types picked last time
    //
    let saved;
    try {
      const config = await api.brokerTouch(url);
      this.setBrokers(config.brokers);
      const b = (config.brokers || []).find((x) => x.url === url);
      const c = (b && b.connect) || {};
      if (Array.isArray(c.types)) saved = c.types.map(String);
      this.mapView = c.map && Array.isArray(c.map.center) ? c.map : null;
      this.pendingView = this.mapView;
      this.colourBy = typeof c.colourBy === 'string' ? c.colourBy : 'type';
      if (c.view === 'map' || c.view === 'graph') this.setView(c.view, false);
    } catch (e) {
      console.warn('c3: the configuration was not saved:', e.message);
    }
    if (ticket !== this.loading) return;

    this.loadedPicks = undefined;
    this.loaded = [];
    this.loadedById = new Map();

    if (!disc) {
      //
      // No discovery (no /types): every entity, as milestone 1 did
      //
      this.picks = [];
      setTypeColors([]);
      this.renderDiscovery();
      await this.load(null, false, ticket);
      return;
    }

    const names = disc.types.map((t) => t.name);
    setTypeColors(names);
    if (saved !== undefined) this.picks = saved.filter((t) => names.includes(t)).sort(cmp);
    else if (disc.total <= SMALL_BROKER) this.picks = [...names];
    else this.picks = [];

    this.renderDiscovery();

    if (this.picks.length) {
      await this.load(this.picks, false, ticket);
      return;
    }

    this.draw([]);
    this.loadedPicks = [];
    this.renderDiscovery();
    this.setState('ok', 'Connected');
    $('counts').textContent = `${plural(disc.types.length, 'type')} · ${disc.total} entities`;
    const why = saved !== undefined
      ? 'No types are picked for this broker.'
      : `${url} holds ${disc.total} entities of ${plural(disc.types.length, 'type')} - more than c³ loads without asking (${SMALL_BROKER}).`;
    if (disc.types.length === 0) this.empty('No entities', `${url} answered, and has no entities (in the default tenant).`);
    else this.overlay({ children: [el('h3', null, 'Choose what to see'), el('p', null, why), el('p', null, 'Tick the types on the left and press Load. The choice is kept for this broker.')] });
  }

  //
  // load - the entities of 'types' (null: all of them), drawn; 'save' keeps the choice in the configuration
  //
  async load(types, save, ticket = ++this.loading) {
    const url = this.broker;
    this.mode = null;
    $('modebar').hidden = true;
    $('notice').hidden = true;
    this.setState('busy', 'Loading');
    const card = this.progressCard('Loading', url, types ? `Asking for the entities of ${plural(types.length, 'type')}…` : 'Asking for the entities…');

    let result;
    try {
      result = await loadEntities(url, (n, total) => {
        if (ticket !== this.loading) return;
        const of = total !== null ? Math.min(total, ENTITY_CAP) : null;
        card.set(of ? `${n} of ${of} entities` : `${n} entities`, of ? n / Math.max(of, 1) : null);
      }, types);
    } catch (err) {
      if (ticket !== this.loading) return;
      this.failed(url, err);
      return;
    }
    if (ticket !== this.loading) return;

    this.loadedPicks = types ? [...types] : null;
    this.loaded = result.entities;
    this.loadedById = new Map(this.loaded.map((e) => [e.id, e]));
    if (!this.disc) setTypeColors(this.loaded.flatMap((e) => typesOf(e)));
    this.summarise();
    this.draw(this.loaded);
    this.renderDiscovery();
    this.setState('ok', 'Connected');

    const edges = this.graph.edges.length;
    const of = types && this.disc ? ` of ${plural(types.length, 'type')}` : '';
    $('counts').textContent = `${result.entities.length} entities${of} · ${plural(edges, 'relationship')}`;
    if (result.truncated) {
      $('notice').hidden = false;
      $('notice').textContent = `showing the first ${result.entities.length} of ${result.total} - c³ loads at most ${ENTITY_CAP}`;
    }

    if (result.entities.length === 0) {
      if (types && types.length === 0) this.empty('Nothing picked', 'Tick the types to see on the left and press Load.');
      else this.empty('No entities', `${url} answered, and has no entities${types ? ' of the types picked' : ''} (in the default tenant).`);
    } else this.overlay(null);

    if (save) {
      try {
        await api.brokerTypes(url, types || []);
      } catch (e) {
        console.warn('c3: the types picked were not saved:', e.message);
      }
    }
  }

  loadPicks(save) {
    if (!this.broker) return;
    this.load([...this.picks], save);
  }

  setPicks(types) {
    this.picks = [...new Set(types)].sort(cmp);
    this.renderDiscovery();
  }

  failed(url, err) {
    this.setState('bad', err.reached === false ? 'Not reachable' : 'Error');
    this.draw([]);
    this.renderDiscovery();
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
  // summarise - from the loaded entities: the Relationships between types, and the attribute kinds
  //
  summarise() {
    const rels = new Map();
    const kinds = new Map();
    let unresolved = 0;
    for (const e of this.loaded) {
      const from = typesOf(e);
      for (const [name, v] of attributes(e)) {
        const kind = kindOf(v);
        for (const t of from) {
          if (!kinds.has(t)) kinds.set(t, new Map());
          const m = kinds.get(t);
          if (!m.has(name)) m.set(name, new Set());
          m.get(name).add(kind);
        }
        for (const to of relationshipTargets(v)) {
          const target = this.loadedById.get(to);
          if (!target) { ++unresolved; continue; }
          for (const f of from) for (const t of typesOf(target)) {
            const key = f + '\n' + name + '\n' + t;
            rels.set(key, (rels.get(key) || 0) + 1);
          }
        }
      }
    }
    this.typeRels = [...rels].map(([k, n]) => { const [from, name, to] = k.split('\n'); return { from, name, to, n }; })
      .sort((a, b) => cmp(typeLabel(a.from), typeLabel(b.from)) || cmp(a.name, b.name) || cmp(typeLabel(a.to), typeLabel(b.to)));
    this.unresolved = unresolved;
    this.loadedKinds = kinds;
  }

  //
  // draw - entities as the graph
  //
  draw(entities) {
    this.graph.collapse();
    const sorted = [...entities].sort((a, b) => cmp(a.id, b.id));
    this.entities = sorted;
    this.byId = new Map(sorted.map((e) => [e.id, e]));
    const edges = edgesOf(sorted, this.byId);
    this.edges = edges;

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
    this.graph.setHidden(this.hidden);
    this.graph.fit();
    this.emap.select(null);
    this.emap.set(sorted, edges, (e) => this.mapColor(e));
    this.renderMapChrome();
    this.showEntity(null);
    this.mapPlaced = false;
    this.mapPlace();
  }

  //
  // setView - the graph or the map; 'save' keeps the choice for the broker
  //
  async setView(view, save) {
    this.view = view;
    $('view-graph').setAttribute('aria-pressed', view === 'graph' ? 'true' : 'false');
    $('view-map').setAttribute('aria-pressed', view === 'map' ? 'true' : 'false');
    $('viewport').hidden = view !== 'graph';
    $('graphbar').hidden = view !== 'graph';
    $('mapview').hidden = view !== 'map';
    $('mapbar').hidden = view !== 'map';
    $('mapfoot').hidden = view !== 'map';
    if (view !== 'map') this.offline.close();
    if (save && this.broker) api.brokerConnect(this.broker, { view }).catch(() => {});
    if (view !== 'map') return;

    if (!this.emap.ready) {
      const st = await this.offline.refresh();
      this.emap.areas = st.areas || [];
      this.emap.fonts = !!st.fonts;
      await this.emap.open(this.mapView);
      if (st.job && ['planning', 'tiles', 'fonts'].includes(st.job.state)) this.offline.open();
    } else {
      await this.emap.ready;
      this.emap.resize();
    }
    this.mapPlace();
    if (this.graph.sel) this.emap.select(this.graph.sel);
  }

  //
  // mapPlace - the map's view for entities just drawn: the view kept for the broker the first time after
  // a connect, else fitted to them; once per set of entities (switching views keeps where the map is)
  //
  mapPlace() {
    if (this.view !== 'map' || !this.emap.map || !this.emap.boxes.size || this.mapPlaced) return;
    this.mapPlaced = true;
    const v = this.pendingView;
    this.pendingView = null;
    if (v) this.emap.map.jumpTo({ center: v.center, zoom: v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 });
    else this.emap.fit(false);
  }

  //
  // Colour by - the type (as the graph), or the target of a Relationship: each target its colour, the
  // entities pointing at it in the same one, the target itself too
  //
  colourOptions() {
    const counts = new Map();
    for (const e of this.entities) {
      for (const [name, v] of attributes(e)) {
        const k = kindOf(v);
        if ((k === 'Relationship' || k === 'ListRelationship') && relationshipTargets(v).length) counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts].sort((a, b) => cmp(a[0], b[0]));
  }

  targetsOf(rel) {
    const t = new Map();
    for (const e of this.entities) {
      for (const [name, v] of attributes(e)) {
        if (name !== rel) continue;
        const first = relationshipTargets(v)[0];
        if (first) { t.set(first, (t.get(first) || 0) + 1); break; }
      }
    }
    return new Map([...t.keys()].sort(cmp).map((id, i) => [id, { color: PALETTE[i % PALETTE.length], n: t.get(id) }]));
  }

  mapColor(e) {
    if (this.colourBy === 'type' || !this.colourTargets) return typeColor(typesOf(e)[0]);
    for (const [name, v] of attributes(e)) {
      if (name !== this.colourBy) continue;
      const first = relationshipTargets(v)[0];
      if (first && this.colourTargets.has(first)) return this.colourTargets.get(first).color;
    }
    if (this.colourTargets.has(e.id)) return this.colourTargets.get(e.id).color;
    return '#5A616E';
  }

  //
  // renderMapChrome - the colour-by choices, the legend, how many entities are not on the map
  //
  renderMapChrome() {
    const opts = this.colourOptions();
    const known = this.colourBy !== 'type' && opts.some(([n]) => n === this.colourBy);
    this.colourTargets = known ? this.targetsOf(this.colourBy) : null;
    const sel = $('colour-by');
    sel.textContent = '';
    const o = el('option', null, 'type');
    o.value = 'type';
    sel.append(o);
    for (const [name] of opts) {
      const x = el('option', null, name + ' →');
      x.value = name;
      sel.append(x);
    }
    sel.value = this.colourTargets ? this.colourBy : 'type';
    this.emap.setColors((e) => this.mapColor(e));

    const legend = $('legend');
    legend.textContent = '';
    legend.hidden = !this.colourTargets;
    if (this.colourTargets) {
      legend.append(el('span', 'lt', `${this.colourBy} →`));
      for (const [id, { color, n }] of this.colourTargets) {
        const sw = el('span', 'sw');
        sw.style.background = color;
        const t = this.byId.get(id);
        const ln = el('span', 'ln', t ? nameOf(t) || shortId(t) : targetLabel(id));
        ln.title = id;
        legend.append(sw, ln, el('span', 'lc', String(n)));
      }
    }

    const off = this.emap.notOnMap.length;
    const shownCount = this.entities.filter((e) => this.emap.visible(e)).length;
    const nm = $('not-on-map');
    nm.textContent = shownCount ? `on the map: ${shownCount - off} · not on the map: ${off}` : '';
    const byType = new Map();
    for (const e of this.emap.notOnMap) for (const t of typesOf(e)) byType.set(typeLabel(t), (byType.get(typeLabel(t)) || 0) + 1);
    nm.title = off ? 'No GeoProperty: ' + [...byType].map(([t, n]) => `${t} ${n}`).join(', ') : '';
  }

  //
  // shownCounts - type -> how many of the shown entities are of it
  //
  shownCounts() {
    const counts = new Map();
    for (const e of this.entities) for (const t of typesOf(e)) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  }

  setHidden(types) {
    this.hidden = new Set(types);
    this.graph.setHidden(this.hidden);
    this.emap.setHidden(this.hidden);
    this.renderMapChrome();
    this.renderDiscovery();
  }

  //
  // renderDiscovery - the panel on the left: the types (picked, shown, their attributes), the
  // Relationships between them
  //
  renderDiscovery() {
    const list = $('typelist');
    list.textContent = '';
    const shown = this.shownCounts();
    const disc = this.disc;
    const loadedSet = new Set(this.loadedPicks || []);

    let rows;
    if (disc) rows = disc.types.map((t) => ({ name: t.name, count: t.count, attrs: t.attrs }));
    else rows = [...shown].map(([name, n]) => ({ name, count: n, attrs: [] }));
    const extra = [...shown.keys()].filter((t) => !rows.some((r) => r.name === t));
    rows.push(...extra.map((name) => ({ name, count: null, attrs: [] })));
    rows.sort((a, b) => cmp(typeLabel(a.name), typeLabel(b.name)) || cmp(a.name, b.name));

    $('disc-sum').textContent = !this.broker ? '' : disc
      ? `${plural(disc.types.length, 'type')} · ${disc.total} entities`
      : (this.loadedPicks === null ? 'no discovery - every entity loaded' : '');
    $('typeall').hidden = !disc || disc.types.length < 2;

    for (const r of rows) {
      const row = el('div', 'trow');
      row.setAttribute('role', 'listitem');
      const isShown = shown.has(r.name);

      if (disc) {
        const pick = el('input');
        pick.type = 'checkbox';
        pick.checked = this.picks.includes(r.name);
        pick.setAttribute('aria-label', `Load ${typeLabel(r.name)}`);
        pick.title = 'Load this type';
        pick.onchange = () => {
          const p = new Set(this.picks);
          if (pick.checked) p.add(r.name); else p.delete(r.name);
          this.setPicks([...p]);
        };
        row.append(pick);
      }

      const b = el('button', 'type');
      b.type = 'button';
      b.title = r.name + (isShown ? ` - ${shown.get(r.name)} shown; click to ${this.hidden.has(r.name) ? 'show' : 'hide'}` : ' - none shown');
      b.disabled = !isShown;
      b.setAttribute('aria-pressed', isShown && !this.hidden.has(r.name) ? 'true' : 'false');
      if (!isShown) b.classList.add('unloaded');
      const sw = el('span', 'swatch');
      sw.style.background = typeColor(r.name);
      sw.style.color = typeColor(r.name);
      const n = r.count === null ? (isShown ? String(shown.get(r.name)) : '–') : String(r.count);
      b.append(sw, el('span', 'name', typeLabel(r.name)), el('span', 'n', n));
      b.onclick = () => {
        const h = new Set(this.hidden);
        if (h.has(r.name)) h.delete(r.name); else h.add(r.name);
        this.setHidden(h);
      };
      row.append(b);

      const more = el('button', 'more', '▸');
      more.type = 'button';
      more.setAttribute('aria-expanded', this.open.has(r.name) ? 'true' : 'false');
      more.setAttribute('aria-label', `Attributes of ${typeLabel(r.name)}`);
      more.onclick = () => {
        if (this.open.has(r.name)) this.open.delete(r.name); else this.open.add(r.name);
        this.renderDiscovery();
        const again = [...$('typelist').querySelectorAll('.more')].find((x) => x.getAttribute('aria-label') === more.getAttribute('aria-label'));
        if (again) again.focus();
      };
      row.append(more);
      list.append(row);

      if (this.open.has(r.name)) list.append(this.attrList(r));
    }

    //
    // The Load button: enabled when the ticks differ from what is loaded
    //
    const lb = $('load-btn');
    lb.hidden = !disc || !this.broker;
    if (disc) {
      const counts = new Map(disc.types.map((t) => [t.name, t.count || 0]));
      const sum = this.picks.reduce((s, t) => s + (counts.get(t) || 0), 0);
      const dirty = this.loadedPicks === undefined || this.loadedPicks === null || !sameList(this.picks, this.loadedPicks);
      lb.disabled = !dirty;
      lb.textContent = !dirty ? 'Loaded' : this.picks.length === 0 ? 'Load nothing'
        : `Load ${plural(this.picks.length, 'type')} · ${sum}${sum > ENTITY_CAP ? ` (first ${ENTITY_CAP})` : ''}`;
    }

    this.renderRels();

    const notes = $('disc-notes');
    notes.textContent = '';
    if (this.broker && !disc && this.loadedPicks === null) notes.append(el('p', null, 'The broker did not answer GET /ngsi-ld/v1/types: every entity is loaded (up to ' + ENTITY_CAP + '), with no picking.'));
    for (const n of (disc && disc.notes) || []) notes.append(el('p', null, n));
  }

  //
  // attrList - a type's attributes with their kinds; a Relationship with the types it points to, as far as
  // the loaded entities tell
  //
  attrList(r) {
    const box = el('div', 'tattrs');
    const loadedK = this.loadedKinds.get(r.name) || new Map();
    const names = new Set(r.attrs.map((a) => a.name));
    const attrs = [...r.attrs];
    for (const [name, ks] of loadedK) if (!names.has(name)) attrs.push({ name, kinds: [...ks] });
    attrs.sort((a, b) => cmp(a.name, b.name));
    if (!attrs.length) box.append(el('div', 'dim', 'no attributes'));

    for (const a of attrs) {
      const line = el('div', 'tattr');
      const kinds = a.kinds.length ? a.kinds : [...(loadedK.get(a.name) || [])];
      line.append(el('span', 'an', a.name));
      const k = el('span', 'ak', kinds.length ? kinds.join(', ') : '–');
      if (kinds.some((x) => x === 'Relationship' || x === 'ListRelationship')) {
        k.classList.add('rel');
        const to = [...new Set(this.typeRels.filter((x) => x.from === r.name && x.name === a.name).map((x) => typeLabel(x.to)))];
        if (to.length) k.textContent += ' → ' + to.join(', ');
      }
      line.append(k);
      const info = this.disc && this.disc.attributes.get(a.name);
      if (info && info.typeNames.length > 1) {
        const others = info.typeNames.filter((t) => t !== r.name).map(typeLabel);
        line.append(el('span', 'also', 'also in ' + others.join(', ')));
      }
      box.append(line);
    }
    return box;
  }

  renderRels() {
    const box = $('rels');
    box.textContent = '';
    if (!this.broker) return;
    if (!this.loaded.length) {
      box.append(el('p', 'dim', 'Which types a Relationship points to is known from the entities: load some types to see.'));
      return;
    }
    if (!this.typeRels.length) box.append(el('p', 'dim', 'No Relationship between the loaded entities.'));
    for (const r of this.typeRels) {
      const line = el('div', 'trel');
      const f = el('span', 'tf', typeLabel(r.from));
      f.style.color = typeColor(r.from);
      const t = el('span', 'tt', typeLabel(r.to));
      t.style.color = typeColor(r.to);
      line.append(f, el('span', 'tn', r.name + ' →'), t, el('span', 'n', String(r.n)));
      line.title = `${r.n} ${r.name} Relationship${r.n === 1 ? '' : 's'} from ${r.from} to ${r.to}`;
      box.append(line);
    }
    if (this.unresolved) box.append(el('p', 'dim', `${plural(this.unresolved, 'Relationship')} to entities not loaded - their types show once those are loaded.`));
  }

  //
  // follow - a Relationship's target: shown (its type switched on), selected, centred; a target that is
  // not loaded opens its neighbourhood
  //
  follow(id) {
    const e = this.byId.get(id);
    if (!e) { this.neighbourhood(id); return; }
    const types = typesOf(e);
    if (types.every((t) => this.hidden.has(t))) {
      const h = new Set(this.hidden);
      types.forEach((t) => h.delete(t));
      this.setHidden(h);
    }
    if (this.view === 'map') {
      this.graph.select(id);
      if (this.emap.has(id)) this.emap.centerOn(id);
      else this.toast(`${shortId(e)} has no location - not on the map`);
      return;
    }
    this.graph.select(id, { center: true });
    const n = this.graph.nodes.get(id);
    if (n) (n.xel || n.el).focus({ preventScroll: true });
  }

  //
  // menu - the context menu of an entity's box
  //
  menu(id, at, target) {
    const e = this.byId.get(id);
    if (!e) return;
    const types = typesOf(e);

    const follows = [];
    for (const [name, v] of attributes(e)) {
      for (const to of relationshipTargets(v)) {
        const here = this.byId.get(to);
        follows.push({
          label: `${name} → ${here ? shortId(here) : targetLabel(to)}`,
          hint: here ? '' : 'not loaded',
          action: () => this.follow(to),
        });
      }
    }

    const items = [];
    if (this.graph.expanded === id) items.push({ label: 'Close linked entities', action: () => this.collapse(id) });
    items.push({
      label: 'With linked entities',
      items: [1, 2, 3].map((l) => ({ label: `Level ${l}`, hint: l === 1 ? 'its targets' : `${l} Relationships deep`, action: () => this.expandLinked(id, l) })),
    });
    if (this.mode && this.mode.id === id) items.push({ label: 'Back to the picked types', action: () => this.back() });
    else items.push({ label: 'Neighbourhood', hint: 'one Relationship away', action: () => this.neighbourhood(id) });
    items.push({ label: 'Follow', items: follows });
    items.push({ separator: true });
    for (const t of types) items.push({ label: `Hide type ${typeLabel(t)}`, action: () => this.setHidden([...this.hidden, t]) });
    if (this.view === 'map') items.push({ label: 'Show in the graph', action: () => { this.setView('graph', true); this.graph.select(id, { center: true }); } });
    else if (geometries(e).length) items.push({ label: 'Show on the map', action: async () => { await this.setView('map', true); this.graph.select(id); this.emap.centerOn(id); } });
    items.push({ label: 'Copy id', action: () => this.copy(id, 'the id') });
    items.push({ label: 'Show JSON', action: () => this.showJson(id) });

    openMenu({ x: at.x, y: at.y, items, label: `${types.map(typeLabel).join(', ')} ${shortId(e)}`, returnFocus: target });
  }

  //
  // copy - text to the clipboard
  //
  async copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) { this.toast('Could not copy ' + what); return; }
    }
    this.toast('Copied ' + (what === 'the id' ? text : what));
  }

  //
  // showJson - the entity as the broker returned it, in a panel over the graph
  //
  showJson(id) {
    const e = this.byId.get(id);
    if (!e) return;
    this.jsonReturn = document.activeElement;
    $('json-title').textContent = `${typesOf(e).map(typeLabel).join(', ')} ${shortId(e)}`;
    $('json-pre').textContent = JSON.stringify(e, null, 2);
    $('jsonpanel').hidden = false;
    $('json-close').focus();
  }

  closeJson() {
    if ($('jsonpanel').hidden) return;
    $('jsonpanel').hidden = true;
    if (this.jsonReturn && document.contains(this.jsonReturn)) this.jsonReturn.focus({ preventScroll: true });
    this.jsonReturn = null;
  }

  //
  // expandLinked - the entity with its linked entities embedded (join=inline, joinLevel), as one box
  //
  async expandLinked(id, level) {
    if (this.view !== 'graph') this.setView('graph', true);         // the linked entities open in the graph
    const ticket = this.linkTicket = (this.linkTicket || 0) + 1;
    const e = this.byId.get(id);
    this.toast(`Asking for ${e ? shortId(e) : id} with its linked entities, level ${level}…`);
    let full;
    try {
      full = await entityGet(this.broker, id, `join=inline&joinLevel=${level}`);
    } catch (err) {
      if (ticket === this.linkTicket) this.toast(`The broker answered ${err.status || ''}: ${[err.title, err.detail].filter(Boolean).join(' - ')}`);
      return;
    }
    if (ticket !== this.linkTicket || !this.graph.nodes.has(id)) return;
    $('toast').hidden = true;

    const box = this.linkedCard(full, 0, level);
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `${typesOf(full).map(typeLabel).join(', ')} ${full.id} with its linked entities, level ${level}`);
    const head = box.querySelector('.lhead');
    head.append(el('span', 'lv', `linked · level ${level}`));
    const close = el('button', 'lclose', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close linked entities');
    close.onclick = () => this.collapse(id);
    head.append(close);
    this.graph.expand(id, box);
    this.graph.select(id);
    this.graph.reveal(id);
    box.focus({ preventScroll: true });
  }

  collapse(id) {
    this.graph.collapse();
    const n = this.graph.nodes.get(id);
    if (n) n.el.focus({ preventScroll: true });
  }

  //
  // linkedCard - an entity and, inside it, the entities its Relationships embed, level by level
  //
  linkedCard(e, depth, level) {
    const types = typesOf(e);
    const card = el('div', depth === 0 ? 'lcard root' : 'lcard');
    card.style.setProperty('--c', typeColor(types[0]));
    const head = el('div', 'lhead');
    const t = el('span', 't', types.map(typeLabel).join(', '));
    t.style.color = typeColor(types[0]);
    head.append(t, el('span', 'id', shortId(e)));
    head.title = e.id;
    card.append(head);

    const body = el('div', 'body');
    for (const a of boxAttrs(e, 3)) {
      const row = el('div', 'a');
      row.append(el('span', 'k', a.k), el('span', 'v', a.v));
      body.append(row);
    }
    for (const [name, v] of attributes(e)) {
      const kind = kindOf(v);
      if (kind !== 'Relationship' && kind !== 'ListRelationship') continue;
      const rel = el('div', 'lrel');
      const embedded = linked(v);
      rel.append(el('div', 'rn', name + ' →'));
      if (embedded.length) {
        for (const x of embedded) rel.append(this.linkedCard(x, depth + 1, level));
      } else {
        //
        // A Relationship of a card at depth d is at level d + 1: past joinLevel it is not embedded; within
        // it, the target was not there to embed
        //
        const why = depth + 1 > level ? `deeper than level ${level}` : 'not embedded by the broker';
        const ids = relationshipTargets(v).map(targetLabel).join(', ');
        const miss = el('div', 'miss');
        miss.append(el('span', 'mono', ids), el('span', 'why', ' ' + why));
        rel.append(miss);
      }
      body.append(rel);
    }
    card.append(body);
    return card;
  }

  //
  // neighbourhood - only this entity and the entities one Relationship away, out or in
  //
  // Out: its targets - the loaded ones, the others asked for by id. In: the loaded entities pointing at it,
  // and the broker's (q=<every Relationship name>=="<id>", from discovery), up to HOOD_IN_MAX.
  //
  async neighbourhood(id) {
    closeMenu(false);
    const ticket = ++this.loading;
    const url = this.broker;
    this.setState('busy', 'Loading');
    const card = this.progressCard('Neighbourhood', id, 'Asking for the entity…');

    try {
      const have = new Map();
      const center = this.loadedById.get(id) || this.byId.get(id) || await entityGet(url, id);
      if (ticket !== this.loading) return;
      have.set(center.id, center);

      const outIds = [...new Set(attributes(center).flatMap(([, v]) => relationshipTargets(v)))].filter((t) => t !== id).sort(cmp);
      const missing = [];
      for (const t of outIds) {
        const known = this.loadedById.get(t) || this.byId.get(t);
        if (known) have.set(t, known); else missing.push(t);
      }
      card.set(`${plural(outIds.length, 'target')}…`, 0.3);
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        const r = await entitiesQuery(url, 'id=' + typeParam(chunk), 50);
        for (const x of r.entities) have.set(x.id, x);
      }
      if (ticket !== this.loading) return;
      const outFound = outIds.filter((t) => have.has(t)).length;

      card.set('the entities pointing at it…', 0.6);
      const incoming = new Set();
      for (const x of [...this.loaded, ...this.entities]) {
        if (x.id === id) continue;
        if (attributes(x).some(([, v]) => relationshipTargets(v).includes(id))) { have.set(x.id, x); incoming.add(x.id); }
      }
      let inTotal = null;
      let inNote = '';
      const names = relationshipNames(this.disc);
      if (names.length) {
        //
        // One q per group of names, each URL kept short: q=a=="<id>"|b=="<id>"|...
        //
        const terms = names.map((n) => encodeURIComponent(`${n}==${JSON.stringify(id)}`));
        const groups = [];
        for (const t of terms) {
          const g = groups[groups.length - 1];
          if (g && g.join('%7C').length + t.length < 1500) g.push(t); else groups.push([t]);
        }
        try {
          inTotal = 0;
          for (const g of groups) {
            if (incoming.size >= HOOD_IN_MAX) break;
            const r = await entitiesQuery(url, 'q=' + g.join('%7C'), HOOD_IN_MAX);
            for (const x of r.entities) {
              if (x.id === id || incoming.size >= HOOD_IN_MAX) continue;
              if (!have.has(x.id)) have.set(x.id, x);
              incoming.add(x.id);
            }
            inTotal += r.total;
          }
        } catch (err) {
          const why = err.reached === false ? `c³ could not send it: ${err.detail || err.title}` : `the broker answered ${err.status}`;
          inNote = ` (the q query for the entities pointing at it failed - ${why}; only the loaded ones are shown)`;
        }
      } else if (this.disc === null) {
        inNote = ' (no discovery: only the loaded entities pointing at it)';
      }
      if (ticket !== this.loading) return;

      this.mode = { kind: 'hood', id };
      this.draw([...have.values()]);
      this.renderDiscovery();
      this.overlay(null);
      this.setState('ok', 'Connected');
      const types = typesOf(center).map(typeLabel).join(', ');
      const more = inTotal !== null && inTotal > HOOD_IN_MAX ? ` (the first ${HOOD_IN_MAX} of ${inTotal})` : '';
      $('mode-text').textContent = `Neighbourhood of ${types} ${shortId(center)} · ${outFound} out · ${incoming.size} in${more}${inNote}${missing.length && outFound < outIds.length ? ` · ${outIds.length - outFound} target${outIds.length - outFound === 1 ? '' : 's'} not found` : ''}`;
      $('modebar').hidden = false;
      $('counts').textContent = `${have.size} entities · ${plural(this.graph.edges.length, 'relationship')}`;
      this.graph.select(id);
      const n = this.graph.nodes.get(id);
      if (n) n.el.focus({ preventScroll: true });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.setState('ok', 'Connected');
      this.overlay(null);
      this.toast(`The broker answered ${err.status || ''}: ${[err.title, err.detail].filter(Boolean).join(' - ')}`);
    }
  }

  //
  // back - from a neighbourhood to the entities of the picked types
  //
  back() {
    if (!this.mode) return;
    const id = this.mode.id;
    this.mode = null;
    $('modebar').hidden = true;
    this.draw(this.loaded);
    this.renderDiscovery();
    const edges = this.graph.edges.length;
    $('counts').textContent = `${this.loaded.length} entities · ${plural(edges, 'relationship')}`;
    if (this.byId.has(id)) this.graph.select(id);
    if (!this.loaded.length) this.empty('Nothing loaded', 'Tick the types to see on the left and press Load.');
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
          b.onclick = () => this.follow(target);
          if (!this.byId.has(target)) {
            b.classList.add('missing');
            b.title = 'Not loaded - opens its neighbourhood';
          }
          row.append(b);
        }
      } else {
        row.append(el('span', 'v', valueText(v, 400)));
      }

      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (['type', 'value', 'object', 'objectList', 'languageMap', 'valueList', 'vocab', 'json', 'unitCode', 'entity', 'entityList'].includes(sk)) continue;
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
