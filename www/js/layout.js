//
// layout.js - a deterministic layered layout: the same entities and Relationships give the same picture
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Layers along the Relationships: an entity with no Relationship to another loaded entity is in layer 0,
// at the top; any other entity is one layer below the lowest of its targets (longest path), so every
// arrow points up - a Robot below the Dock it is docked at, the Dock below its Floor, the Floor below
// its Building. A cycle is cut at the Relationship that closes it, found in id order.
//
// In a layer, the order comes from the neighbours (barycentres, two sweeps down and up), ties broken by
// type and id. A layer wider than maxRow wraps onto more rows, grouped by type. Entities with no
// Relationship at all, either way, go in a grid of their own below the graph, by type and id.
//
// Nothing depends on the order the broker sent the entities in: everything is sorted first.
//

export const BOX_W = 210;
export const BOX_H = 96;

const GAP_X       = 50;     // between boxes in a row
const GAP_ROW     = 50;     // between the rows of one wrapped layer
const GAP_LAYER   = 104;    // between layers - room for the arrow labels
const GAP_LOOSE   = 160;    // between the graph and the grid of unconnected entities

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

//
// layout(nodes, edges) -> Map id -> {x, y}
//
//   nodes: [{id, type}]   (type: the first type, for the tie-breaks and the loose grid)
//   edges: [{from, to}]   (from and to both in nodes)
//
export function layout(nodes, edges) {
  const ids = nodes.map((n) => n.id).sort(cmp);
  const typeOf = new Map(nodes.map((n) => [n.id, n.type || '']));
  const byTypeId = (a, b) => cmp(typeOf.get(a), typeOf.get(b)) || cmp(a, b);

  const out = new Map(ids.map((id) => [id, []]));
  const inn = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (e.from === e.to || !out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from).push(e.to);
    inn.get(e.to).push(e.from);
  }
  for (const id of ids) {
    out.set(id, [...new Set(out.get(id))].sort(cmp));
    inn.set(id, [...new Set(inn.get(id))].sort(cmp));
  }

  //
  // Cut the cycles: a depth-first walk in id order; an edge to an entity still on the walk's path closes
  // a cycle and is not used for the layers
  //
  const state = new Map();                       // 1: on the path, 2: done
  const dag = new Map(ids.map((id) => [id, []]));
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [id, i] = top;
      const targets = out.get(id);
      if (i < targets.length) {
        top[1] = i + 1;
        const t = targets[i];
        const s = state.get(t);
        if (s === 1) continue;                   // closes a cycle
        dag.get(id).push(t);
        if (s === undefined) {
          state.set(t, 1);
          stack.push([t, 0]);
        }
      } else {
        state.set(id, 2);
        stack.pop();
      }
    }
  }

  //
  // Layers: longest path to an entity with no (kept) Relationship
  //
  const layerOf = new Map();
  const depth = (root) => {
    const stack = [root];
    while (stack.length) {
      const id = stack[stack.length - 1];
      if (layerOf.has(id)) { stack.pop(); continue; }
      const pending = dag.get(id).filter((t) => !layerOf.has(t));
      if (pending.length) { stack.push(...pending); continue; }
      let l = 0;
      for (const t of dag.get(id)) l = Math.max(l, layerOf.get(t) + 1);
      layerOf.set(id, l);
      stack.pop();
    }
  };
  ids.forEach(depth);

  const loose = ids.filter((id) => out.get(id).length === 0 && inn.get(id).length === 0);
  const looseSet = new Set(loose);

  const layers = [];
  for (const id of ids) {
    if (looseSet.has(id)) continue;
    const l = layerOf.get(id);
    (layers[l] ||= []).push(id);
  }
  for (let l = 0; l < layers.length; l++) (layers[l] ||= []).sort(byTypeId);

  //
  // Order within the layers: barycentres of the neighbours in the layer above (down sweep) and below
  // (up sweep). Positions are fractions 0..1 of their layer's width, so layers of different sizes mix.
  //
  const pos = new Map();
  const place = (layer) => layer.forEach((id, i) => pos.set(id, layer.length > 1 ? i / (layer.length - 1) : 0.5));
  layers.forEach(place);

  //
  // A layer that has to wrap onto several rows is grouped by type first, the smaller groups first, so a
  // few Robots are not lost among a hundred sensors of the same layer
  //
  const total = ids.length;
  const maxRow = Math.max(12, Math.ceil(Math.sqrt(total) * 1.2));
  const typeCount = new Map();
  for (const id of ids) typeCount.set(typeOf.get(id), (typeCount.get(typeOf.get(id)) || 0) + 1);
  const group = (a, b) => typeCount.get(typeOf.get(a)) - typeCount.get(typeOf.get(b)) || cmp(typeOf.get(a), typeOf.get(b));

  const sweep = (l, neighbours) => {
    const layer = layers[l];
    const bary = new Map();
    for (const id of layer) {
      const ns = neighbours(id).filter((n) => pos.has(n) && layerOf.get(n) !== l);
      bary.set(id, ns.length ? ns.reduce((s, n) => s + pos.get(n), 0) / ns.length : pos.get(id));
    }
    const wraps = layer.length > maxRow;
    layer.sort((a, b) => (wraps ? group(a, b) : 0) || bary.get(a) - bary.get(b) || byTypeId(a, b));
    place(layer);
  };

  for (let round = 0; round < 2; round++) {
    for (let l = 1; l < layers.length; l++) sweep(l, (id) => out.get(id));
    for (let l = layers.length - 2; l >= 0; l--) sweep(l, (id) => inn.get(id));
  }

  //
  // Coordinates: rows centred on x = 0
  //
  const xy = new Map();
  let y = 0;

  const rows = (list) => {
    for (let start = 0; start < list.length; start += maxRow) {
      const row = list.slice(start, start + maxRow);
      const width = row.length * BOX_W + (row.length - 1) * GAP_X;
      row.forEach((id, i) => xy.set(id, { x: Math.round(-width / 2 + i * (BOX_W + GAP_X)), y }));
      y += BOX_H + (start + maxRow < list.length ? GAP_ROW : 0);
    }
  };

  layers.forEach((layer, l) => {
    if (l > 0) y += GAP_LAYER;
    rows(layer);
  });

  if (loose.length) {
    if (layers.length) y += GAP_LOOSE;
    rows([...loose].sort(byTypeId));
  }

  return xy;
}
