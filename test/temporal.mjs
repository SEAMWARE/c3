//
// temporal.mjs - the History panel's pure parts (www/js/temporal.js): the next page of a temporal read (the
// Link header's rel="intervalafter"), how values are drawn, an instance's value, the time range, the entity's
// table (a row per instant, the values held) and its CSV
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/temporal.mjs        "temporal: ok", or what failed (exit 1)
//
import { intervalAfter, shapeOf, valueOf, rangeOf, timeline, csvOf, emptyRange } from '../www/js/temporal.js';

let failed = 0;
const eq = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.log(`temporal: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++; }
};

//
// The Link header coraine sends (corNgsild ldTemporalPaginationLinkHeader): ascending (firstN) the later page is
// "intervalafter"; with both, only that one; descending (lastN) the deeper page is "intervalbefore" - no next
//
const p = '/ngsi-ld/v1/temporal/entities/urn:x?attrs=a&timerel=between&timeAt=2026-11-26T00:00:00Z&firstN=1000&';
eq('first page', intervalAfter(`<${p}offsetN=1000>;rel="intervalafter";type="application/json"`), 1000);
eq('middle page', intervalAfter(`<${p}offsetN=0>;rel="intervalbefore";type="application/json", <${p}offsetN=2000>;rel="intervalafter";type="application/json"`), 2000);
eq('last page', intervalAfter(`<${p}offsetN=1000>;rel="intervalbefore";type="application/json"`), null);
eq('the @context Link only', intervalAfter('<https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"'), null);
eq('two Link headers, joined', intervalAfter('<https://x/ctx.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json", ' +
  `<${p}offsetN=3000>;rel="intervalafter";type="application/json"`), 3000);
eq('no Link', intervalAfter(null), null);

eq('numbers', shapeOf([1, 2.5, -3]), 'number');
eq('booleans', shapeOf([true, false]), 'boolean');
eq('strings', shapeOf(['eco', 'boost']), 'category');
eq('mixed', shapeOf([1, 'x']), 'table');
eq('objects', shapeOf([{ type: 'Point', coordinates: [0, 0] }]), 'table');
eq('nulls skipped', shapeOf([null, 3, undefined]), 'number');
eq('nothing', shapeOf([]), 'table');

eq('value', valueOf({ type: 'Property', value: 3 }), 3);
eq('object', valueOf({ type: 'Relationship', object: 'urn:a' }), 'urn:a');
eq('vocab', valueOf({ type: 'VocabProperty', vocab: 'eco' }), 'eco');
eq('false is a value', valueOf({ type: 'Property', value: false }), false);

const now = Date.parse('2026-11-26T12:00:00Z');
eq('preset 24h', rangeOf({ preset: '24h' }, now), { from: now - 86400e3, to: now });
eq('custom', rangeOf({ preset: 'custom', from: 1, to: 2 }, now), { from: 1, to: 2 });

//
// The entity's table: a row per instant any attribute has; a value at its instant is fresh, later ones hold it,
// none before an attribute's first instance; the instants in any order, two at the same instant one row
//
const at = (m) => `2026-11-26T10:${String(m).padStart(2, '0')}:00Z`;
const ms = (m) => Date.parse(at(m));
const series = new Map([
  ['temperature', [{ value: 21, observedAt: at(2) }, { value: 20, observedAt: at(0) }]],
  ['mode', [{ value: 'eco', observedAt: at(1) }, { value: 'boost', observedAt: at(2) }]],
  ['location', []],
]);
const rows = timeline(['temperature', 'mode', 'location'], series, (i) => Date.parse(i.observedAt));
eq('timeline', rows, [
  { t: ms(0), cells: [{ v: 20, fresh: true }, null, null] },
  { t: ms(1), cells: [{ v: 20, fresh: false }, { v: 'eco', fresh: true }, null] },
  { t: ms(2), cells: [{ v: 21, fresh: true }, { v: 'boost', fresh: true }, null] },
]);
eq('timeline, nothing', timeline(['a'], new Map(), () => 0), []);
eq('timeline, false held', timeline(['on'], new Map([['on', [{ value: false, observedAt: at(0) }]]]), (i) => Date.parse(i.observedAt)), [{ t: ms(0), cells: [{ v: false, fresh: true }] }]);

eq('csv', csvOf(['temperature', 'mode', 'location'], rows, 'observedAt'),
  'observedAt,temperature,mode,location\r\n2026-11-26T10:00:00.000Z,20,,\r\n2026-11-26T10:01:00.000Z,20,eco,\r\n2026-11-26T10:02:00.000Z,21,boost,\r\n');
eq('csv quoting', csvOf(['a,b', 'p'], [{ t: ms(0), cells: [{ v: 'say "hi", twice' }, { v: { type: 'Point', coordinates: [1, 2] } }] }]),
  'time,"a,b",p\r\n2026-11-26T10:00:00.000Z,"say ""hi"", twice","{""type"":""Point"",""coordinates"":[1,2]}"\r\n');
eq('csv false', csvOf(['on'], [{ t: ms(0), cells: [{ v: false }] }]), 'time,on\r\n2026-11-26T10:00:00.000Z,false\r\n');

eq('404 ResourceNotFound: empty', emptyRange({ status: 404, body: { type: 'https://uri.etsi.org/ngsi-ld/errors/ResourceNotFound', title: 'Temporal data not found' } }), true);
eq('404 of a broker without the temporal API', emptyRange({ status: 404, body: { error: 'no such path' } }), false);
eq('404 without a body', emptyRange({ status: 404, body: null }), false);
eq('the proxy not reaching the broker', emptyRange({ status: 404, reached: false, body: { type: 'x/ResourceNotFound' } }), false);
eq('200', emptyRange({ status: 200, body: { type: 'x/ResourceNotFound' } }), false);

if (failed) process.exit(1);
console.log('temporal: ok');
