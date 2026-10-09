//
// map.js - Connect's map: the entities that have a GeoProperty, where it puts them, on MapLibre GL JS
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A Point is a marker, a LineString a line, a Polygon an area (and their Multi- forms), coloured by the
// entity's type - or by the target of a Relationship ("colour by"). A Relationship between two entities
// on the map is a line with an arrow at its target; the selected entity's are drawn hot, as in the graph.
// Every GeoProperty of an entity is drawn (location first); its Relationships start from its anchor: the
// first Point, else the middle of the first line or the centre of the first area.
//
// MapLibre and pmtiles are loaded when the map is first shown: the graph does not pay for them.
//
import { attributes, kindOf, relationshipTargets, typesOf, shortId } from './ngsild.js';
import { buildStyle, registerProtocols, setAreas, ATTRIBUTION, C, onlineState } from './basemap.js';

const ARROW = 'c3-arrow';
const LABEL_FONT = ['Noto Sans Medium'];
const NO_COLOR = '#5A616E';

let maplibrePromise = null;
function loadMaplibre() {
  if (!maplibrePromise) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/maplibre-gl/maplibre-gl.css';
    document.head.append(css);
    maplibrePromise = import('../vendor/maplibre-gl/maplibre-gl.mjs').then((m) => m.default || m);
  }
  return maplibrePromise;
}

//
// isPosition / geometryOk - GeoJSON as NGSI-LD's GeoProperty carries it
//
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

function geometryOk(g) {
  if (!g || typeof g !== 'object') return false;
  const c = g.coordinates;
  switch (g.type) {
    case 'Point': return isPosition(c);
    case 'MultiPoint':
    case 'LineString': return Array.isArray(c) && c.length > 0 && c.every(isPosition);
    case 'MultiLineString':
    case 'Polygon': return Array.isArray(c) && c.length > 0 && c.every((r) => Array.isArray(r) && r.length > 0 && r.every(isPosition));
    case 'MultiPolygon': return Array.isArray(c) && c.length > 0 && c.every((p) => Array.isArray(p) && p.every((r) => Array.isArray(r) && r.every(isPosition)));
    default: return false;
  }
}

//
// geometries - an entity's GeoProperties: [{ attr, geometry }], location first
//
export function geometries(e) {
  const out = [];
  for (const [name, v] of attributes(e)) {
    if (kindOf(v) !== 'GeoProperty' || !v || typeof v !== 'object') continue;
    let g = v.value;
    if (typeof g === 'string') { try { g = JSON.parse(g); } catch { continue; } }
    if (geometryOk(g)) out.push({ attr: name, geometry: g });
  }
  out.sort((a, b) => (a.attr === 'location' ? -1 : b.attr === 'location' ? 1 : 0));
  return out;
}

//
// anchorOf - where an entity's Relationships start and end
//
function centroid(ring) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    x += (ring[j][0] + ring[i][0]) * f;
    y += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [x / (3 * a), y / (3 * a)];
}

function anchorOf(geoms) {
  const point = geoms.find((g) => g.geometry.type === 'Point');
  if (point) return point.geometry.coordinates.slice(0, 2);
  const g = geoms[0].geometry;
  const c = g.coordinates;
  if (g.type === 'MultiPoint') return c[0].slice(0, 2);
  if (g.type === 'LineString') return c[Math.floor(c.length / 2)].slice(0, 2);
  if (g.type === 'MultiLineString') return c[0][Math.floor(c[0].length / 2)].slice(0, 2);
  if (g.type === 'Polygon') return centroid(c[0]);
  return centroid(c[0][0]);
}

//
// bearing - the direction from a to b on the Mercator map, degrees clockwise from north
//
function bearing(a, b) {
  const y = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const dx = ((b[0] - a[0]) * Math.PI) / 180;
  const dy = y(b[1]) - y(a[1]);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function extend(b, p) {
  b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]);
  b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
}

function extendGeometry(b, g) {
  const walk = (c) => (typeof c[0] === 'number' ? extend(b, c) : c.forEach(walk));
  walk(g.coordinates);
}

//
// nameOf - an entity's "name" Property, if it is text
//
export function nameOf(e) {
  const v = e.name;
  const x = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

const EMPTY = { type: 'FeatureCollection', features: [] };

export class EntityMap {
  constructor(els) {
    this.el = els.container;
    this.onSelect = () => {};                    // (id) - clicked
    this.onMenu = () => {};                      // (id, {x, y}, element)
    this.onView = () => {};                      // ({center, zoom, bearing, pitch}) - moved by the user
    this.onOnline = () => {};                    // (ok) - online tiles reached or not
    this.map = null;
    this.ready = null;
    this.entities = [];
    this.edges = [];
    this.hidden = new Set();
    this.colorOf = () => NO_COLOR;
    this.sel = null;
    this.areas = [];
    this.fonts = false;
    this.anchors = new Map();
    this.boxes = new Map();                      // id -> [w, s, e, n]
    this.notOnMap = [];
  }

  //
  // open - the map, created on the first call; resolves when its style is loaded
  //
  open(view) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const maplibregl = await loadMaplibre();
      await registerProtocols(maplibregl);
      this.maplibregl = maplibregl;
      setAreas(this.areas, this.fonts);
      const map = new maplibregl.Map({
        container: this.el,
        style: buildStyle(this.areas),
        center: view ? view.center : [0, 20],
        zoom: view ? view.zoom : 1.5,
        bearing: view ? view.bearing || 0 : 0,
        pitch: view ? view.pitch || 0 : 0,
        attributionControl: false,
        dragRotate: true,
        maxPitch: 60,
        fadeDuration: 0,
      });
      this.map = map;
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: ATTRIBUTION }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
      map.on('error', (e) => {
        // Tiles and glyphs that cannot be reached (offline) are reported by the protocols; nothing to log
        if (e && e.error && /Failed to fetch|NetworkError|OpenFreeMap|glyphs|AbortError/.test(String(e.error.message || e.error))) return;
        console.warn('c3 map:', e && e.error ? e.error.message || e.error : e);
      });
      onlineState.listeners.add((ok) => this.onOnline(ok));
      map.on('moveend', (e) => { if (e.originalEvent || this.userMoved) this.onView(this.view()); this.userMoved = false; });
      map.on('dragstart', () => { this.userMoved = true; });
      map.on('zoomstart', (e) => { if (e.originalEvent) this.userMoved = true; });
      this.wireInput();
      await new Promise((done) => (map.loaded() ? done() : map.once('load', done)));
      this.addEntityLayers();
      return map;
    })();
    return this.ready;
  }

  view() {
    const m = this.map;
    const c = m.getCenter();
    const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
    return { center: [r(c.lng, 6), r(c.lat, 6)], zoom: r(m.getZoom(), 2), bearing: r(m.getBearing(), 1), pitch: r(m.getPitch(), 1) };
  }

  resize() {
    if (this.map) this.map.resize();
  }

  //
  // setAreas - the downloaded areas changed: the base style rebuilt, the entities kept
  //
  setAreas(areas, fonts) {
    const changed = JSON.stringify(areas.map((a) => [a.id, a.bbox, a.maxzoom])) !== JSON.stringify(this.areas.map((a) => [a.id, a.bbox, a.maxzoom])) || fonts !== this.fonts;
    this.areas = areas;
    this.fonts = fonts;
    setAreas(areas, fonts);
    if (!this.map || !changed) return;
    this.map.setStyle(buildStyle(areas), { diff: false });
    this.map.once('style.load', () => this.addEntityLayers());
  }

  //
  // addEntityLayers - the entities' sources and layers, on top of the base style
  //
  addEntityLayers() {
    const map = this.map;
    //
    // The arrowheads: a triangle pointing up (north), rotated to the Relationship's bearing; grey, and
    // magenta for the selected entity's
    //
    for (const [name, color] of [[ARROW, '#8A93A3'], [ARROW + '-hot', '#D0558A']]) {
      if (map.hasImage(name)) continue;
      const s = 28;
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.strokeStyle = '#0E1014';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(s / 2, 2); g.lineTo(s - 4, s - 3); g.lineTo(s / 2, s - 8); g.lineTo(4, s - 3);
      g.closePath(); g.fill(); g.stroke();
      map.addImage(name, g.getImageData(0, 0, s, s), { pixelRatio: 2 });
    }
    for (const id of ['c3-ent', 'c3-rel', 'c3-arrow', 'c3-areas']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });

    const isSel = ['==', ['get', 'id'], ['literal', '']];
    const relHot = ['any', ['==', ['get', 'from'], ''], ['==', ['get', 'to'], '']];
    const width = (a, b) => ['interpolate', ['linear'], ['zoom'], 8, a, 16, b];
    const add = (l) => { if (!map.getLayer(l.id)) map.addLayer(l); };

    add({ id: 'c3-areas', type: 'line', source: 'c3-areas', paint: { 'line-color': '#A72E60', 'line-width': 1, 'line-dasharray': [4, 3], 'line-opacity': 0.55 } });
    add({ id: 'ent-fill', type: 'fill', source: 'c3-ent', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
    add({ id: 'ent-outline', type: 'line', source: 'c3-ent', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.85 } });
    add({ id: 'ent-line', type: 'line', source: 'c3-ent', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': width(2, 5) } });
    add({ id: 'rel-line', type: 'line', source: 'c3-rel', paint: { 'line-color': C.boundary, 'line-width': width(0.6, 1.4), 'line-opacity': 0.55 } });
    add({ id: 'rel-arrow', type: 'symbol', source: 'c3-arrow', minzoom: 15, layout: { 'icon-image': ARROW, 'icon-size': 0.8, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-offset': [0, 15] }, paint: { 'icon-opacity': 0.7 } });
    add({ id: 'sel-fill', type: 'line', source: 'c3-ent', filter: ['all', ['==', ['geometry-type'], 'Polygon'], isSel], paint: { 'line-color': '#E58AB1', 'line-width': 3 } });
    add({ id: 'sel-line', type: 'line', source: 'c3-ent', filter: ['all', ['==', ['geometry-type'], 'LineString'], isSel], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#E58AB1', 'line-width': width(5, 9), 'line-opacity': 0.5 } });
    add({ id: 'rel-hot', type: 'line', source: 'c3-rel', filter: relHot, layout: { 'line-cap': 'round' }, paint: { 'line-color': '#D0558A', 'line-width': width(2, 3.5) } });
    add({ id: 'rel-arrow-hot', type: 'symbol', source: 'c3-arrow', filter: relHot, layout: { 'icon-image': ARROW + '-hot', 'icon-size': 1.3, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-offset': [0, 11] } });
    add({
      id: 'ent-point', type: 'circle', source: 'c3-ent', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'anchor']]],
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 10, 4, 14, 6.5, 18, 10],
        'circle-stroke-color': '#0E1014', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 1.5],
      },
    });
    add({
      id: 'sel-point', type: 'circle', source: 'c3-ent', filter: ['all', ['==', ['geometry-type'], 'Point'], isSel],
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, 14, 10, 18, 13], 'circle-stroke-color': '#F3B3CE', 'circle-stroke-width': 3 },
    });
    add({
      id: 'rel-label', type: 'symbol', source: 'c3-rel', filter: relHot,
      layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#F3B3CE', 'text-halo-color': '#0E1014', 'text-halo-width': 1.6 },
    });
    add({
      // the anchor of an area or a line carries its name - no marker
      id: 'area-label', type: 'symbol', source: 'c3-ent', minzoom: 9, filter: ['has', 'anchor'],
      layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 15, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.06 },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0E1014', 'text-halo-width': 1.6 },
    });
    add({
      id: 'ent-label', type: 'symbol', source: 'c3-ent', minzoom: 14.5, filter: ['all', ['==', ['get', 'label'], 1], ['!', ['has', 'anchor']]],
      layout: { 'text-field': ['step', ['zoom'], ['get', 'short'], 16.5, ['get', 'name']], 'text-font': LABEL_FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#CDD2DB', 'text-halo-color': '#0E1014', 'text-halo-width': 1.4 },
    });
    add({
      id: 'sel-label', type: 'symbol', source: 'c3-ent', filter: ['all', ['==', ['get', 'label'], 1], isSel],
      layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 13, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': '#F3B3CE', 'text-halo-color': '#0E1014', 'text-halo-width': 1.6 },
    });
    this.render();
  }

  //
  // set - the entities shown, their Relationships ({from, to, name}), the colour of each
  //
  set(entities, edges, colorOf) {
    this.entities = entities;
    this.edges = edges;
    this.colorOf = colorOf;
    this.render();
  }

  setColors(colorOf) {
    this.colorOf = colorOf;
    this.render();
  }

  setHidden(types) {
    this.hidden = new Set(types);
    this.render();
  }

  visible(e) {
    return !typesOf(e).every((t) => this.hidden.has(t));
  }

  //
  // render - the GeoJSON of the entities, the Relationships and the arrows
  //
  render() {
    this.anchors = new Map();
    this.boxes = new Map();
    this.notOnMap = [];
    const feats = [];
    for (const e of this.entities) {
      if (!this.visible(e)) continue;
      const geoms = geometries(e);
      if (!geoms.length) { this.notOnMap.push(e); continue; }
      const color = this.colorOf(e);
      const short = shortId(e);
      const name = nameOf(e) || short;
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const g of geoms) {
        extendGeometry(box, g.geometry);
        feats.push({ type: 'Feature', geometry: g.geometry, properties: { id: e.id, attr: g.attr, color, short, name, label: g.geometry.type === 'Point' ? 1 : 0 } });
      }
      const anchor = anchorOf(geoms);
      this.anchors.set(e.id, anchor);
      this.boxes.set(e.id, box);
      if (!geoms.some((g) => g.geometry.type === 'Point')) {
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: anchor }, properties: { id: e.id, color, short, name, label: 1, anchor: 1 } });
      }
    }

    const rels = [];
    const arrows = [];
    for (const ed of this.edges) {
      const a = this.anchors.get(ed.from), b = this.anchors.get(ed.to);
      if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
      rels.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { from: ed.from, to: ed.to, name: ed.name } });
      arrows.push({ type: 'Feature', geometry: { type: 'Point', coordinates: b }, properties: { from: ed.from, to: ed.to, bearing: bearing(a, b) } });
    }
    this.relCount = rels.length;

    const map = this.map;
    if (!map || !map.getSource('c3-ent')) return;
    map.getSource('c3-ent').setData({ type: 'FeatureCollection', features: feats });
    map.getSource('c3-rel').setData({ type: 'FeatureCollection', features: rels });
    map.getSource('c3-arrow').setData({ type: 'FeatureCollection', features: arrows });
    map.getSource('c3-areas').setData({
      type: 'FeatureCollection',
      features: this.areas.map((a) => {
        const [w, s, e, n] = a.bbox;
        return { type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] }, properties: { id: a.id } };
      }),
    });
    this.applySelection();
  }

  //
  // select - the entity drawn selected, its Relationships hot
  //
  select(id, { center = false } = {}) {
    this.sel = id || null;
    this.applySelection();
    if (center && this.sel && this.map) this.centerOn(this.sel);
  }

  applySelection() {
    const map = this.map;
    if (!map || !map.getLayer('sel-point')) return;
    const id = this.sel || '';
    const isSel = ['==', ['get', 'id'], id];
    map.setFilter('sel-point', ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'anchor']], isSel]);
    map.setFilter('sel-fill', ['all', ['==', ['geometry-type'], 'Polygon'], isSel]);
    map.setFilter('sel-line', ['all', ['==', ['geometry-type'], 'LineString'], isSel]);
    map.setFilter('sel-label', ['all', ['==', ['get', 'label'], 1], ['!', ['has', 'anchor']], isSel]);
    const hot = ['any', ['==', ['get', 'from'], id], ['==', ['get', 'to'], id]];
    map.setFilter('rel-hot', hot);
    map.setFilter('rel-arrow-hot', hot);
    map.setFilter('rel-label', hot);
  }

  has(id) {
    return this.anchors.has(id);
  }

  centerOn(id) {
    const box = this.boxes.get(id);
    if (!box) return;
    if (box[0] === box[2] && box[1] === box[3]) this.map.easeTo({ center: [box[0], box[1]], zoom: Math.max(this.map.getZoom(), 15), duration: 400 });
    else this.map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 80, maxZoom: 17, duration: 400 });
  }

  //
  // fit - every entity shown on the map in view
  //
  fit(animate = true) {
    if (!this.map) return;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const box of this.boxes.values()) { extend(b, [box[0], box[1]]); extend(b, [box[2], box[3]]); }
    if (!Number.isFinite(b[0])) return;
    if (b[0] === b[2] && b[1] === b[3]) this.map.jumpTo({ center: [b[0], b[1]], zoom: 15 });
    else this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 56, maxZoom: 17, duration: animate ? 500 : 0 });
  }

  fitArea(area) {
    const [w, s, e, n] = area.bbox;
    this.map.fitBounds([[w, s], [e, n]], { padding: 32, duration: 500 });
  }

  bounds() {
    const b = this.map.getBounds();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -85.05, 85.05), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -85.05, 85.05)];
  }

  zoomBy(d) {
    if (this.map) this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 200 });
  }

  //
  // Input - a click selects (a point before a line before an area), a right-click opens the menu
  //
  hit(point) {
    const layers = ['sel-point', 'ent-point', 'ent-label', 'area-label', 'ent-line', 'ent-fill'].filter((l) => this.map.getLayer(l));
    const box = [[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]];
    const f = this.map.queryRenderedFeatures(box, { layers });
    if (!f.length) return null;
    const rank = { 'sel-point': 0, 'ent-point': 0, 'ent-label': 1, 'area-label': 2, 'ent-line': 2, 'ent-fill': 3 };
    f.sort((a, b) => rank[a.layer.id] - rank[b.layer.id]);
    return f[0].properties.id;
  }

  wireInput() {
    const map = this.map;
    map.on('click', (e) => this.onSelect(this.hit(e.point)));
    map.on('contextmenu', (e) => {
      const id = this.hit(e.point);
      if (!id) return;
      e.originalEvent.preventDefault();
      this.onSelect(id);
      this.onMenu(id, { x: e.originalEvent.clientX, y: e.originalEvent.clientY }, map.getCanvas());
    });
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = this.hit(e.point) ? 'pointer' : ''; });
    map.getCanvas().addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        if (!this.sel || !this.anchors.has(this.sel)) return;
        e.preventDefault();
        const p = map.project(this.anchors.get(this.sel));
        const r = map.getCanvas().getBoundingClientRect();
        this.onMenu(this.sel, { x: r.left + p.x, y: r.top + p.y }, map.getCanvas());
      } else if (e.key === 'Escape') this.onSelect(null);
      else if (e.key === '0') { e.preventDefault(); this.fit(); }
    });
  }
}
