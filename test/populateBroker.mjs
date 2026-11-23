//
// populateBroker.mjs - AI Assist's populate_broker end to end: the page's command (www/js/c3tools.js) run under node,
// through a real c3's proxy, into real brokers - one keeping temporal history, one not (test/populateBroker.sh
// starts them)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/populateBroker.mjs <c3 URL> <broker with history> <broker without>
//
import { c3Tools } from '../www/js/c3tools.js';

const [C3, HIST, PLAIN] = process.argv.slice(2);
let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log('populateBroker: FAIL - ' + what); } };

//
// The page's fetch: relative URLs to c3, with the Origin a browser sends on c3's own page
//
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(C3 + url, { ...init, headers: { ...(init.headers || {}), Origin: C3 } });

//
// The broker straight, not through c3: what is really there
//
const broker = async (base, path, tenant) => {
  const r = await realFetch(base + path, { headers: tenant ? { 'NGSILD-Tenant': tenant } : {} });
  return { status: r.status, count: r.headers.get('NGSILD-Results-Count'), body: r.status === 200 ? await r.json() : null };
};
const count = async (base, type, tenant) => Number((await broker(base, `/ngsi-ld/v1/entities?type=${type}&count=true&limit=0`, tenant)).count);

let answer = true;
const asked = [];
const said = [];
const connect = { broker: HIST, tenant: '', entities: [], loadedKinds: new Map(), picks: [], hidden: new Set(), highlighted: new Set(), graph: {}, emap: {} };
const tools = c3Tools(connect, { confirm: async (c) => { asked.push(c); return answer; }, progress: (s) => said.push(s) });

const SPEC = {
  seed: 3,
  history: { duration: '1d', every: '1h' },
  types: [
    { type: 'Building', count: 4, idPrefix: 'hall', attrs: { name: { text: 'Hall {n}' }, location: { point: { bbox: [-3.71, 40.41, -3.69, 40.43] } } } },
    { type: 'Device', count: 150, attrs: {
      temperature: { walk: { start: 21, step: 0.4, min: 15, max: 35 }, unitCode: 'CEL', decimals: 1 },
      status: { pick: ['ok', 'maintenance'] },
      refBuilding: { rel: 'Building', how: 'group' },
    } },
  ],
};

// 1. Declined: nothing written
answer = false;
let r = await tools.run('populate_broker', SPEC);
check(r.ok && /declined/.test(r.text) && r.n === undefined, `declined: ${JSON.stringify(r)}`);
check(await count(HIST, 'Device') === 0, 'declined: no Device written');
check(asked.length === 1 && /154 entities/.test(asked[0].title) && asked[0].lines.some((l) => /History: 3,600 values - 24 instants/.test(l)) && asked[0].lines.some((l) => /Building: 4 · Device: 150/.test(l)), `the confirm dialog: ${JSON.stringify(asked[0] && { title: asked[0].title, lines: asked[0].lines.slice(0, 3) })}`);

// 2. Yes: the entities (two batches of 100 for Device) and their history
answer = true;
said.length = 0;
r = await tools.run('populate_broker', SPEC);
check(r.ok && /created 154 entities/.test(r.text) && /history: 3600 values/.test(r.text) && r.n > 0, `populated: ${JSON.stringify(r)}`);
const populated = r.n;
check(await count(HIST, 'Device') === 150 && await count(HIST, 'Building') === 4, 'the broker holds 150 Devices and 4 Buildings');
check(said.some((s) => /Creating the entities: 100 of 154/.test(s)) && said.some((s) => /Writing the history: 150 of 150/.test(s)), `progress said: ${JSON.stringify(said)}`);
const d1 = (await broker(HIST, '/ngsi-ld/v1/entities/urn:ngsi-ld:Device:device-001')).body;
check(d1 && d1.refBuilding.object === 'urn:ngsi-ld:Building:hall-001' && d1.temperature.unitCode === 'CEL', `device-001: ${JSON.stringify(d1)}`);
const tq = '/ngsi-ld/v1/temporal/entities/urn:ngsi-ld:Device:device-150?attrs=temperature&timerel=after&timeAt=2000-01-01T00:00:00Z';
let th = (await broker(HIST, tq)).body;
const inst = th ? [].concat(th.temperature || []) : [];
check(inst.length >= 24, `device-150's temperature history: ${inst.length} instances (24 written + the current state's)`);
const times = inst.map((x) => Date.parse(x.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
check(times.length >= 24 && times[times.length - 1] - times[0] >= 23 * 3600000, 'the history spans the day');

// 3. The same again: refused, nothing overwritten
r = await tools.run('populate_broker', SPEC);
check(!r.ok && /154 of these ids are already in/.test(r.text), `again: ${JSON.stringify(r)}`);

// 4. Undo: the entities and their history gone
const undone = await tools.undoTo(populated);
check(undone.length === 1 && /154 entities deleted, and their history/.test(undone[0]), `undo said ${JSON.stringify(undone)}`);
check(await count(HIST, 'Device') === 0 && await count(HIST, 'Building') === 0, 'undo: no Device or Building left');
th = await broker(HIST, tq);
check(th.status === 404, `undo: device-150's history gone (GET answered ${th.status})`);

// 5. A broker without temporal history: history refused, saying why; without history fine; another tenant
connect.broker = PLAIN;
r = await tools.run('populate_broker', SPEC);
check(!r.ok && /keeps no temporal history \(--troe none\)/.test(r.text), `no history on --troe none: ${JSON.stringify(r)}`);
check(await count(PLAIN, 'Device') === 0, 'no history: nothing written');
r = await tools.run('populate_broker', { ...SPEC, history: undefined, tenant: 'pop' });
check(r.ok && /created 154 entities in pop/.test(r.text), `without history, tenant pop: ${JSON.stringify(r)}`);
check(await count(PLAIN, 'Device', 'pop') === 150 && await count(PLAIN, 'Device') === 0, 'the 150 Devices in tenant pop, none in the default tenant');

// 6. A spec error comes back as the model's error, nothing asked
asked.length = 0;
r = await tools.run('populate_broker', { types: [{ type: 'A', count: 2, attrs: { r: { rel: 'Nowhere' } } }] });
check(!r.ok && /not a type of this spec/.test(r.text) && asked.length === 0, `spec error: ${JSON.stringify(r)}`);

if (failed) { console.log(`populateBroker: ${failed} failed`); process.exit(1); }
console.log('populateBroker: ok');
