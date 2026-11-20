//
// entity.js - an NGSI-LD entity read: its types, attributes, Relationships, a short id, a value as text
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Nothing here talks to a broker or to c3: the Dashboard's graph and map widgets pack this file (their
// c3-include) as well as Explore uses it - through ngsild.js, which exports it again.
//
//
// linked - the entities embedded in a Relationship by linked entity retrieval (join=inline): the
// "entity" member of a Relationship, the "entityList" of a ListRelationship
//
export function linked(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  if (v.entity && typeof v.entity === 'object' && !Array.isArray(v.entity)) return [v.entity];
  if (Array.isArray(v.entityList)) return v.entityList.filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
  return [];
}

//
// typesOf - an entity's types, as an array
//
export function typesOf(e) {
  if (Array.isArray(e.type)) return e.type.map(String);
  return e.type ? [String(e.type)] : ['(no type)'];
}

const CORE = new Set(['id', 'type', '@context', 'scope', 'createdAt', 'modifiedAt', 'deletedAt', 'location', 'observationSpace', 'operationSpace']);

//
// attributes - [name, instance] for every attribute instance of an entity, in the entity's order
//
// A multi-attribute (datasetId) is an array of instances; each is listed. location, observationSpace and
// operationSpace are attributes too and are listed; id, type, scope and the system timestamps are not.
//
export function attributes(e) {
  const out = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id' || k === 'type' || k === '@context' || k === 'scope' || k === 'createdAt' || k === 'modifiedAt' || k === 'deletedAt') continue;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && 'type' in x)) {
      for (const inst of v) out.push([k, inst]);
    } else {
      out.push([k, v]);
    }
  }
  return out;
}

//
// kindOf - Property, Relationship, GeoProperty, ... (a normalized attribute's "type")
//
export function kindOf(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') return v.type;
  return 'Property';
}

//
// relationshipTargets - the entity ids a Relationship / ListRelationship points at
//
export function relationshipTargets(v) {
  const kind = kindOf(v);
  const ids = [];
  const take = (x) => {
    if (typeof x === 'string') ids.push(x);
    else if (Array.isArray(x)) x.forEach(take);
    else if (x && typeof x === 'object') take(x.object ?? x['@id'] ?? x.id);
  };
  if (kind === 'Relationship') take(v.object);
  else if (kind === 'ListRelationship') take(v.objectList ?? v.object);
  return ids;
}

//
// edgesOf - the graph's arrows: {from, to, name} for every Relationship between two loaded entities
//
export function edgesOf(entities, byId) {
  const edges = [];
  const keys = new Set();
  for (const e of entities) {
    for (const [name, v] of attributes(e)) {
      for (const to of relationshipTargets(v)) {
        if (!byId.has(to) || to === e.id) continue;
        const key = e.id + '\n' + name + '\n' + to;
        if (keys.has(key)) continue;
        keys.add(key);
        edges.push({ from: e.id, to, name });
      }
    }
  }
  return edges;
}

//
// shortId - the part of an id worth showing on a box: urn:ngsi-ld:Robot:amr1 -> amr1
//
export function shortId(e) {
  const id = e.id;
  const types = typesOf(e);
  const m = id.match(/^urn:ngsi-ld:([^:]+):(.+)$/);
  if (m && types.some((t) => t === m[1] || t.endsWith('/' + m[1]) || t.endsWith('#' + m[1]))) return m[2];
  if (m) return m[1] + ':' + m[2];
  return id.replace(/^urn:/, '');
}

//
// valueText - a short, readable form of an attribute's value
//
export function valueText(v, max = 80) {
  const kind = kindOf(v);
  let out;
  if (!v || typeof v !== 'object' || Array.isArray(v)) out = jsonShort(v);
  else if (kind === 'Relationship' || kind === 'ListRelationship') out = relationshipTargets(v).join(', ');
  else if (kind === 'GeoProperty') out = geoText(v.value);
  else if (kind === 'LanguageProperty') out = langText(v.languageMap);
  else if (kind === 'ListProperty') out = jsonShort(v.valueList);
  else if (kind === 'VocabProperty') out = jsonShort(v.vocab);
  else if (kind === 'JsonProperty') out = jsonShort(v.json);
  else out = jsonShort('value' in v ? v.value : v);
  if (v && typeof v === 'object' && typeof v.unitCode === 'string' && out.length < max) out += ' ' + v.unitCode;
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

function numberText(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function jsonShort(x) {
  if (typeof x === 'number') return numberText(x);
  if (typeof x === 'string') return JSON.stringify(x);
  if (x === undefined) return '';
  return JSON.stringify(x);
}

function geoText(g) {
  if (!g || typeof g !== 'object') return jsonShort(g);
  if (g.type === 'Point' && Array.isArray(g.coordinates)) return 'Point ' + g.coordinates.map(numberText).join(', ');
  return g.type || jsonShort(g);
}

function langText(m) {
  if (!m || typeof m !== 'object') return jsonShort(m);
  const e = Object.entries(m);
  if (e.length === 0) return '{}';
  return e.map(([l, t]) => l + ': ' + JSON.stringify(t)).join(', ');
}

//
// boxAttrs - the attributes a box shows (two): the first Properties of the entity, not location
//
export function boxAttrs(e, max = 2) {
  const out = [];
  for (const [k, v] of attributes(e)) {
    if (out.length === max) break;
    const kind = kindOf(v);
    if (kind === 'Relationship' || kind === 'ListRelationship' || kind === 'GeoProperty') continue;
    if (CORE.has(k)) continue;
    out.push({ k, v: valueText(v, 24) });
  }
  return out;
}

//
// Type colours - the palette, by a type's place in a sorted list of types (a broker's, from /types): the same
// types, the same colours. Types beyond the palette repeat it.
//
export const PALETTE = ['#5FB4E8', '#F2B84B', '#6FDCA0', '#B48CFF', '#FF8A9A', '#6FA8FF', '#C9D46A', '#4FD1C5', '#F59E6B', '#E58AB1', '#7FA3BC', '#A6ADBA'];

export function typeColors(types) {
  return new Map([...new Set(types)].sort().map((t, i) => [t, PALETTE[i % PALETTE.length]]));
}

//
// typeLabel - a type as shown: the last part of an expanded IRI
//
export function typeLabel(t) {
  const m = t.match(/[#/]([^#/]+)$/);
  return m && /^https?:/.test(t) ? m[1] : t;
}
