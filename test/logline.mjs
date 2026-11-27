//
// logline.mjs - a corLog line as an object (www/js/logline.js), Operate's log in its JSON view
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
//   node test/logline.mjs        "logline: ok", or what failed (exit 1)
//
import { logLine } from '../www/js/logline.js';

let failed = 0;
const same = (line, want) => {
  const got = logLine(line);
  if (JSON.stringify(got) !== JSON.stringify(want)) { failed++; console.log('logline: FAIL - ' + line + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
};

// From the file (or stdout): no UTC time
same('E: 000011.438: getEntity.c[983]: entityRetrieve: 404 Entity not found: entity \'urn:x:1\' not found',
  { uptime: 11.438, type: 'E', level: 'error', file: 'getEntity.c', line: 983, function: 'entityRetrieve', message: '404 Entity not found: entity \'urn:x:1\' not found' });

// From memory (GET /admin/log/lines): the UTC time first
same('2026-11-27T14:57:53.589Z V: 016380.383: corRestBackendMhd.c[480]: mhdConnectionHandler: Request: GET /version',
  { time: '2026-11-27T14:57:53.589Z', uptime: 16380.383, type: 'V', level: 'verbose', file: 'corRestBackendMhd.c', line: 480, function: 'mhdConnectionHandler', message: 'Request: GET /version' });

// A trace: its level out of the message
same('T: 000002.001: ldRegCache.c[77]: regCacheMatch: 2 matches [a, b] (T-210)',
  { uptime: 2.001, type: 'T', level: 'trace', file: 'ldRegCache.c', line: 77, function: 'regCacheMatch', traceLevel: 210, message: '2 matches [a, b]' });

// A warning; "(T-n)" on a line that is not a trace stays in the message
same('W: 000100.000: x.c[1]: f: odd (T-5)', { uptime: 100, type: 'W', level: 'warning', file: 'x.c', line: 1, function: 'f', message: 'odd (T-5)' });

// An empty message
same('I: 000001.000: main.c[12]: main: ', { uptime: 1, type: 'I', level: 'info', file: 'main.c', line: 12, function: 'main', message: '' });

// A line merged by coraine's log trim: the count and the first and last uptime out of the message
same('W: 000002.088: getEntity.c[983]: entityRetrieve: 404 Entity not found: entity \'urn:x:2\' not found (5 times, 000002.016 - 000002.088)',
  { uptime: 2.088, type: 'W', level: 'warning', file: 'getEntity.c', line: 983, function: 'entityRetrieve',
    repeated: { times: 5, first: 2.016, last: 2.088 }, message: '404 Entity not found: entity \'urn:x:2\' not found' });

// The trim's own line: marked
same('I: 000002.248: logTrim.c[1034]: trimSay: Log trimmed (request): dropped V 16; 13 repeated lines merged',
  { uptime: 2.248, type: 'I', level: 'info', file: 'logTrim.c', line: 1034, function: 'trimSay', trim: true, message: 'Log trimmed (request): dropped V 16; 13 repeated lines merged' });

// "Log trimmed (" in a line that is not I: not the trim's
same('W: 000003.000: x.c[1]: f: Log trimmed (no)', { uptime: 3, type: 'W', level: 'warning', file: 'x.c', line: 1, function: 'f', message: 'Log trimmed (no)' });

// Not corLog's: null - c3's own lines, a container's, a message's second line, nothing
for (const l of ["c3: coraine start 'x'", '  at line two of a message', '', 'E: no uptime here', '2026-11-27T14:57:53Z hello'])
  same(l, null);

if (failed) process.exit(1);
console.log('logline: ok');
