//
// focus.mjs - AI Assist's focus (www/js/c3tools.js) under node: it zooms the view the user is on - the graph or the
// map - and never switches between them (the gap reported 11-27: map_focus turned the graph into the map)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/focus.mjs        "focus: ok", or what failed (exit 1)
//
import { c3Tools } from '../www/js/c3tools.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log('focus: FAIL - ' + what); } };

globalThis.location = { hash: '#connect' };
const calls = [];
const connect = {
  broker: 'http://localhost:1026', tenant: '', view: 'graph', entities: [], byId: new Map(),
  loadedKinds: new Map(), picks: [], hidden: new Set(), highlighted: new Set(),
  typeColours: () => ({}), colourBy: 'type',
  setView: async (v) => { calls.push(['setView', v]); connect.view = v; },
  graph: { sel: null, nodes: new Map([['a', {}], ['b', {}]]), fit: (ids) => calls.push(['graph.fit', ids]) },
  emap: { ready: Promise.resolve(), labelAttr: null, has: (id) => id === 'a', fit: (anim, ids) => calls.push(['map.fit', ids]) },
};
const tools = c3Tools(connect, {});
const run = async (args) => { calls.length = 0; return tools.run('focus', args); };

check(!tools.definitions.some((d) => d.name === 'map_focus'), 'map_focus is gone');

// On the graph: the graph fits, the view stays the graph
let r = await run({});
check(r.ok && connect.view === 'graph' && JSON.stringify(calls) === JSON.stringify([['graph.fit', null]]), `graph, all: ${JSON.stringify(calls)} ${r.text}`);
r = await run({ ids: ['a', 'zz'] });
check(r.ok && JSON.stringify(calls) === JSON.stringify([['graph.fit', ['a']]]) && /1 of them/.test(r.text), `graph, some: ${JSON.stringify(calls)} ${r.text}`);
r = await run({ ids: ['zz'] });
check(calls.length === 0 && /none of them is in it/.test(r.text), `graph, none there: ${r.text}`);

// On the map: the map fits, the view stays the map
connect.view = 'map';
r = await run({});
check(r.ok && connect.view === 'map' && JSON.stringify(calls) === JSON.stringify([['map.fit', null]]), `map, all: ${JSON.stringify(calls)}`);
r = await run({ ids: ['b'] });
check(calls.length === 0 && /none of them is on it/.test(r.text), `map, not on it: ${r.text}`);

check(!calls.some((c) => c[0] === 'setView'), 'never switched the view');
if (failed) process.exit(1);
console.log('focus: ok');
