//
// main.js - NGSI-LD map: the entities on c³'s map, by their location
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The base map is c³'s own (js/basemap.js and maplibre, packed into this widget by c³ - c3-include): online
// OpenFreeMap tiles, and the areas downloaded in c³ read from c³ (GET /api/run/dashboard/maps, the .pmtiles by
// Range, the fonts). On it, the entities of the input "entities" by their GeoProperty - points, lines,
// polygons - labelled with their id (and an attribute's value). An entity clicked is sent on "selected", as
// a table's row is; the view fits the entities whenever they are other entities.
//
/* globals MashupPlatform, C3 */
import { buildStyle, registerProtocols, setAreas, setApiBase, ATTRIBUTION } from './basemap.js';

const t = C3.t;
const PINK = '#e0457b';
const LABEL_FONT = ['Noto Sans Medium'];

let map = null;
let entities = null;
let from = {};
let selected = null;
let shownIds = '';

const pref = C3.pref;

function note(text) {
  const n = document.getElementById('note');
  n.hidden = !text;
  n.textContent = text || '';
}

//
// geometryOf - an entity's GeoProperty, as GeoJSON: the one named, else location, else the first there is
//
function geometryOf(e) {
  const isGeo = (g) => g && typeof g === 'object' && typeof g.type === 'string' && Array.isArray(g.coordinates);
  const names = pref('geo') ? [pref('geo')] : ['location'].concat(Object.keys(e).filter((k) => {
    const a = Array.isArray(e[k]) ? e[k][0] : e[k];
    return a && a.type === 'GeoProperty';
  }));
  for (const n of names) {
    const v = C3.value(e, n);
    if (v && isGeo(v.value)) return v.value;
  }
  return null;
}

function shortId(id) {
  const m = /^urn:ngsi-ld:[^:]+:(.+)$/.exec(id);
  return m ? m[1] : id;
}

function features() {
  const attr = pref('attribute');
  return (entities || []).map((e) => {
    const g = geometryOf(e);
    if (!g) return null;
    const v = attr ? C3.value(e, attr) : null;
    const label = shortId(e.id) + (v ? '\n' + C3.show(v.value, 1) + (v.unitCode ? ' ' + v.unitCode : '') : '');
    //
    // The geometry copied into this frame: the wiring hands over WireCloud's own objects (another window), and
    // maplibre's worker transfer refuses an object whose class is not this window's Object
    //
    return { type: 'Feature', geometry: JSON.parse(JSON.stringify(g)), properties: { id: e.id, label, sel: e.id === selected } };
  }).filter(Boolean);
}

//
// fit - the view around the entities (a single point: zoom 15)
//
function fit(fs) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  fs.forEach((f) => walk(f.geometry.coordinates));
  if (w > e) return;
  if (w === e && s === n) map.jumpTo({ center: [w, s], zoom: 15 });
  else map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 16, duration: 0 });
}

function show() {
  if (!map || !map.getSource('ents')) return;
  const fs = features();
  map.getSource('ents').setData({ type: 'FeatureCollection', features: fs });
  if (!entities) note(t('Waiting for entities - wire an NGSI-LD source to this widget'));
  else if (!fs.length) note(t('No entity has a location'));
  else note(null);

  const now = fs.map((f) => f.properties.id).join(',');
  if (fs.length && now !== shownIds) fit(fs);
  shownIds = now;
}

function entityLayers() {
  map.addSource('ents', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ents-fill', type: 'fill', source: 'ents', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': PINK, 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'ents-line', type: 'line', source: 'ents', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': PINK, 'line-width': ['case', ['get', 'sel'], 3.5, 2] } });
  map.addLayer({
    id: 'ents-point', type: 'circle', source: 'ents', filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['case', ['get', 'sel'], 9, 6], 'circle-color': PINK,
      'circle-stroke-color': ['case', ['get', 'sel'], '#ffffff', '#2a1520'], 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'ents-label', type: 'symbol', source: 'ents',
    layout: { 'text-field': ['get', 'label'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': false },
    paint: { 'text-color': '#E8EBF0', 'text-halo-color': '#0E1014', 'text-halo-width': 1.4 },
  });

  for (const layer of ['ents-point', 'ents-line', 'ents-fill']) {
    map.on('click', layer, (ev) => {
      const id = ev.features[0].properties.id;
      const e = (entities || []).find((x) => x.id === id);
      if (!e) return;
      selected = id;
      MashupPlatform.wiring.pushEvent('selected', C3.withEntities(from, [e]));
      show();
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

async function open() {
  const maplibregl = await import('../vendor/maplibre-gl/maplibre-gl.mjs').then((m) => m.default || m);

  //
  // The areas downloaded in c³, read from c³ - without c³, the online tiles only
  //
  let areas = [], fonts = false;
  if (C3.base()) {
    setApiBase(C3.base());
    try {
      const r = await C3.request('/api/run/dashboard/maps');
      areas = (r.body && r.body.areas) || [];
      fonts = !!(r.body && r.body.fonts);
    } catch (e) { /* online only */ }
  }
  setAreas(areas, fonts);
  await registerProtocols(maplibregl);

  map = new maplibregl.Map({ container: 'map', style: buildStyle(areas), center: [0, 20], zoom: 1.5, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    entityLayers();
    show();
  });
}

MashupPlatform.wiring.registerCallback('entities', (data) => {
  entities = C3.entitiesIn(data);
  from = C3.fromOf(data);
  show();
});
C3.onPrefs(() => show());

open().catch((e) => note(e.message));
