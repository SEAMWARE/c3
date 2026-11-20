//
// main.js - NGSI-LD map: c³ Explore's map of the entities wired to it
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Explore's own map (js/map.js and what it uses, maplibre and c³'s base map - packed in by c³, c3-include): online
// OpenFreeMap tiles, and the areas downloaded in c³ read from c³ (GET /api/run/dashboard/maps, the .pmtiles by
// Range, the fonts). On it the entities by every GeoProperty they have - a Point a marker (an icon for the kinds
// Explore knows: a bus, a stop, a streetlight, ...), a line, an area - coloured by type as in Explore; a
// Relationship between two entities on the map is an arrow ("relationships": every one, or the selected
// entity's). The input "entities" takes the events of any number of sources, each source's entities kept; a new
// read of the same entities makes a Point that moved glide to its new place, other entities fit the view to them.
// An entity clicked is sent on "selected"; an entity on "select" is selected and centred.
//
/* globals MashupPlatform, C3 */
import { EntityMap } from './map.js';
import { setApiBase } from './basemap.js';
import { edgesOf, typesOf, typeLabel } from './entity.js';
import { Gathered, colorer } from './common/views.js';

const t = C3.t;
const $ = (id) => document.getElementById(id);

const gathered = new Gathered();
const emap = new EntityMap({ container: $('map') });
let shown = [];
let byId = new Map();
let idsKey = null;
let opened = null;
let quiet = false;

function note(text) {
  $('note').hidden = !text;
  $('note').textContent = text || '';
}

function prefsApply() {
  emap.setRelationships(C3.pref('relationships') || 'all');
  emap.setLabelZoom(Math.max(0, Number(C3.pref('labelZoom')) || 0));
  emap.setLabelAttr(C3.pref('attribute') || null);
}

//
// open - the map, once: the areas downloaded in c³ first (without c³: the online tiles only)
//
function open() {
  if (!opened) {
    opened = (async () => {
      let areas = [], fonts = false;
      if (C3.base()) {
        setApiBase(C3.base());
        try {
          const r = await C3.request('/api/run/dashboard/maps');
          areas = (r.body && r.body.areas) || [];
          fonts = !!(r.body && r.body.fonts);
        } catch (e) { /* online only */ }
      }
      emap.setAreas(areas, fonts);
      await emap.open(null);
      prefsApply();
    })();
  }
  return opened;
}

function legend(colorOf) {
  const n = new Map();
  shown.forEach((x) => { if (emap.has(x.entity.id)) typesOf(x.entity).forEach((ty) => n.set(ty, (n.get(ty) || 0) + 1)); });
  const box = $('legend');
  box.textContent = '';
  [...n.keys()].sort().forEach((ty) => {
    const s = C3.el('span');
    const sw = C3.el('i');
    sw.style.background = colorOf(ty);
    s.append(sw, document.createTextNode(typeLabel(ty) + ' ' + n.get(ty)));
    s.title = ty;
    box.append(s);
  });
}

async function draw() {
  await open();
  shown = gathered.all();
  byId = new Map(shown.map((x) => [x.entity.id, x.entity]));
  const colorOf = await colorer(shown, gathered.brokers());
  const entities = shown.map((x) => x.entity);
  const ids = entities.map((e) => e.id).join('\n');
  const other = ids !== idsKey;

  emap.set(entities, edgesOf(entities, byId), (e) => colorOf(typesOf(e)[0]), { live: !other });
  if (other) emap.fit(false);
  idsKey = ids;
  legend(colorOf);

  if (!entities.length) note(t('No entities in what is wired to this widget'));
  else if (!emap.anchors.size) note(t('No entity has a location'));
  else note(null);
}

emap.onSelect = (id) => {
  emap.select(id);
  if (quiet || !id) return;
  const x = shown.find((s) => s.entity.id === id);
  if (x) MashupPlatform.wiring.pushEvent('selected', C3.withEntities(x.from, [x.entity]));
};

MashupPlatform.wiring.registerCallback('entities', (data) => {
  gathered.add(data);
  draw().catch((e) => note(e.message));
});

MashupPlatform.wiring.registerCallback('select', (data) => {
  const e = C3.entitiesIn(data)[0];
  if (!e || !emap.has(e.id)) return;
  quiet = true;
  emap.select(e.id, { center: true });
  quiet = false;
});

C3.onPrefs(() => { if (emap.map) prefsApply(); });
window.addEventListener('resize', () => emap.resize());

note(t('Waiting for entities - wire an NGSI-LD source to this widget'));
open().catch((e) => note(e.message));
