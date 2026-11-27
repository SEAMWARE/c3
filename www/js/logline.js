//
// logline.js - a corLog line as an object: what Operate's log shows in its JSON view
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A coraine line (corLog's corLogOut):
//
//   [<UTC time> ]<type>: <uptime>: <file>[<line>]: <function>: <message>[ (T-<trace level>)]
//
// the UTC time on the lines the broker keeps in memory (GET /admin/log/lines), the trace level on T lines. The
// object: time (when there is one), uptime (seconds since the start), type, level (its name), file, line, function,
// message, traceLevel (T lines). Any other line - c3's own, a container's, a message's second line: null.
//
// coraine's log trim (COR_FEATURE_LOG_TRIM) merges repeated lines: the merged one ends " (<n> times, <first uptime> -
// <last uptime>)" - in the object 'repeated': {times, first, last}, out of the message - and says what it did in an
// I line that starts "Log trimmed (" - 'trim': true.
//
const LINE = /^(?:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) )?([A-Z]): (\d+\.\d+): ([^\s\[\]]+)\[(\d+)\]: ([^:\s]+): (.*)$/;
const LEVELS = { E: 'error', W: 'warning', I: 'info', V: 'verbose', T: 'trace', X: 'exit', D: 'debug' };

export function logLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const o = {};
  if (m[1]) o.time = m[1];
  o.uptime = Number(m[3]);
  o.type = m[2];
  o.level = LEVELS[m[2]] || m[2];
  o.file = m[4];
  o.line = Number(m[5]);
  o.function = m[6];
  let msg = m[7];
  const tl = m[2] === 'T' ? / \(T-(\d+)\)$/.exec(msg) : null;
  if (tl) { msg = msg.slice(0, tl.index); o.traceLevel = Number(tl[1]); }
  const rp = / \((\d+) times, (\d+\.\d+) - (\d+\.\d+)\)$/.exec(msg);
  if (rp) { msg = msg.slice(0, rp.index); o.repeated = { times: Number(rp[1]), first: Number(rp[2]), last: Number(rp[3]) }; }
  if (m[2] === 'I' && msg.startsWith('Log trimmed (')) o.trim = true;
  o.message = msg;                                               // last: the object reads as the line does
  return o;
}
