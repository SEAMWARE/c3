//
// populate.js - a test dataset from a short description: the entities of each type, their attributes made by
// generators, and - when asked - the history of the attributes that change (AI Assist's populate_broker)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// populateGenerate(spec, now) is pure - no page, no broker: the same spec, seed and now give the same data
// (test/populate.mjs runs it under node). The spec:
//
//   {
//     "seed": 1,                                  any integer; default 1
//     "context": "https://.../context.jsonld",    optional, a URL or an array; default: the core context
//     "history": {"duration": "7d", "every": "15m"}   or {"from": "<ISO date>", "every": "1h"}; optional
//     "types": [
//       {"type": "Building", "count": 4, "idPrefix": "hall", "attrs": {
//          "name":     {"text": "Hall {n}"},
//          "location": {"point": {"bbox": [-3.71, 40.41, -3.69, 40.43]}}}},
//       {"type": "Device", "count": 30, "attrs": {
//          "temperature": {"walk": {"start": 21, "step": 0.4, "min": 15, "max": 35}, "unitCode": "CEL", "decimals": 1},
//          "load":        {"range": [0, 100], "decimals": 0, "unitCode": "P1"},
//          "status":      {"pick": ["ok", "maintenance"], "weights": [9, 1]},
//          "refBuilding": {"rel": "Building", "how": "group"},
//          "location":    {"point": {"polygon": [[lon, lat], ...]}},
//          "serialNumber": {"text": "SN-{n:5}"},
//          "category":    {"value": ["sensor"]}}}
//     ]
//   }
//
// An attribute has exactly one generator:
//   value   the same value on every entity
//   pick    one of a list (weights: relative, optional)
//   text    a template: {n} the entity's number (1, 2, ...), {n:3} zero-padded to 3 digits, {type} the type
//   range   [min, max] - uniform; a new value at every instant of the history
//   walk    {start, step, min, max} - a random walk (start may be [min, max]: each entity its own start)
//   point   a GeoProperty Point: {bbox: [west, south, east, north]}, {polygon: [[lon, lat], ...]} (inside),
//           or {line: [[lon, lat], ...]} (the entities spread along it, in order)
//   rel     a Relationship: to the entities of another type of the spec ("how": roundRobin (default), group
//           - contiguous blocks, random), or to one fixed entity ("urn:...")
// Options: unitCode, decimals (range and walk; default 2), observedAt (default true for range and walk).
//
// The ids: urn:ngsi-ld:<Type>:<idPrefix>-<number>, the number zero-padded to at least 3 digits; idPrefix
// defaults to the type in lower case.
//
// History: the range and walk attributes get a value at every instant from 'from' (or now - duration) up to
// now, every 'every', oldest first, each with its observedAt; the entity's current state is the value at now.
//

export const POPULATE_MAX_ENTITIES = 5000;
export const POPULATE_MAX_VALUES   = 200000;      // history values: entities x changing attributes x instants

const GENERATORS = ['value', 'pick', 'text', 'range', 'walk', 'point', 'rel'];
const UNIT_MS    = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

//
// mulberry32 - a small seeded generator, [0, 1)
//
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//
// A seed of its own per type and attribute: a type or attribute added to the spec leaves the others' data as it was
//
function hash(seed, ...parts) {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (const c of parts.join('\u0000')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

//
// A duration: "15m", "2h", "7d", "1w", "30s" - or ISO 8601 "PT15M", "P7D", "P1DT12H"
//
export function durationMs(s) {
  const str = String(s).trim();
  let m = str.match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (m) return Math.round(Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
  m = str.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (m && str !== 'P' && !/T$/i.test(str)) {
    const [, w, d, h, mi, se] = m.map((x) => Number(x || 0));
    return Math.round(w * UNIT_MS.w + d * UNIT_MS.d + h * UNIT_MS.h + mi * UNIT_MS.m + se * UNIT_MS.s);
  }
  throw new Error(`"${s}" is not a duration - write 15m, 2h, 7d, 1w (or ISO 8601: PT15M, P7D)`);
}

const round = (v, decimals) => { const f = 10 ** decimals; return Math.round(v * f) / f; };
const num = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: a number is needed, not ${JSON.stringify(v)}`); return v; };
const lonLat = (p, what) => {
  if (!Array.isArray(p) || p.length !== 2) throw new Error(`${what}: [longitude, latitude] pairs are needed`);
  const [lon, lat] = [num(p[0], what), num(p[1], what)];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error(`${what}: [${lon}, ${lat}] is not [longitude, latitude] - longitude first, -180..180, latitude -90..90`);
  return [lon, lat];
};

function inside(pt, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}

//
// pointMaker - what a point generator gives entity i of count
//
function pointMaker(g, what) {
  if (!g || typeof g !== 'object') throw new Error(`${what}: point needs {bbox: [west, south, east, north]}, {polygon: [[lon, lat], ...]} or {line: [[lon, lat], ...]}`);
  if (g.bbox) {
    if (!Array.isArray(g.bbox) || g.bbox.length !== 4) throw new Error(`${what}: bbox is [west, south, east, north]`);
    const [w, s] = lonLat([g.bbox[0], g.bbox[1]], what + '.bbox');
    const [e, n] = lonLat([g.bbox[2], g.bbox[3]], what + '.bbox');
    if (w >= e || s >= n) throw new Error(`${what}: bbox is [west, south, east, north] - west below east, south below north`);
    return (r) => [w + r() * (e - w), s + r() * (n - s)];
  }
  if (g.polygon) {
    if (!Array.isArray(g.polygon) || g.polygon.length < 3) throw new Error(`${what}: polygon needs at least 3 [lon, lat] corners`);
    const poly = g.polygon.map((p) => lonLat(p, what + '.polygon'));
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return (r) => {
      for (let k = 0; k < 10000; k++) { const p = [w + r() * (e - w), s + r() * (n - s)]; if (inside(p, poly)) return p; }
      throw new Error(`${what}: no point found inside the polygon - is it a real area?`);
    };
  }
  if (g.line) {
    if (!Array.isArray(g.line) || g.line.length < 2) throw new Error(`${what}: line needs at least 2 [lon, lat] points`);
    const line = g.line.map((p) => lonLat(p, what + '.line'));
    const segs = [];
    let total = 0;
    for (let k = 1; k < line.length; k++) { const len = Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]); segs.push(len); total += len; }
    return (r, i, count) => {
      let at = (count > 1 ? i / (count - 1) : 0.5) * total;
      for (let k = 0; k < segs.length; k++) {
        if (at <= segs[k] || k === segs.length - 1) {
          const f = segs[k] ? Math.min(1, at / segs[k]) : 0;
          return [line[k][0] + f * (line[k + 1][0] - line[k][0]), line[k][1] + f * (line[k + 1][1] - line[k][1])];
        }
        at -= segs[k];
      }
      return line[line.length - 1];
    };
  }
  throw new Error(`${what}: point needs bbox, polygon or line`);
}

const shortType = (type) => { const m = String(type).match(/[#/:]([^#/:]+)$/); return m ? m[1] : String(type); };

//
// populateGenerate - the dataset: {entities, history: [{id, type, <attribute>: [instance, ...], ...} - the bodies of
// POST /temporal/entities], counts,
// instants, values, from, to, everyMs, context}. Throws an Error that says what is wrong with the spec.
//
export function populateGenerate(spec, now = new Date()) {
  if (!spec || typeof spec !== 'object') throw new Error('a spec is needed: {types: [{type, count, attrs}]}');
  const types = spec.types;
  if (!Array.isArray(types) || types.length === 0) throw new Error('types: at least one {type, count, attrs} is needed');
  const seed = spec.seed === undefined ? 1 : Math.trunc(num(spec.seed, 'seed'));
  const context = spec.context;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('now: not a date');

  //
  // The types: names, counts, ids - first, so a relationship can point to a type given after it
  //
  const byType = new Map();
  let total = 0;
  for (const [ix, ts] of types.entries()) {
    const what = `types[${ix}]`;
    if (!ts || typeof ts.type !== 'string' || !/^\S+$/.test(ts.type)) throw new Error(`${what}: type is a name without blanks (Device, Building) or an IRI`);
    if (byType.has(ts.type)) throw new Error(`${what}: ${ts.type} is in the spec twice - one entry per type`);
    const count = ts.count;
    if (!Number.isInteger(count) || count < 1) throw new Error(`${what} (${ts.type}): count is a whole number, 1 or more`);
    total += count;
    const prefix = ts.idPrefix === undefined ? shortType(ts.type).toLowerCase() : String(ts.idPrefix);
    if (!/^[A-Za-z0-9._~-]+$/.test(prefix)) throw new Error(`${what} (${ts.type}): idPrefix is letters, digits, '.', '_', '~' and '-' only`);
    const width = Math.max(3, String(count).length);
    const ids = [];
    for (let i = 1; i <= count; i++) ids.push(`urn:ngsi-ld:${shortType(ts.type)}:${prefix}-${String(i).padStart(width, '0')}`);
    byType.set(ts.type, { spec: ts, count, ids, what });
  }
  if (total > POPULATE_MAX_ENTITIES) throw new Error(`${total} entities - at most ${POPULATE_MAX_ENTITIES} in one go; fewer, or several calls with other types or idPrefixes`);

  //
  // The history's instants
  //
  let instants = [];
  let fromMs = null;
  let everyMs = null;
  if (spec.history) {
    const h = spec.history;
    if (h.every === undefined) throw new Error('history: every is needed - how often a value: 15m, 1h');
    everyMs = durationMs(h.every);
    if (everyMs < 1000) throw new Error('history: every is 1s at the least');
    if (h.from !== undefined) {
      fromMs = Date.parse(h.from);
      if (!Number.isFinite(fromMs)) throw new Error(`history: from "${h.from}" is not a date (2026-11-16T00:00:00Z)`);
    } else if (h.duration !== undefined) {
      fromMs = nowMs - durationMs(h.duration);
    } else {
      throw new Error('history: from (a date) or duration (7d) is needed');
    }
    if (fromMs >= nowMs) throw new Error('history: it starts in the future - from is before now');
    for (let tm = fromMs; tm < nowMs; tm += everyMs) instants.push(tm);
  }

  const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
  const nowIso = iso(nowMs);
  const entities = [];
  const history = [];
  const counts = {};
  let values = 0;

  for (const [type, T] of byType) {
    const attrs = T.spec.attrs || {};
    if (typeof attrs !== 'object' || Array.isArray(attrs)) throw new Error(`${T.what} (${type}): attrs is an object - {"name": {generator}}`);

    //
    // Each attribute: its maker, checked once
    //
    const makers = [];
    for (const [name, g] of Object.entries(attrs)) {
      const what = `${type}.${name}`;
      if (['id', 'type', '@context', 'scope', 'createdAt', 'modifiedAt', 'deletedAt'].includes(name)) throw new Error(`${what}: ${name} is not an attribute name of one's own`);
      if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error(`${what}: {generator: ...} is needed - one of ${GENERATORS.join(', ')}`);
      const kinds = GENERATORS.filter((k) => g[k] !== undefined);
      if (kinds.length !== 1) throw new Error(`${what}: exactly one generator - one of ${GENERATORS.join(', ')}${kinds.length ? ` (it has ${kinds.join(' and ')})` : ''}`);
      const kind = kinds[0];
      const decimals = g.decimals === undefined ? 2 : num(g.decimals, what + '.decimals');
      const changes = kind === 'range' || kind === 'walk';
      const observedAt = g.observedAt === undefined ? changes : !!g.observedAt;
      const r = rng(hash(seed, type, name));
      let make;                                  // (i) -> the value of entity i now; changing ones: (i) -> [values at instants..., now]

      if (kind === 'value') {
        make = () => g.value;
      } else if (kind === 'pick') {
        if (!Array.isArray(g.pick) || g.pick.length === 0) throw new Error(`${what}: pick is a list of values`);
        const w = g.weights === undefined ? g.pick.map(() => 1) : g.weights;
        if (!Array.isArray(w) || w.length !== g.pick.length || w.some((x) => typeof x !== 'number' || x < 0) || w.reduce((a, b) => a + b, 0) <= 0) throw new Error(`${what}: weights is one number (0 or more) per value of pick`);
        const sum = w.reduce((a, b) => a + b, 0);
        make = () => { let x = r() * sum; for (let k = 0; k < w.length; k++) { x -= w[k]; if (x < 0) return g.pick[k]; } return g.pick[g.pick.length - 1]; };
      } else if (kind === 'text') {
        if (typeof g.text !== 'string') throw new Error(`${what}: text is a template - "Hall {n}", "SN-{n:5}"`);
        make = (i) => g.text.replace(/\{n(?::(\d+))?\}/g, (_, wd) => String(i + 1).padStart(Number(wd || 0), '0')).replace(/\{type\}/g, shortType(type));
      } else if (kind === 'range') {
        if (!Array.isArray(g.range) || g.range.length !== 2) throw new Error(`${what}: range is [min, max]`);
        const [lo, hi] = [num(g.range[0], what + '.range'), num(g.range[1], what + '.range')];
        if (lo > hi) throw new Error(`${what}: range is [min, max] - min first`);
        make = () => { const out = []; for (let k = 0; k <= instants.length; k++) out.push(round(lo + r() * (hi - lo), decimals)); return out; };
      } else if (kind === 'walk') {
        const wk = g.walk;
        if (!wk || typeof wk !== 'object') throw new Error(`${what}: walk is {start, step, min, max}`);
        const step = num(wk.step, what + '.walk.step');
        const lo = wk.min === undefined ? -Infinity : num(wk.min, what + '.walk.min');
        const hi = wk.max === undefined ? Infinity : num(wk.max, what + '.walk.max');
        if (lo > hi) throw new Error(`${what}: walk min is below max`);
        const start = Array.isArray(wk.start) ? [num(wk.start[0], what + '.walk.start'), num(wk.start[1], what + '.walk.start')] : num(wk.start, what + '.walk.start');
        make = () => {
          let v = Array.isArray(start) ? start[0] + r() * (start[1] - start[0]) : start;
          v = Math.min(hi, Math.max(lo, v));
          const out = [round(v, decimals)];
          for (let k = 0; k < instants.length; k++) { v = Math.min(hi, Math.max(lo, v + (r() * 2 - 1) * step)); out.push(round(v, decimals)); }
          return out;
        };
      } else if (kind === 'point') {
        const pm = pointMaker(g.point, what + '.point');
        make = (i) => { const [lon, lat] = pm(r, i, T.count); return { type: 'Point', coordinates: [round(lon, 6), round(lat, 6)] }; };
      } else {
        const to = g.rel;
        if (typeof to !== 'string') throw new Error(`${what}: rel is a type of this spec or an entity id (urn:...)`);
        if (/^urn:/i.test(to)) {
          make = () => to;
        } else {
          const target = byType.get(to);
          if (!target) throw new Error(`${what}: rel ${to} is not a type of this spec (${[...byType.keys()].join(', ')}) - or give an entity id, urn:...`);
          const how = g.how || 'roundRobin';
          if (!['roundRobin', 'group', 'random'].includes(how)) throw new Error(`${what}: how is roundRobin, group or random`);
          const n = target.count;
          make = how === 'roundRobin' ? (i) => target.ids[i % n] : how === 'group' ? (i) => target.ids[Math.floor((i * n) / T.count)] : () => target.ids[Math.floor(r() * n)];
        }
      }
      if (g.unitCode !== undefined && typeof g.unitCode !== 'string') throw new Error(`${what}: unitCode is a UN/CEFACT code - CEL, P1, KWH`);
      makers.push({ name, kind, make, changes, observedAt, unitCode: g.unitCode });
    }

    //
    // The entities, and the history of the changing attributes
    //
    for (let i = 0; i < T.count; i++) {
      const id = T.ids[i];
      const e = { id, type };
      const h = { id, type };                    // the temporal representation (§ 4.5.7): attribute -> its instances
      let changing = 0;
      for (const m of makers) {
        const v = m.make(i);
        let attr;
        if (m.kind === 'point') attr = { type: 'GeoProperty', value: v };
        else if (m.kind === 'rel') attr = { type: 'Relationship', object: v };
        else attr = { type: 'Property', value: m.changes ? v[v.length - 1] : v };
        if (m.unitCode) attr.unitCode = m.unitCode;
        if (m.observedAt) attr.observedAt = nowIso;
        e[m.name] = attr;
        if (m.changes && instants.length) {
          h[m.name] = instants.map((tm, k) => {
            const inst = { type: 'Property', value: v[k], observedAt: iso(tm) };
            if (m.unitCode) inst.unitCode = m.unitCode;
            return inst;
          });
          values += instants.length;
          changing++;
        }
      }
      if (context !== undefined) { e['@context'] = context; h['@context'] = context; }
      entities.push(e);
      if (changing) history.push(h);
    }
    counts[type] = T.count;
    if (values > POPULATE_MAX_VALUES) break;
  }

  if (values > POPULATE_MAX_VALUES) {
    throw new Error(`more than ${POPULATE_MAX_VALUES} history values (entities x changing attributes x instants: ${instants.length} instants) - a shorter history, a longer every, or fewer entities`);
  }
  if (spec.history && history.length === 0) throw new Error('history: no attribute changes - give range or walk attributes, or leave history out');

  return {
    entities, history, counts, instants: instants.length, values,
    from: fromMs === null ? null : iso(fromMs), to: nowIso, everyMs, context,
  };
}
