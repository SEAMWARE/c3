//
// ngsild.js - a broker's entities by ordinary NGSI-LD queries, and what the graph needs from them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
import { brokerGet } from './api.js';

export const PAGE_SIZE = 100;
export const ENTITY_CAP = 2000;

//
// nextLink - the URL of rel="next" in a Link header, or null
//
// The broker's next link is a path (/ngsi-ld/v1/entities?...) or an absolute URL; the path is what the
// proxy takes.
//
export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) continue;
    const rel = m[2].match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]*))/);
    if (!rel || !(rel[1] ?? rel[2]).split(/\s+/).includes('next')) continue;
    let target = m[1];
    if (/^https?:\/\//.test(target)) {
      const u = new URL(target);
      target = u.pathname + u.search;
    }
    return target;
  }
  return null;
}

function problem(r) {
  const b = r.body || {};
  return {
    reached: r.reached,
    status: r.status,
    title: b.title || ('HTTP ' + r.status),
    detail: b.detail || (typeof b === 'string' ? b : ''),
  };
}

//
// loadEntities - every entity of the broker, page by page, up to ENTITY_CAP
//
// GET /ngsi-ld/v1/entities?local=true&limit=..&count=true, following rel="next". A broker that does not
// take local=true as the whole query (400) is asked for its types (GET /ngsi-ld/v1/types) and then
// queried with type=<all of them>.
//
// onProgress(loaded, total) after each page. Answers { entities, total, truncated } or throws
// { reached, status, title, detail }.
//
export async function loadEntities(broker, onProgress) {
  let first = `/ngsi-ld/v1/entities?local=true&limit=${PAGE_SIZE}&count=true`;
  let r = await brokerGet(broker, first);

  if (r.status === 400) {
    const t = await brokerGet(broker, '/ngsi-ld/v1/types');
    if (!t.ok) throw problem(r);
    const list = (t.body && (t.body.typeList || (Array.isArray(t.body) ? t.body.map((x) => x.typeName || x.id) : null))) || [];
    if (list.length === 0) return { entities: [], total: 0, truncated: false };
    first = `/ngsi-ld/v1/entities?type=${encodeURIComponent(list.join(','))}&limit=${PAGE_SIZE}&count=true`;
    r = await brokerGet(broker, first);
  }

  const seen = new Map();
  let total = null;
  let pages = 0;

  for (;;) {
    if (!r.ok) throw problem(r);
    if (!Array.isArray(r.body)) throw { reached: true, status: r.status, title: 'Not an entity list', detail: 'the broker answered the query with something else than a JSON array' };

    const count = r.headers.get('NGSILD-Results-Count');
    if (count !== null && total === null) total = parseInt(count, 10);

    for (const e of r.body) {
      if (e && typeof e.id === 'string' && !seen.has(e.id)) seen.set(e.id, e);
      if (seen.size >= ENTITY_CAP) break;
    }
    ++pages;
    if (onProgress) onProgress(seen.size, total);

    const next = nextLink(r.headers.get('Link'));
    if (!next || seen.size >= ENTITY_CAP || r.body.length === 0 || pages > 1000) {
      const truncated = seen.size >= ENTITY_CAP && (next !== null || (total !== null && total > seen.size));
      return { entities: [...seen.values()], total: total === null ? seen.size : total, truncated };
    }
    r = await brokerGet(broker, next);
  }
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
// boxAttrs - the two attributes a box shows: the first Properties of the entity, not location
//
export function boxAttrs(e) {
  const out = [];
  for (const [k, v] of attributes(e)) {
    if (out.length === 2) break;
    const kind = kindOf(v);
    if (kind === 'Relationship' || kind === 'ListRelationship' || kind === 'GeoProperty') continue;
    if (CORE.has(k)) continue;
    out.push({ k, v: valueText(v, 24) });
  }
  return out;
}
