//
// populate.mjs - populateGenerate (www/js/populate.js), the generator of AI Assist's populate_broker: counts, ids,
// determinism, relationship targets, geometry, history order and size, caps, spec errors
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/populate.mjs        "populate: ok", or what failed (exit 1)
//
import { populateGenerate, durationMs, POPULATE_MAX_ENTITIES, POPULATE_MAX_VALUES } from '../www/js/populate.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log('populate: FAIL - ' + what); } };
const throws = (fn, re, what) => {
  try { fn(); check(false, `${what}: no error`); } catch (e) { check(re.test(e.message), `${what}: "${e.message}" does not match ${re}`); }
};

const NOW = new Date('2026-11-23T12:00:00Z');
const HALL = [[-3.70, 40.41], [-3.69, 40.41], [-3.69, 40.42], [-3.70, 40.42]];
const spec = {
  seed: 7,
  history: { duration: '1d', every: '1h' },
  types: [
    { type: 'Device', count: 30, attrs: {
      temperature: { walk: { start: [18, 22], step: 0.5, min: 15, max: 35 }, unitCode: 'CEL', decimals: 1 },
      load: { range: [0, 100], decimals: 0 },
      status: { pick: ['ok', 'maintenance'], weights: [9, 1] },
      refBuilding: { rel: 'Building', how: 'group' },
      location: { point: { polygon: HALL } },
      serialNumber: { text: 'SN-{n:5}' },
      category: { value: ['sensor'] },
    } },
    { type: 'Building', count: 4, idPrefix: 'hall', attrs: {
      name: { text: '{type} {n}' },
      location: { point: { line: [[-3.70, 40.40], [-3.68, 40.40]] } },
    } },
  ],
};

const a = populateGenerate(spec, NOW);
const b = populateGenerate(spec, NOW);

// Counts and ids
check(a.entities.length === 34, `34 entities, got ${a.entities.length}`);
check(a.counts.Device === 30 && a.counts.Building === 4, `counts ${JSON.stringify(a.counts)}`);
check(a.entities[0].id === 'urn:ngsi-ld:Device:device-001', `first id ${a.entities[0].id}`);
check(a.entities[30].id === 'urn:ngsi-ld:Building:hall-001', `first Building id ${a.entities[30].id}`);
check(new Set(a.entities.map((e) => e.id)).size === 34, 'ids unique');

// Determinism: the same spec, seed and now - the same data; another seed - other data
check(JSON.stringify(a) === JSON.stringify(b), 'same spec + seed + now: same data');
const c = populateGenerate({ ...spec, seed: 8 }, NOW);
check(JSON.stringify(a.entities) !== JSON.stringify(c.entities), 'another seed: other data');
const d = populateGenerate({ ...spec, types: [...spec.types, { type: 'Extra', count: 2, attrs: { x: { range: [0, 1] } } }] }, NOW);
check(JSON.stringify(d.entities.slice(0, 34)) === JSON.stringify(a.entities), 'a type added leaves the others as they were');

// Attributes
const dev = a.entities.filter((e) => e.type === 'Device');
const halls = new Set(a.entities.filter((e) => e.type === 'Building').map((e) => e.id));
check(dev.every((e) => halls.has(e.refBuilding.object) && e.refBuilding.type === 'Relationship'), 'every refBuilding points to a generated Building');
check(dev.slice(0, 8).every((e) => e.refBuilding.object === 'urn:ngsi-ld:Building:hall-001') && dev[29].refBuilding.object === 'urn:ngsi-ld:Building:hall-004', 'how group: contiguous blocks');
check(dev.every((e) => e.temperature.value >= 15 && e.temperature.value <= 35 && e.temperature.unitCode === 'CEL' && e.temperature.observedAt === '2026-11-23T12:00:00Z'), 'temperature within min..max, unitCode, observedAt now');
check(dev.every((e) => Number.isInteger(e.load.value) && e.load.value >= 0 && e.load.value <= 100), 'load: whole numbers in range');
check(dev.every((e) => ['ok', 'maintenance'].includes(e.status.value) && e.status.observedAt === undefined), 'status picked, no observedAt');
check(dev.filter((e) => e.status.value === 'ok').length > 20, 'weights 9:1 - most are ok');
check(dev[0].serialNumber.value === 'SN-00001' && dev[29].serialNumber.value === 'SN-00030', 'text template {n:5}');
check(a.entities[31].name.value === 'Building 2', 'text template {type} {n}');
check(dev.every((e) => { const [x, y] = e.location.value.coordinates; return e.location.type === 'GeoProperty' && x >= -3.70 && x <= -3.69 && y >= 40.41 && y <= 40.42; }), 'points inside the polygon');
const line = a.entities.filter((e) => e.type === 'Building').map((e) => e.location.value.coordinates);
check(line[0][0] === -3.7 && line[3][0] === -3.68 && line.every((p) => p[1] === 40.4), `points spread along the line ${JSON.stringify(line)}`);

// History: 24 instants of 1h before now, oldest first, ending before the current state
check(a.instants === 24 && a.from === '2026-11-22T12:00:00Z', `24 instants from 2026-11-22T12:00:00Z, got ${a.instants} from ${a.from}`);
check(a.values === 30 * 2 * 24, `values 1440, got ${a.values}`);
check(a.history.length === 30 && a.history.every((h) => Object.keys(h).join() === 'id,type,temperature,load'), 'history: the 30 Devices as temporal representations - id, type, temperature and load');
const ordered = a.history.every((h) => [h.temperature, h.load].every((v) => v.every((x, k) => k === 0 || Date.parse(x.observedAt) > Date.parse(v[k - 1].observedAt)) && Date.parse(v[v.length - 1].observedAt) < NOW.getTime()));
check(ordered, 'history oldest first, every instant before now');
const walkSteps = a.history.every((h, i) => { const v = h.temperature.map((x) => x.value).concat(dev[i].temperature.value); return v.every((x, k) => k === 0 || Math.abs(x - v[k - 1]) <= 0.5 + 1e-9); });
check(walkSteps, 'walk: no step larger than step, the current value continuing the history');

// Durations
check(durationMs('15m') === 900000 && durationMs('P7D') === 604800000 && durationMs('PT1H30M') === 5400000 && durationMs('1w') === 604800000, 'durations');
throws(() => durationMs('soon'), /not a duration/, 'a bad duration');

// Caps
throws(() => populateGenerate({ types: [{ type: 'A', count: POPULATE_MAX_ENTITIES + 1, attrs: {} }] }, NOW), new RegExp(`at most ${POPULATE_MAX_ENTITIES}`), 'entities cap');
throws(() => populateGenerate({ history: { duration: '30d', every: '1m' }, types: [{ type: 'A', count: 10, attrs: { v: { range: [0, 1] } } }] }, NOW), new RegExp(`more than ${POPULATE_MAX_VALUES}`), 'history values cap');
check(populateGenerate({ types: [{ type: 'A', count: POPULATE_MAX_ENTITIES, attrs: { v: { range: [0, 1] } } }] }, NOW).entities.length === POPULATE_MAX_ENTITIES, 'exactly the cap is fine');

// Spec errors say what is wrong
throws(() => populateGenerate({ types: [{ type: 'A', count: 1, attrs: { r: { rel: 'Nowhere' } } }] }, NOW), /not a type of this spec/, 'rel to an unknown type');
throws(() => populateGenerate({ types: [{ type: 'A', count: 1, attrs: { x: { range: [0, 1], pick: [1] } } }] }, NOW), /exactly one generator/, 'two generators');
throws(() => populateGenerate({ types: [{ type: 'A', count: 1, attrs: { p: { point: { bbox: [-3.6, 40.4, -3.7, 40.5] } } } }] }, NOW), /west below east/, 'bbox west of east');
throws(() => populateGenerate({ types: [{ type: 'A', count: 1, attrs: { p: { point: { bbox: [-3.7, 95, -3.6, 96] } } } }] }, NOW), /longitude first/, 'latitude out of range');
throws(() => populateGenerate({ types: [{ type: 'A', count: 0, attrs: {} }] }, NOW), /count is a whole number/, 'count 0');
throws(() => populateGenerate({ types: [{ type: 'A', count: 1 }, { type: 'A', count: 1 }] }, NOW), /twice/, 'a type twice');
throws(() => populateGenerate({ history: { every: '1h' }, types: [{ type: 'A', count: 1, attrs: { v: { range: [0, 1] } } }] }, NOW), /from .* or duration/, 'history without from or duration');
throws(() => populateGenerate({ history: { duration: '1d', every: '1h' }, types: [{ type: 'A', count: 1, attrs: { v: { value: 1 } } }] }, NOW), /no attribute changes/, 'history with nothing changing');
throws(() => populateGenerate({ types: [{ type: 'A', count: 1, attrs: { id: { value: 1 } } }] }, NOW), /not an attribute name/, 'id as an attribute');

// A context goes on every entity and history entry
const ctx = populateGenerate({ context: 'https://example.org/ctx.jsonld', history: { duration: '2h', every: '1h' }, types: [{ type: 'A', count: 2, attrs: { v: { range: [0, 1] } } }] }, NOW);
check(ctx.entities.every((e) => e['@context'] === 'https://example.org/ctx.jsonld') && ctx.history.every((h) => h['@context'] === 'https://example.org/ctx.jsonld'), '@context on every entity and history entry');

if (failed) { console.log(`populate: ${failed} failed`); process.exit(1); }
console.log('populate: ok');
