//
// ngsild.js - a broker's entities by ordinary NGSI-LD queries, and what the graph needs from them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
import { brokerGet } from './api.js';
import { t, plural } from './i18n.js';

export const PAGE_SIZE = 100;
export const ENTITY_CAP = 2000;

//
// The brokers read for their own entities only (local=true) - the user's choice, per broker; by default
// a broker is read as it answers, with its Context Sources
//
const locals = new Set();
export function setLocal(broker, on) {
  if (on) locals.add(broker); else locals.delete(broker);
}

//
// get - brokerGet, with local=true when the broker is read for its own entities - and without it if
// the broker refuses it (400)
//
async function get(broker, pathAndQuery) {
  if (!locals.has(broker)) return brokerGet(broker, pathAndQuery);
  const r = await brokerGet(broker, pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'local=true');
  return r.status === 400 ? brokerGet(broker, pathAndQuery) : r;
}

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
// pages - follow a query's rel="next" links from its first answer 'r', into 'seen', up to ENTITY_CAP
//
// Answers the total the broker announced (NGSILD-Results-Count of the first page), or null.
//
async function pages(broker, r, seen, onProgress, base = 0) {
  let total = null;
  let n = 0;

  for (;;) {
    if (!r.ok) throw problem(r);
    if (!Array.isArray(r.body)) throw { reached: true, status: r.status, title: t('Not an entity list'), detail: t('the broker answered the query with something else than a JSON array') };

    const count = r.headers.get('NGSILD-Results-Count');
    if (count !== null && total === null) total = parseInt(count, 10);

    for (const e of r.body) {
      if (seen.size >= ENTITY_CAP) break;
      if (e && typeof e.id === 'string' && !seen.has(e.id)) seen.set(e.id, e);
    }
    ++n;
    if (onProgress) onProgress(seen.size, total === null ? null : base + total);

    const next = nextLink(r.headers.get('Link'));
    if (!next || seen.size >= ENTITY_CAP || r.body.length === 0 || n > 1000) return { total, more: next !== null };
    r = await brokerGet(broker, next);
  }
}

//
// typeParam - a list of types as the value of type=: each one encoded, the commas between them not
//
export function typeParam(types) {
  return types.map(encodeURIComponent).join(',');
}

//
// loadEntities - the broker's entities, page by page, up to ENTITY_CAP
//
// types null: every entity. Read for its own entities (setLocal): GET /ngsi-ld/v1/entities?local=true&
// limit=..&count=true, following rel="next". Otherwise - or when the broker does not take local=true as
// the whole query (400) - the broker is asked for its types (GET /ngsi-ld/v1/types) and then queried with
// type=<all of them>: a query naming no type is too wide without local=true. A broker without /types:
// the local=true query, the only one that names no type.
//
// types an array: the entities of those types only - one query, type=A,B,..., or one query per type
// when the list is too long for a URL.
//
// filter: more of the query, e.g. '&idPattern=...' (encoded).
//
// onProgress(loaded, total) after each page. Answers { entities, total, truncated } or throws
// { reached, status, title, detail }.
//
export async function loadEntities(broker, onProgress, types = null, filter = '') {
  if (types !== null) return loadTypes(broker, onProgress, types, filter);

  const whole = `/ngsi-ld/v1/entities?local=true&limit=${PAGE_SIZE}&count=true${filter}`;
  if (locals.has(broker)) {
    const r = await brokerGet(broker, whole);
    if (r.status !== 400) return wholeLoad(broker, r, onProgress);
  }

  const t = await get(broker, '/ngsi-ld/v1/types');
  if (!t.ok) {
    if (locals.has(broker)) throw problem(t);
    return wholeLoad(broker, await brokerGet(broker, whole), onProgress);   // no /types: the query naming no type, local
  }
  const list = (t.body && (t.body.typeList || (Array.isArray(t.body) ? t.body.map((x) => x.typeName || x.id) : null))) || [];
  if (list.length === 0) return { entities: [], total: 0, truncated: false };
  return loadTypes(broker, onProgress, list, filter);
}

async function wholeLoad(broker, r, onProgress) {
  const seen = new Map();
  const { total, more } = await pages(broker, r, seen, onProgress);
  const truncated = seen.size >= ENTITY_CAP && (more || (total !== null && total > seen.size));
  return { entities: [...seen.values()], total: total === null ? seen.size : total, truncated };
}

async function loadTypes(broker, onProgress, types, filter = '') {
  const seen = new Map();
  if (types.length === 0) return { entities: [], total: 0, truncated: false };

  const joined = typeParam(types);
  const groups = joined.length <= 2000 ? [joined] : types.map((t) => typeParam([t]));
  let total = 0;
  let known = true;
  let more = false;

  for (const g of groups) {
    if (seen.size >= ENTITY_CAP) { more = true; known = false; break; }
    const q = `/ngsi-ld/v1/entities?type=${g}&limit=${PAGE_SIZE}&count=true${filter}`;
    const r = await get(broker, q);
    const before = seen.size;
    const page = await pages(broker, r, seen, onProgress, known ? total : 0);
    if (page.total === null) { known = false; total += seen.size - before; }
    else total += page.total;
    more = more || page.more;
  }

  const truncated = seen.size >= ENTITY_CAP && (more || total > seen.size);
  return { entities: [...seen.values()], total: known ? total : Math.max(total, seen.size), truncated };
}

//
// discover - what the broker holds, before any entity is loaded: its types, their entity counts and
// attributes with their kinds, and which types use each attribute
//
//   GET /ngsi-ld/v1/types?details=true          the types and their attribute names
//   GET /ngsi-ld/v1/types/{type}                per type: entityCount and attributeDetails (with the
//                                               kinds, attributeTypes); if a broker does not answer it,
//                                               GET /entities?type=T&limit=0&count=true for the count
//   GET /ngsi-ld/v1/attributes?details=true     per attribute: the types that use it (typeNames)
//
// A broker that does not answer /types?details=true is asked for /types (the names only).
//
// Answers { types: [{ name, id, count, attrs: [{ name, kinds }] }] sorted by name, attributes: Map
// name -> { typeNames }, total, notes } - or null when the broker has no /types at all (not an NGSI-LD
// broker, or one too old). Throws { reached, status, ... } when the broker cannot be reached.
//
export async function discover(broker, onProgress) {
  let r = await get(broker, '/ngsi-ld/v1/types?details=true');
  if (!r.reached) throw problem(r);

  const notes = [];
  let list = [];

  if (r.ok && Array.isArray(r.body)) {
    list = r.body.filter((t) => t && (t.typeName || t.id)).map((t) => ({
      name: String(t.typeName || t.id), id: String(t.id || t.typeName),
      attrs: (t.attributeNames || []).map((a) => ({ name: String(a), kinds: [] })),
    }));
  } else {
    r = await get(broker, '/ngsi-ld/v1/types');
    if (!r.reached) throw problem(r);
    if (!r.ok) return null;
    const names = (r.body && (r.body.typeList || (Array.isArray(r.body) ? r.body.map((x) => x.typeName || x.id) : null))) || [];
    list = names.map((n) => ({ name: String(n), id: String(n), attrs: [] }));
    notes.push(t('the broker did not answer /types?details=true'));
  }

  const byName = new Map();
  for (const t of list) if (!byName.has(t.name)) byName.set(t.name, { ...t, count: null });
  const types = [...byName.values()].sort((a, b) => cmp(a.name, b.name));

  //
  // Per type, a few requests at a time
  //
  let done = 0;
  let fallback = 0;
  const one = async (t) => {
    const info = await get(broker, '/ngsi-ld/v1/types/' + encodeURIComponent(t.name));
    if (info.ok && info.body && typeof info.body.entityCount === 'number') {
      t.count = info.body.entityCount;
      if (Array.isArray(info.body.attributeDetails)) {
        t.attrs = info.body.attributeDetails.filter((a) => a && (a.attributeName || a.id)).map((a) => ({
          name: String(a.attributeName || a.id),
          kinds: Array.isArray(a.attributeTypes) ? a.attributeTypes.map(String) : [],
        }));
      }
    } else {
      ++fallback;
      const q = `/ngsi-ld/v1/entities?type=${typeParam([t.name])}&limit=0&count=true`;
      const c = await get(broker, q);
      const n = c.ok ? c.headers.get('NGSILD-Results-Count') : null;
      t.count = n === null ? null : parseInt(n, 10);
    }
    ++done;
    if (onProgress) onProgress(done, types.length);
  };
  const queue = types.slice(0, TYPE_DETAILS_MAX);
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  if (fallback) notes.push(plural(fallback, '{n} type counted with count=true (no /types/{type})', '{n} types counted with count=true (no /types/{type})'));
  if (types.length > TYPE_DETAILS_MAX) notes.push(t('details for the first {n} types only', { n: TYPE_DETAILS_MAX }));
  for (const t of types) t.attrs.sort((a, b) => cmp(a.name, b.name));

  const attributes = new Map();
  const a = await get(broker, '/ngsi-ld/v1/attributes?details=true');
  if (a.ok && Array.isArray(a.body)) {
    for (const x of a.body) {
      if (!x || !(x.attributeName || x.id)) continue;
      attributes.set(String(x.attributeName || x.id), { typeNames: Array.isArray(x.typeNames) ? x.typeNames.map(String).sort(cmp) : [] });
    }
  } else {
    notes.push(t('the broker did not answer /attributes?details=true'));
  }

  const total = types.reduce((s, t) => s + (t.count || 0), 0);
  return { types, attributes, total, notes };
}

export const TYPE_DETAILS_MAX = 200;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

//
// relationshipNames - every attribute that is a Relationship or a ListRelationship in some type
//
export function relationshipNames(disc) {
  const names = new Set();
  if (!disc) return [];
  for (const t of disc.types) for (const a of t.attrs) if (a.kinds.some((k) => k === 'Relationship' || k === 'ListRelationship')) names.add(a.name);
  return [...names].sort(cmp);
}

//
// entityGet - one entity: GET /ngsi-ld/v1/entities/{id}[?query]; the entity, or throws a problem
//
export async function entityGet(broker, id, query = '') {
  const r = await brokerGet(broker, '/ngsi-ld/v1/entities/' + encodeURIComponent(id) + (query ? '?' + query : ''));
  if (!r.ok || !r.body || typeof r.body !== 'object' || Array.isArray(r.body)) throw problem(r);
  return r.body;
}

//
// entitiesQuery - the entities of one query (a query string without limit/count), up to 'max'
//
export async function entitiesQuery(broker, query, max) {
  const q = `/ngsi-ld/v1/entities?${query}&limit=${PAGE_SIZE}&count=true`;
  const r = await get(broker, q);
  const seen = new Map();
  const { total } = await pages(broker, r, seen, null);
  const entities = [...seen.values()].slice(0, max);
  return { entities, total: total === null ? seen.size : total };
}

//
// The entity helpers - in entity.js, which the widgets pack without the rest of this file
//
export { linked, typesOf, attributes, kindOf, relationshipTargets, edgesOf, shortId, valueText, boxAttrs } from './entity.js';
