//
// main.js - NGSI-LD graph: c³ Explore's graph of the entities wired to it
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Explore's own graph (js/graph.js, js/layout.js, js/entity.js and css/graph.css, packed in by c³ - c3-include):
// a box per entity, coloured by its type as in Explore, an arrow per Relationship between two entities shown,
// laid out in layers - every arrow points up. Zoom with the wheel, pan by dragging the background, move a box
// by dragging it. The input "entities" takes the events of any number of sources: each source's entities are
// kept, all of them drawn - wire Robots, Docks and Floors to it and their Relationships are drawn between them.
// A new read of the same entities keeps the picture and flashes the values that changed; other entities lay
// it out again. A box clicked is sent on "selected"; an entity on "select" is selected and centred.
//
/* globals MashupPlatform, C3 */
import { Graph } from './graph.js';
import { layout } from './layout.js';
import { edgesOf, typesOf, typeLabel, shortId, boxAttrs } from './entity.js';
import { Gathered, colorer } from './common/views.js';

const t = C3.t;
const $ = (id) => document.getElementById(id);

const gathered = new Gathered();
let shown = [];                                  // [{entity, from}]
let byId = new Map();
let colorOf = () => '#5FB4E8';
let idsKey = null;                               // the entities drawn, their ids
let edgesKey = null;                             // and their Relationships
let attrsOf = new Map();                         // id -> the box's rows, as JSON: what changed is flashed
let quiet = false;                               // a selection from "select": not sent on again

const graph = new Graph({
  viewport: $('viewport'), world: $('world'), svg: $('edges'),
  lines: $('edge-lines'), labels: $('edge-labels'), boxes: $('boxes'), pct: $('pct'),
});

function note(text) {
  $('note').hidden = !text;
  $('note').textContent = text || '';
}

function hidden() {
  return String(C3.pref('hideTypes') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function nodeOf(e) {
  const types = typesOf(e);
  return { id: e.id, types, color: colorOf(types[0]), label: types.map(typeLabel).join(', '), short: shortId(e), attrs: boxAttrs(e) };
}

//
// legend - a type each, its colour and how many; clicked: hidden or shown again (the preference hideTypes)
//
function legend() {
  const n = new Map();
  shown.forEach((x) => typesOf(x.entity).forEach((ty) => n.set(ty, (n.get(ty) || 0) + 1)));
  const off = new Set(hidden());
  const box = $('legend');
  box.textContent = '';
  [...n.keys()].sort().forEach((ty) => {
    const b = C3.el('button', off.has(ty) ? 'off' : '');
    const sw = C3.el('i');
    sw.style.background = colorOf(ty);
    b.append(sw, document.createTextNode(typeLabel(ty) + ' ' + n.get(ty)));
    b.title = ty;
    b.addEventListener('click', () => {
      const now = new Set(hidden());
      if (now.has(ty)) now.delete(ty); else now.add(ty);
      C3.setPrefs({ hideTypes: [...now].join(',') });
    });
    box.append(b);
  });
}

async function draw() {
  shown = gathered.all();
  byId = new Map(shown.map((x) => [x.entity.id, x.entity]));
  colorOf = await colorer(shown, gathered.brokers());

  const entities = shown.map((x) => x.entity);
  const edges = edgesOf(entities, byId);
  const nodes = entities.map(nodeOf);
  const ids = nodes.map((n) => n.id).join('\n');
  const rels = edges.map((e) => e.from + '\n' + e.name + '\n' + e.to).join('\n');

  if (ids !== idsKey) {
    //
    // Other entities: laid out again - the boxes moved by hand stay where they were put
    //
    const positions = layout(nodes.map((n) => ({ id: n.id, type: n.types[0] })), edges);
    if (idsKey === null) { graph.set(nodes, edges, positions); graph.fit(); } else graph.patch(nodes, edges, positions, positions);
  } else if (rels !== edgesKey) {
    graph.patch(nodes, edges, null, new Map());
  } else {
    //
    // The same entities and Relationships: the boxes whose values changed flashed, the picture kept
    //
    nodes.forEach((n) => { if (attrsOf.get(n.id) !== JSON.stringify(n.attrs)) graph.update(n.id, n.attrs); });
  }
  idsKey = ids;
  edgesKey = rels;
  attrsOf = new Map(nodes.map((n) => [n.id, JSON.stringify(n.attrs)]));
  graph.setHidden(hidden());
  legend();
  note(shown.length ? null : t('No entities in what is wired to this widget'));
}

graph.onSelect = (id) => {
  if (quiet || !id) return;
  const x = shown.find((s) => s.entity.id === id);
  if (x) MashupPlatform.wiring.pushEvent('selected', C3.withEntities(x.from, [x.entity]));
};

$('in').addEventListener('click', () => graph.zoomCenter(1.25));
$('out').addEventListener('click', () => graph.zoomCenter(0.8));
$('fit').addEventListener('click', () => { graph.autoFit = true; graph.fit(); });
$('fit').textContent = t('Fit');

MashupPlatform.wiring.registerCallback('entities', (data) => {
  gathered.add(data);
  draw().catch((e) => note(e.message));
});

MashupPlatform.wiring.registerCallback('select', (data) => {
  const e = C3.entitiesIn(data)[0];
  if (!e || !byId.has(e.id)) return;
  quiet = true;
  graph.select(e.id, { center: true });
  quiet = false;
});

C3.onPrefs(() => {
  graph.setHidden(hidden());
  legend();
});

note(t('Waiting for entities - wire an NGSI-LD source to this widget'));
