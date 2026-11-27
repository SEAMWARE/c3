//
// metrics.mjs - Operate's Metrics (www/js/metrics.js) under node: every metric family a coraine serves is drawn
// by a chart (test/data/coraine-metrics.txt, a coraine 0.7's GET /admin/metrics), one it does not know goes to
// Other, and an operation chart has a series per operation, its rate
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/metrics.mjs        "metrics: ok", or what failed (exit 1)
//
import { readFileSync } from 'node:fs';
import { parse, CHARTS, seriesOf } from '../www/js/metrics.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log('metrics: FAIL - ' + what); } };

const text = readFileSync(new URL('./data/coraine-metrics.txt', import.meta.url), 'utf8');
const v0 = parse(text);
const chart = (title) => CHARTS.find((c) => c.title === title);

// Every family served: drawn by a chart that is not Other - Other is empty for a coraine c3 knows
const a = { t: 0, v: v0 }, b = { t: 5000, v: new Map(v0) };
check(seriesOf(chart('Other'), [a, b]).length === 0, 'Other: ' + seriesOf(chart('Other'), [a, b]).map((x) => x.label).join(', '));
const families = new Set(text.split('\n').filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]));
check(families.size === 69, 'the fixture: ' + families.size + ' families');

// The entity operations: one series per counter, its rate - 10 creates in 5 s = 2/s
b.v.set('ngsild_entity_create_total', v0.get('ngsild_entity_create_total') + 10);
const ents = seriesOf(chart('Entity operations'), [a, b]);
const opsServed = [...families].filter((f) => /^ngsild_(entity|attr)_[a-z_]+_total$/.test(f)).length;   // 18 in the fixture
check(ents.length === opsServed && opsServed === 18, 'entity operations: ' + ents.length + ' series, ' + opsServed + ' served');
const create = ents.find((x) => x.label === 'entity create');
check(create && create.f(a, b) === 2, 'entity create: ' + (create && create.f(a, b)));
check(new Set(ents.map((x) => x.cls)).size === 8, 'colours cycle through 8: ' + [...new Set(ents.map((x) => x.cls))]);

// One it does not know: in Other - a counter as its rate, a gauge as it is
b.v.set('ngsild_widgets_total', 50); a.v = new Map(v0); a.v.set('ngsild_widgets_total', 40);
b.v.set('ngsild_queue_depth', 7);
const other = seriesOf(chart('Other'), [a, b]);
const w = other.find((x) => x.label === 'widgets/s'), q = other.find((x) => x.label === 'queue depth');
check(w && w.f(a, b) === 2, 'an unknown counter: ' + JSON.stringify(other.map((x) => x.label)));
check(q && q.f(a, b) === 7, 'an unknown gauge: ' + (q && q.f(a, b)));

if (failed) process.exit(1);
console.log('metrics: ok');
