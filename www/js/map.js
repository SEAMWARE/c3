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
// first Point, else the middle of the first line or the centre of the first area. Relationships "all":
// every one drawn; "selected": only the selected entity's.
//
// A Point of a kind icons.js knows (a bus, a stop, a streetlight, ...) is an icon, not a dot; its state
// (broken, on, an air quality level) colours it over its type's colour.
//
// Movement: a Point that a live change moves glides to its new place, over about the time between its
// changes, instead of jumping. The entities that moved lately are drawn from a source of their own
// (c3-mov), set again on every frame; the many that do not move stay in c3-ent, which is set again only
// when what it draws changed. Alarms (setAlarms) ring their entity in the severity's colour, pulsing
// until acknowledged.
//
// MapLibre and pmtiles are loaded when the map is first shown: the graph does not pay for them.
//
import { attributes, kindOf, relationshipTargets, typesOf, shortId, valueText } from './ngsild.js';
import { buildStyle, registerProtocols, setAreas, ATTRIBUTION, C, onlineState } from './basemap.js';
import { glyphOf, stateColor, imageName, parseImageName, drawImage } from './icons.js';

const ARROW = 'c3-arrow';
const LABEL_FONT = ['Noto Sans Medium'];
const NO_COLOR = '#5A616E';
const MOVER_KEEP = 20000;                        // ms: an entity that moved this lately is drawn from c3-mov
const PULSE_MS = 1400;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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

//
// posAt - where a glide is at 'now'
//
function posAt(m, now) {
  const t = Math.min(1, Math.max(0, (now - m.t0) / m.dur));
  return [m.from[0] + (m.to[0] - m.from[0]) * t, m.from[1] + (m.to[1] - m.from[1]) * t];
}

//
// sameFeatures - two lists of features that draw the same: the same geometry objects, the same properties
//
function sameFeatures(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].geometry !== b[i].geometry) return false;
    const pa = a[i].properties, pb = b[i].properties;
    for (const k in pb) if (pa[k] !== pb[k]) return false;
    for (const k in pa) if (!(k in pb)) return false;
  }
  return true;
}

const EMPTY = { type: 'FeatureCollection', features: [] };

export class EntityMap {
  constructor(els) {
    this.el = els.container;
    this.onSelect = () => {};                    // (id) - clicked
    this.onMenu = () => {};                      // (id, {x, y}, element)
    this.onBackMenu = () => {};                  // ([lon, lat], {x, y}) - right-clicked where there is no entity
    this.onPoint = null;                         // ([lon, lat]) - set: the next click is a point, not a selection
    this.labelZoom = 14.5;                       // entity labels from this zoom (setLabelZoom)
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
    this.relMode = 'all';                        // 'all' or 'selected' (setRelationships)
    this.lastPos = new Map();                    // id -> [lon, lat]: where its Point was last drawn to
    this.motion = new Map();                     // id -> {from, to, t0, dur}: a glide in progress
    this.movedAt = new Map();                    // id -> performance.now() of its last move
    this.movFeats = [];                          // the features of c3-mov
    this.alarms = [];                            // [{id, color, acked}]
    this.stats = { frames: 0, ms: 0, max: 0 };   // the glide's frames: how many, their JS time
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
        maxPitch: 85,
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
    for (const id of ['c3-ent', 'c3-mov', 'c3-rel', 'c3-arrow', 'c3-areas']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
    this.entKey = null;                          // the sources are empty again: set on the next render
    this.relKey = null;
    this.areaKey = null;

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
    //
    // The Points - of c3-ent and of c3-mov (the movers) alike: a dot, or an icon; selected; flashed; alarmed
    //
    const point = ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'anchor']]];
    const none = ['in', ['get', 'id'], ['literal', []]];
    for (const [src, x] of [['c3-ent', ''], ['c3-mov', '-m']]) {
      add({
        id: 'ent-point' + x, type: 'circle', source: src, filter: ['all', point, ['!', ['has', 'icon']]],
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 10, 4, 14, 6.5, 18, 10],
          'circle-stroke-color': '#0E1014', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 1.5],
        },
      });
      add({
        id: 'ent-icon' + x, type: 'symbol', source: src, filter: ['all', point, ['has', 'icon']],
        layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.32, 10, 0.5, 14, 0.85, 18, 1.15], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });
      add({
        id: 'sel-point' + x, type: 'circle', source: src, filter: ['all', point, isSel],
        paint: {
          'circle-color': ['case', ['has', 'icon'], 'rgba(0,0,0,0)', ['get', 'color']],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['has', 'icon'], 7, 6], 10, ['case', ['has', 'icon'], 9, 8], 14, ['case', ['has', 'icon'], 14, 10], 18, ['case', ['has', 'icon'], 18, 13]],
          'circle-stroke-color': '#F3B3CE', 'circle-stroke-width': 3,
        },
      });
      add({
        id: 'flash-point' + x, type: 'circle', source: src, filter: ['all', point, none],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 14, 13, 18, 18], 'circle-stroke-color': '#F2B84B', 'circle-stroke-width': 2.5, 'circle-stroke-opacity': 0.9 },
      });
      add({
        id: 'alarm-ring' + x, type: 'circle', source: src, filter: ['all', ['==', ['geometry-type'], 'Point'], none],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 7, 10, 9, 14, 14, 18, 19], 'circle-stroke-color': '#FF4D5E', 'circle-stroke-width': 3 },
      });
      add({
        id: 'alarm-pulse' + x, type: 'circle', source: src, filter: ['all', ['==', ['geometry-type'], 'Point'], none],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 14, 'circle-stroke-color': '#FF4D5E', 'circle-stroke-width': 2.5, 'circle-stroke-opacity': 0 },
      });
    }
    add({ id: 'flash-line', type: 'line', source: 'c3-ent', filter: ['all', ['!=', ['geometry-type'], 'Point'], none], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#F2B84B', 'line-width': width(4, 8), 'line-opacity': 0.55, 'line-blur': 2 } });
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
    for (const [src, x] of [['c3-ent', ''], ['c3-mov', '-m']]) {
      add({
        id: 'ent-label' + x, type: 'symbol', source: src, minzoom: this.labelZoom, filter: ['all', ['==', ['get', 'label'], 1], ['!', ['has', 'anchor']]],
        layout: { 'text-field': ['step', ['zoom'], ['get', 'short'], 16.5, ['get', 'name']], 'text-font': LABEL_FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 12], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#CDD2DB', 'text-halo-color': '#0E1014', 'text-halo-width': 1.4 },
      });
      add({
        id: 'sel-label' + x, type: 'symbol', source: src, filter: ['all', ['==', ['get', 'label'], 1], isSel],
        layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 13, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': '#F3B3CE', 'text-halo-color': '#0E1014', 'text-halo-width': 1.6 },
      });
    }
    this.render();
    this.applyAlarms();
  }

  //
  // set - the entities shown, their Relationships ({from, to, name}), the colour of each
  //
  //
  // 'live': a live change - a Point that moved glides there; otherwise (a load) everything is where it is
  //
  set(entities, edges, colorOf, { live = false } = {}) {
    this.entities = entities;
    this.edges = edges;
    this.colorOf = colorOf;
    this.render({ live });
  }

  //
  // setRelationships - 'all': every Relationship drawn; 'selected': the selected entity's only
  //
  setRelationships(mode) {
    this.relMode = mode === 'selected' ? 'selected' : 'all';
    this.renderRels();
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
  //
  // setLabelZoom - the zoom from which the entities have labels (as many as fit)
  //
  setLabelZoom(z) {
    this.labelZoom = z;
    for (const id of ['ent-label', 'ent-label-m']) if (this.map && this.map.getLayer(id)) this.map.setLayerZoomRange(id, z, 24);
  }

  //
  // setLabelAttr - the attribute whose value labels the entities on the map; null: their names
  //
  setLabelAttr(name) {
    this.labelAttr = name;
    this.render();
  }

  render({ live = false } = {}) {
    this.anchors = new Map();
    this.boxes = new Map();
    this.dots = [];                              // the Points drawn, for hit()
    this.notOnMap = [];
    const feats = [];
    const movFeats = [];
    const now = performance.now();
    const glide = live && !reducedMotion();
    const seen = new Set();
    for (const e of this.entities) {
      if (!this.visible(e)) continue;
      const geoms = geometries(e);
      if (!geoms.length) { this.notOnMap.push(e); continue; }
      const color = stateColor(e) || this.colorOf(e);
      const glyph = glyphOf(e);
      const icon = glyph ? imageName(glyph, color) : null;
      let short = shortId(e);
      let name = nameOf(e) || short;
      if (this.labelAttr && e[this.labelAttr] !== undefined) {      // the attribute picked in the Entity panel
        name = short = valueText(e[this.labelAttr], 40);
      }

      //
      // Its first Point: moved since it was last drawn? Then it glides, from where it is drawn now
      //
      const first = geoms.find((g) => g.geometry.type === 'Point');
      if (first) {
        const p = first.geometry.coordinates.slice(0, 2);
        const prev = this.lastPos.get(e.id);
        seen.add(e.id);
        if (prev && (prev[0] !== p[0] || prev[1] !== p[1])) {
          const m = this.motion.get(e.id);
          if (glide) {
            const last = this.movedAt.get(e.id);
            const period = last ? Math.min(Math.max(now - last, 200), 5000) : 1000;
            this.motion.set(e.id, { from: m ? posAt(m, now) : prev, to: p, t0: now, dur: period });
          } else this.motion.delete(e.id);
          this.movedAt.set(e.id, now);
        }
        this.lastPos.set(e.id, p);
      }
      const mover = this.movedAt.has(e.id) && now - this.movedAt.get(e.id) < MOVER_KEEP;

      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const g of geoms) {
        extendGeometry(box, g.geometry);
        if (g.geometry.type === 'Point') this.dots.push({ id: e.id, at: g.geometry.coordinates });
        const props = { id: e.id, attr: g.attr, color, short, name, label: g.geometry.type === 'Point' ? 1 : 0 };
        if (icon && g.geometry.type === 'Point') props.icon = icon;
        const f = { type: 'Feature', geometry: g.geometry, properties: props };
        if (mover && g === first) {
          props.mv = 1;
          const m = this.motion.get(e.id);
          if (m) f.geometry = { type: 'Point', coordinates: posAt(m, now) };
          movFeats.push(f);
        } else feats.push(f);
      }
      const anchor = anchorOf(geoms);
      this.anchors.set(e.id, anchor);
      this.boxes.set(e.id, box);
      if (!geoms.some((g) => g.geometry.type === 'Point')) {
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: anchor }, properties: { id: e.id, color, short, name, label: 1, anchor: 1 } });
      }
    }
    for (const id of this.lastPos.keys()) if (!seen.has(id)) { this.lastPos.delete(id); this.motion.delete(id); this.movedAt.delete(id); }
    this.movFeats = movFeats;

    const map = this.map;
    if (!map || !map.getSource('c3-ent')) return;

    //
    // The icons drawn - each (glyph, colour) once, before a feature asks for it
    //
    for (const f of feats.concat(movFeats)) {
      const name = f.properties.icon;
      if (name && !map.hasImage(name)) {
        const want = parseImageName(name);
        map.addImage(name, drawImage(want.glyph, want.color), { pixelRatio: 2 });
      }
    }

    //
    // c3-ent only when what it draws changed: the same geometry objects (a changed attribute is a new
    // object) and the same properties
    //
    if (!this.entKey || !sameFeatures(this.entKey, feats)) {
      map.getSource('c3-ent').setData({ type: 'FeatureCollection', features: feats });
      this.entKey = feats;
    }
    map.getSource('c3-mov').setData({ type: 'FeatureCollection', features: movFeats });
    this.renderRels();
    const areaKey = JSON.stringify(this.areas.map((a) => [a.id, a.bbox]));
    if (areaKey !== this.areaKey) {
      this.areaKey = areaKey;
      map.getSource('c3-areas').setData({
        type: 'FeatureCollection',
        features: this.areas.map((a) => {
          const [w, s, e, n] = a.bbox;
          return { type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] }, properties: { id: a.id } };
        }),
      });
    }
    this.applySelection();
    this.applyFlash();
    if (this.motion.size) this.animate();
  }

  //
  // renderRels - the Relationships' lines and arrows, from the anchors (a gliding entity's from where it
  // is drawn now); "selected": only the selected entity's
  //
  renderRels(now = performance.now()) {
    const rels = [];
    const arrows = [];
    const at = (id) => {
      const m = this.motion.get(id);
      return m ? posAt(m, now) : this.anchors.get(id);
    };
    for (const ed of this.edges) {
      if (this.relMode === 'selected' && ed.from !== this.sel && ed.to !== this.sel) continue;
      const a = at(ed.from), b = at(ed.to);
      if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
      rels.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: { from: ed.from, to: ed.to, name: ed.name } });
      arrows.push({ type: 'Feature', geometry: { type: 'Point', coordinates: b }, properties: { from: ed.from, to: ed.to, bearing: bearing(a, b) } });
    }
    this.relCount = rels.length;
    const map = this.map;
    if (!map || !map.getSource('c3-rel')) return;
    const key = rels.map((r) => r.geometry.coordinates.join(',') + r.properties.name).join('|');
    if (key === this.relKey) return;
    this.relKey = key;
    map.getSource('c3-rel').setData({ type: 'FeatureCollection', features: rels });
    map.getSource('c3-arrow').setData({ type: 'FeatureCollection', features: arrows });
  }

  //
  // animate - the glides and the alarms' pulse, one frame at a time while there is any
  //
  animate() {
    if (this.raf || !this.map) return;
    this.raf = requestAnimationFrame(() => this.frame());
  }

  frame() {
    this.raf = null;
    const map = this.map;
    if (!map || !map.getSource('c3-mov')) return;
    const t0 = performance.now();
    const now = t0;

    if (this.motion.size) {
      for (const f of this.movFeats) {
        const m = this.motion.get(f.properties.id);
        if (m) f.geometry = { type: 'Point', coordinates: posAt(m, now) };
      }
      let selMoves = false;
      for (const [id, m] of this.motion) {
        if (id === this.sel) selMoves = true;
        if (now - m.t0 >= m.dur) this.motion.delete(id);
      }
      map.getSource('c3-mov').setData({ type: 'FeatureCollection', features: this.movFeats });
      //
      // The lines of the gliding entities follow them: the selected one's every frame, all of them ten times
      // a second (there may be hundreds), and once more on arrival
      //
      if (this.relMode === 'selected') { if (selMoves) this.renderRels(now); }
      else if (!this.motion.size || now - (this.relAt || 0) >= 100) { this.relAt = now; this.renderRels(now); }
    }

    const pulsing = this.alarms.some((a) => !a.acked) && !reducedMotion();
    if (pulsing) {
      const ph = (now % PULSE_MS) / PULSE_MS;
      const z = map.getZoom();
      const base = z <= 10 ? 9 : z >= 18 ? 19 : 9 + ((z - 10) * 10) / 8;
      for (const x of ['', '-m']) {
        map.setPaintProperty('alarm-pulse' + x, 'circle-radius', base * (1 + ph * 1.3));
        map.setPaintProperty('alarm-pulse' + x, 'circle-stroke-opacity', 0.9 * (1 - ph));
      }
    }

    const ms = performance.now() - t0;
    this.stats.frames += 1;
    this.stats.ms += ms;
    this.stats.max = Math.max(this.stats.max, ms);
    if (this.motion.size || pulsing) this.animate();
  }

  //
  // setAlarms - the entities with an alarm: [{id, color, acked}] - ringed in the colour, pulsing until acknowledged
  //
  setAlarms(alarms) {
    this.alarms = alarms;
    this.applyAlarms();
  }

  applyAlarms() {
    const map = this.map;
    if (!map || !map.getLayer('alarm-ring')) return;
    const ids = this.alarms.map((a) => a.id);
    const live = this.alarms.filter((a) => !a.acked).map((a) => a.id);
    const color = (list) => {
      if (!list.length) return '#FF4D5E';
      const m = ['match', ['get', 'id']];
      const done = new Set();
      for (const a of list) if (!done.has(a.id)) { done.add(a.id); m.push(a.id, a.color); }
      m.push('#FF4D5E');
      return m;
    };
    for (const x of ['', '-m']) {
      map.setFilter('alarm-ring' + x, ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'id'], ['literal', ids]]]);
      map.setFilter('alarm-pulse' + x, ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'id'], ['literal', live]]]);
      map.setPaintProperty('alarm-ring' + x, 'circle-stroke-color', color(this.alarms));
      map.setPaintProperty('alarm-ring' + x, 'circle-stroke-opacity', ['case', ['in', ['get', 'id'], ['literal', live]], 1, 0.45]);
      map.setPaintProperty('alarm-pulse' + x, 'circle-stroke-color', color(this.alarms.filter((a) => !a.acked)));
      if (!live.length) map.setPaintProperty('alarm-pulse' + x, 'circle-stroke-opacity', 0);
    }
    if (live.length) this.animate();
  }

  //
  // flash - the entities that changed (live values) ringed for a moment
  //
  flash(ids) {
    this.flashIds = ids;
    this.applyFlash();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashIds = []; this.applyFlash(); }, 900);
  }

  applyFlash() {
    const map = this.map;
    if (!map || !map.getLayer('flash-point')) return;
    const f = ['in', ['get', 'id'], ['literal', this.flashIds || []]];
    for (const x of ['', '-m']) map.setFilter('flash-point' + x, ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'anchor']], f]);
    map.setFilter('flash-line', ['all', ['!=', ['geometry-type'], 'Point'], f]);
  }

  //
  // select - the entity drawn selected, its Relationships hot
  //
  select(id, { center = false } = {}) {
    this.sel = id || null;
    this.applySelection();
    if (this.relMode === 'selected') this.renderRels();
    if (center && this.sel && this.map) this.centerOn(this.sel);
  }

  applySelection() {
    const map = this.map;
    if (!map || !map.getLayer('sel-point')) return;
    const id = this.sel || '';
    const isSel = ['==', ['get', 'id'], id];
    for (const x of ['', '-m']) {
      map.setFilter('sel-point' + x, ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'anchor']], isSel]);
      map.setFilter('sel-label' + x, ['all', ['==', ['get', 'label'], 1], ['!', ['has', 'anchor']], isSel]);
    }
    map.setFilter('sel-fill', ['all', ['==', ['geometry-type'], 'Polygon'], isSel]);
    map.setFilter('sel-line', ['all', ['==', ['geometry-type'], 'LineString'], isSel]);
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
    //
    // A dot first: the nearest one within its radius and 4 px more, found on the screen - not the label
    //
    const z = this.map.getZoom();
    const r = (z <= 3 ? 2.5 : z <= 10 ? 2.5 + (z - 3) * 1.5 / 7 : z <= 14 ? 4 + (z - 10) * 2.5 / 4 : z <= 18 ? 6.5 + (z - 14) * 3.5 / 4 : 10) + 4;
    let best = null;
    let bestD = r * r;
    for (const d of this.dots || []) {
      const p = this.map.project(d.at);
      const dd = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (dd <= bestD) { bestD = dd; best = d.id; }
    }
    if (best) return best;

    const layers = ['area-label', 'ent-line', 'ent-fill'].filter((l) => this.map.getLayer(l));
    const box = [[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]];
    const f = this.map.queryRenderedFeatures(box, { layers });
    if (!f.length) return null;
    const rank = { 'sel-point': 0, 'ent-point': 0, 'ent-label': 1, 'area-label': 2, 'ent-line': 2, 'ent-fill': 3 };
    f.sort((a, b) => rank[a.layer.id] - rank[b.layer.id]);
    return f[0].properties.id;
  }

  wireInput() {
    const map = this.map;
    map.on('click', (e) => {
      if (this.onPoint) {
        const done = this.onPoint;
        this.onPoint = null;
        done([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]);
        return;
      }
      this.onSelect(this.hit(e.point));
    });
    map.on('contextmenu', (e) => {
      const id = this.hit(e.point);
      if (!id) {
        e.originalEvent.preventDefault();
        this.onBackMenu([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)], { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
        return;
      }
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
