//
// showHistory.mjs - AI Assist's show_history (www/js/c3tools.js) run under node: what it asks of Explore's History
// panel (www/js/temporal.js) - which entity, attribute view or entity view, the ticks, the range, the view - with a
// recording stand-in for the panel; an entity not loaded read from the broker (fetch stubbed)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/showHistory.mjs        "showHistory: ok", or what failed (exit 1)
//
import { c3Tools } from '../www/js/c3tools.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log('showHistory: FAIL - ' + what); } };

globalThis.location = { hash: '#operate' };
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(url);
  const known = url.includes(encodeURIComponent('urn:ngsi-ld:Machine:press1'));
  const body = known ? { id: 'urn:ngsi-ld:Machine:press1', type: 'Machine', power: { type: 'Property', value: 41 } } : { type: 'ResourceNotFound' };
  return { ok: known, status: known ? 200 : 404, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
};

const r101 = {
  id: 'urn:ngsi-ld:Room:r101', type: 'Room',
  temperature: { type: 'Property', value: 20.6 }, occupied: { type: 'Property', value: true }, hvacMode: { type: 'Property', value: 'eco' },
};

let calls;
const temporal = {
  ticks: null, view: 'graph', range: null,
  saveRange(r) { calls.push(['range', r]); this.range = r; },
  open(e, attr) { calls.push(['open', e.id, attr]); },
  openEntity(e) { calls.push(['entity', e.id, this.ticks && this.ticks.id === e.id ? this.ticks.attrs : null]); },
  render() { calls.push(['render', this.view]); },
};
const connect = {
  broker: 'http://localhost:1026', tenant: '', entities: [r101], byId: new Map([[r101.id, r101]]),
  loadedKinds: new Map(), picks: [], hidden: new Set(), highlighted: new Set(), graph: {}, emap: {}, temporal,
};
const tools = c3Tools(connect, {});
const run = async (args) => { calls = []; temporal.view = 'graph'; return tools.run('show_history', args); };

// One attribute: that attribute's History, the preset kept, Explore shown
let r = await run({ id: r101.id, attrs: ['temperature'], preset: '7d' });
check(r.ok, `one attribute: ${r.text}`);
check(JSON.stringify(calls) === JSON.stringify([['range', { preset: '7d' }], ['open', r101.id, 'temperature']]), `one attribute: ${JSON.stringify(calls)}`);
check(location.hash === '#connect', 'Explore shown');
check(/History of temperature of urn:ngsi-ld:Room:r101, the last 7d, as a graph/.test(r.text), `one attribute, the answer: ${r.text}`);

// Several: the entity's History with those ticked, a custom range, as a table
r = await run({ id: r101.id, attrs: ['temperature', 'occupied'], from: '2026-11-26T00:00:00Z', to: '2026-11-27T00:00:00Z', view: 'table' });
check(r.ok, `several: ${r.text}`);
check(JSON.stringify(calls) === JSON.stringify([
  ['range', { preset: 'custom', from: Date.parse('2026-11-26T00:00:00Z'), to: Date.parse('2026-11-27T00:00:00Z') }],
  ['entity', r101.id, ['temperature', 'occupied']],
  ['render', 'table'],
]), `several: ${JSON.stringify(calls)}`);

// None: the entity's History as the panel ticks it, the range the user had
temporal.ticks = null;
r = await run({ id: r101.id });
check(r.ok && JSON.stringify(calls) === JSON.stringify([['entity', r101.id, null]]) && /the range the user had/.test(r.text), `none: ${JSON.stringify(calls)} ${r.text}`);

// An attribute it has not: said; one of several it has not: the others shown, that one said
r = await run({ id: r101.id, attrs: ['humidity'] });
check(!r.ok && /has none of humidity - it has temperature, occupied, hvacMode/.test(r.text) && calls.length === 0, `no such attribute: ${r.text}`);
r = await run({ id: r101.id, attrs: ['temperature', 'humidity'] });
check(r.ok && /has no humidity/.test(r.text) && calls.some((c) => c[0] === 'open' && c[2] === 'temperature'), `one unknown of two: ${r.text}`);

// A bad range: nothing opened
r = await run({ id: r101.id, from: '2026-11-27T00:00:00Z', to: '2026-11-26T00:00:00Z' });
check(!r.ok && /from before to/.test(r.text) && calls.length === 0, `from after to: ${r.text}`);

// Not loaded: read from the broker; not in the broker either: said
r = await run({ id: 'urn:ngsi-ld:Machine:press1', attrs: ['power'] });
check(r.ok && calls.some((c) => c[0] === 'open' && c[1] === 'urn:ngsi-ld:Machine:press1' && c[2] === 'power'), `not loaded: ${r.text}`);
check(fetched.some((u) => u.includes('/api/proxy/ngsi-ld/v1/entities/' + encodeURIComponent('urn:ngsi-ld:Machine:press1'))), `not loaded, read through the proxy: ${fetched}`);
r = await run({ id: 'urn:ngsi-ld:Machine:nope' });
check(!r.ok && /no entity urn:ngsi-ld:Machine:nope in the broker/.test(r.text), `not anywhere: ${r.text}`);

if (failed) process.exit(1);
console.log('showHistory: ok');
