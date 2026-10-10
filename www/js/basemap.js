//
// basemap.js - the map under the entities: c³'s dark style, online tiles and the downloaded areas
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Two sources of OpenStreetMap data, one look:
//
//   online      OpenFreeMap's vector tiles (OpenMapTiles schema, no key) - https://openfreemap.org
//   offline     the areas downloaded with "Download this area": extracts of the Protomaps planet
//               (Protomaps basemap schema), one .pmtiles file each, served by c³'s backend with Range
//
// The schemas differ, so each has its layers, drawn in the same colours: the OpenMapTiles layers below
// (c³'s own, here), then per area a mask in the water colour over its bounding box, then the Protomaps
// layers (from @protomaps/basemaps, with c³'s colours, no icons). Inside an area the online tiles are
// not asked for (c3omt:// answers an empty tile), and their labels are filtered out.
//
// Glyphs (c3glyphs://): the copy downloaded with the first area, else Protomaps' basemaps-assets online.
// No sprite: the map has no POI icons or road shields, so nothing competes with the entities.
//
import { layers as pmLayers, namedFlavor } from '../vendor/protomaps-basemaps/basemaps.mjs';

export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const GLYPHS_ONLINE = 'https://protomaps.github.io/basemaps-assets/fonts/';
export const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];

const OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
const OFM_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>';
const PM_ATTRIBUTION = '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>';

//
// The colours - near-black land, a dark blue-grey sea, roads in the panel greys: the entities, in their
// type colours, are what stands out
//
export const C = {
  land: '#111419',
  water: '#0B1620',
  waterLine: '#12202D',
  green: '#101A16',
  wood: '#0F1915',
  sand: '#16161A',
  urban: '#13161C',
  industrial: '#15171D',
  building: '#191D25',
  buildingLine: '#20252F',
  building3d: '#2A303C',
  minor: '#20242D',
  street: '#252A34',
  major: '#2C323D',
  highway: '#363D4A',
  casing: '#0E1014',
  rail: '#2A303B',
  path: '#1D2129',
  boundary: '#4A515E',
  label: '#7A8190',
  labelMajor: '#A6ADBA',
  labelCity: '#CDD2DB',
  labelWater: '#4F6B84',
  halo: '#0E1014',
};

//
// ofmLayers - the OpenMapTiles-schema layers (source 'omt'); 'outside' a filter that keeps a label out
// of the downloaded areas (null: none)
//
function ofmLayers(outside) {
  const name = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
  const cls = ['get', 'class'];
  const keep = (f) => (outside ? ['all', f, outside] : f);
  const road = (id, classes, color, widths, extra = {}) => ({
    id, type: 'line', source: 'omt', 'source-layer': 'transportation',
    filter: ['all', ['match', cls, classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], ...widths], ...extra },
  });

  return [
    { id: 'land', type: 'background', paint: { 'background-color': C.land } },
    { id: 'landcover-wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['match', cls, ['wood', 'forest'], true, false], paint: { 'fill-color': C.wood } },
    { id: 'landcover-grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['match', cls, ['grass', 'farmland', 'wetland'], true, false], paint: { 'fill-color': C.green, 'fill-opacity': 0.7 } },
    { id: 'landcover-sand', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['match', cls, ['sand', 'ice', 'rock'], true, false], paint: { 'fill-color': C.sand } },
    { id: 'landuse-urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['match', cls, ['residential', 'suburb', 'neighbourhood', 'commercial', 'retail'], true, false], paint: { 'fill-color': C.urban } },
    { id: 'landuse-industrial', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['match', cls, ['industrial', 'railway', 'garages'], true, false], paint: { 'fill-color': C.industrial } },
    { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.green } },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': C.water } },
    { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': C.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] } },
    { id: 'aeroway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 11, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': C.major, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 12] } },
    { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, maxzoom: 14, paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine } },
    // from zoom 14 the buildings stand up: their height in metres (OpenMapTiles render_height), seen when the map is tilted
    { id: 'building-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
      paint: { 'fill-extrusion-color': C.building3d, 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
               'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.9 } },
    road('road-path', ['path', 'track'], C.path, [14, 0.5, 18, 2], { 'line-dasharray': [2, 1.5] }),
    road('road-minor', ['minor', 'service'], C.minor, [12, 0.5, 18, 8]),
    road('road-street', ['tertiary'], C.street, [10, 0.6, 18, 12]),
    road('road-major', ['primary', 'secondary', 'trunk'], C.major, [7, 0.6, 18, 16]),
    road('road-highway', ['motorway'], C.highway, [5, 0.7, 18, 18]),
    road('rail', ['rail', 'transit'], C.rail, [10, 0.6, 18, 2.5], { 'line-dasharray': [3, 2] }),
    { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['<=', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': C.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 10, 1.6] } },
    { id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['match', ['get', 'admin_level'], [3, 4], true, false], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': C.boundary, 'line-width': 0.8, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } },
    {
      id: 'label-water', type: 'symbol', source: 'omt', 'source-layer': 'water_name', filter: keep(['all', ['has', 'name'], ['==', ['geometry-type'], 'Point']]),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 12 },
      paint: { 'text-color': C.labelWater, 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-road', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13, filter: keep(['has', 'name']),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-placement': 'line' },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 11,
      filter: keep(['match', cls, ['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet'], true, false]),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13], 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-place-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 7,
      filter: keep(['match', cls, ['town'], true, false]),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 14, 15] },
      paint: { 'text-color': C.labelMajor, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 3,
      filter: keep(['match', cls, ['city'], true, false]),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Medium'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 18] },
      paint: { 'text-color': C.labelCity, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
    },
    {
      id: 'label-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 9,
      filter: keep(['match', cls, ['country', 'state'], true, false]),
      layout: { 'text-field': name, 'text-font': ['Noto Sans Medium'], 'text-size': ['match', cls, 'country', 13, 11], 'text-transform': 'uppercase', 'text-letter-spacing': 0.12 },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
    },
  ];
}

//
// pmFlavor - Protomaps' dark flavour in c³'s colours, without POI icons
//
function pmFlavor() {
  const f = { ...namedFlavor('dark') };
  delete f.pois;
  Object.assign(f, {
    background: C.water, earth: C.land, water: C.water,
    park_a: C.green, park_b: C.green, wood_a: C.wood, wood_b: C.wood, scrub_a: C.green, scrub_b: C.green,
    hospital: C.urban, industrial: C.industrial, school: C.urban, pedestrian: C.urban, zoo: C.green, military: C.industrial,
    glacier: C.sand, sand: C.sand, beach: C.sand, aerodrome: C.urban, runway: C.major, pier: C.street,
    buildings: C.building,
    other: C.path, minor_service: C.minor, minor_a: C.minor, minor_b: C.minor, link: C.street, major: C.major, highway: C.highway,
    minor_service_casing: C.land, minor_casing: C.land, link_casing: C.land, major_casing_late: C.land, highway_casing_late: C.land,
    major_casing_early: C.land, highway_casing_early: C.land,
    tunnel_other: C.minor, tunnel_minor: C.minor, tunnel_link: C.minor, tunnel_major: C.street, tunnel_highway: C.major,
    bridges_other: C.path, bridges_minor: C.minor, bridges_link: C.street, bridges_major: C.major, bridges_highway: C.highway,
    railway: C.rail, boundaries: C.boundary,
    roads_label_minor: C.label, roads_label_minor_halo: C.halo, roads_label_major: C.label, roads_label_major_halo: C.halo,
    ocean_label: C.labelWater, subplace_label: C.label, subplace_label_halo: C.halo,
    city_label: C.labelCity, city_label_halo: C.halo, state_label: C.label, state_label_halo: C.halo, country_label: C.label,
    address_label: C.label, address_label_halo: C.halo,
  });
  if (f.landcover) {
    f.landcover = { ...f.landcover, grassland: C.green, barren: C.sand, urban_area: C.urban, farmland: C.green, glacier: C.sand, scrub: C.green, forest: C.wood };
  }
  return f;
}

//
// areaLayers - the Protomaps layers of one downloaded area: its source, no background, no icons
//
function areaLayers(area) {
  const src = 'pm-' + area.id;
  return pmLayers(src, pmFlavor(), { lang: 'en' })
    .filter((l) => l.type !== 'background' && !['roads_oneway', 'roads_shields'].includes(l.id))
    .map((l) => {
      const out = { ...l, id: area.id + ':' + l.id };
      if (out.layout && out.layout['icon-image'] !== undefined) {
        out.layout = { ...out.layout };
        for (const k of Object.keys(out.layout)) if (k.startsWith('icon-')) delete out.layout[k];
      }
      return out;
    });
}

//
// areasPolygon - the downloaded areas' bounding boxes, as one MultiPolygon
//
export function areasPolygon(areas) {
  return {
    type: 'MultiPolygon',
    coordinates: areas.map((a) => {
      const [w, s, e, n] = a.bbox;
      return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
    }),
  };
}

//
// buildStyle - the whole base style for the areas downloaded (the entities are added on top by map.js)
//
export function buildStyle(areas) {
  const outside = areas.length ? ['!', ['within', { type: 'Feature', geometry: areasPolygon(areas), properties: {} }]] : null;
  const sources = {
    omt: { type: 'vector', tiles: ['c3omt://{z}/{x}/{y}'], minzoom: 0, maxzoom: 14, attribution: OFM_ATTRIBUTION },
  };
  const layers = ofmLayers(outside);

  if (areas.length) {
    sources['c3-mask'] = {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: areasPolygon(areas), properties: {} }] },
    };
    layers.push({ id: 'c3-mask', type: 'fill', source: 'c3-mask', paint: { 'fill-color': C.water } });
    for (const a of areas) {
      sources['pm-' + a.id] = { type: 'vector', url: `pmtiles://${location.origin}/api/maps/areas/${a.id}.pmtiles`, attribution: PM_ATTRIBUTION };
      layers.push(...areaLayers(a));
    }
  }

  return { version: 8, glyphs: 'c3glyphs://{fontstack}/{range}', sources, layers };
}

export const ATTRIBUTION = OSM;

//
// Protocols - registered once
//
let registered = false;
let ofmTemplate = null;                          // the tile URL template of OpenFreeMap's TileJSON
let areasNow = [];
let fontsLocal = false;
export const onlineState = { failures: 0, ok: 0, listeners: new Set() };

function noteOnline(ok) {
  if (ok) onlineState.ok++; else onlineState.failures++;
  for (const f of onlineState.listeners) f(ok);
}

//
// tileInside - the tile z/x/y lies wholly inside a downloaded area that goes down to its zoom
//
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function tileInside(z, x, y) {
  const [w, s, e, n] = tileBounds(z, x, y);
  return areasNow.some((a) => z <= a.maxzoom && w >= a.bbox[0] && e <= a.bbox[2] && s >= a.bbox[1] && n <= a.bbox[3]);
}

async function ofmTile(params, abort) {
  const m = params.url.match(/^c3omt:\/\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) throw new Error('bad tile URL ' + params.url);
  const [z, x, y] = m.slice(1).map(Number);
  if (tileInside(z, x, y)) return { data: new ArrayBuffer(0) };

  if (!ofmTemplate) {
    ofmTemplate = fetch(OFM_TILEJSON, { signal: abort.signal }).then((r) => {
      if (!r.ok) throw new Error('OpenFreeMap answered ' + r.status);
      return r.json();
    }).then((j) => j.tiles[0]).catch((e) => { ofmTemplate = null; throw e; });
  }
  let r;
  try {
    const template = await ofmTemplate;
    r = await fetch(template.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: abort.signal });
  } catch (e) {
    if (e.name !== 'AbortError') noteOnline(false);
    throw e;
  }
  if (r.status === 204 || r.status === 404) return { data: new ArrayBuffer(0) };
  if (!r.ok) { noteOnline(false); throw new Error('OpenFreeMap answered ' + r.status); }
  noteOnline(true);
  return { data: await r.arrayBuffer() };
}

async function glyphs(params, abort) {
  const m = params.url.match(/^c3glyphs:\/\/([^/]+)\/(\d+-\d+)/);
  if (!m) throw new Error('bad glyph URL ' + params.url);
  const stack = decodeURIComponent(m[1]).split(',')[0].trim();
  const range = m[2];
  if (fontsLocal && FONT_STACKS.includes(stack)) {
    const r = await fetch(`/api/maps/fonts/${encodeURIComponent(stack)}/${range}.pbf`, { signal: abort.signal });
    if (r.ok) return { data: await r.arrayBuffer() };
  }
  const r = await fetch(`${GLYPHS_ONLINE}${encodeURIComponent(stack)}/${range}.pbf`, { signal: abort.signal });
  if (!r.ok) throw new Error('glyphs ' + r.status);
  return { data: await r.arrayBuffer() };
}

//
// loadPmtiles - pmtiles.js is a classic script (it bundles its own inflate): loaded once, its global used
//
let pmtilesP = null;
function loadPmtiles() {
  if (!pmtilesP) {
    pmtilesP = new Promise((done, fail) => {
      const s = document.createElement('script');
      s.src = 'vendor/pmtiles/pmtiles.js';
      s.onload = () => done(window.pmtiles);
      s.onerror = () => fail(new Error('vendor/pmtiles/pmtiles.js did not load'));
      document.head.append(s);
    });
  }
  return pmtilesP;
}

export async function registerProtocols(maplibregl) {
  if (registered) return;
  registered = true;
  const pmtiles = await loadPmtiles();
  const protocol = new pmtiles.Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', protocol.tile);
  maplibregl.addProtocol('c3omt', ofmTile);
  maplibregl.addProtocol('c3glyphs', glyphs);
}

//
// setAreas - the downloaded areas the protocols know of, and whether the fonts are local
//
export function setAreas(areas, fonts) {
  areasNow = areas;
  fontsLocal = fonts;
}
