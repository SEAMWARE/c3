//
// temporal.mjs - the History panel's pure parts (www/js/temporal.js): the next page of a temporal read (the
// Link header's rel="intervalafter"), how values are drawn, an instance's value, the time range
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/temporal.mjs        "temporal: ok", or what failed (exit 1)
//
import { intervalAfter, shapeOf, valueOf, rangeOf } from '../www/js/temporal.js';

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

if (failed) process.exit(1);
console.log('temporal: ok');
