//
// main.js - the shell: the splash screen while the backend gets ready, then the application
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Each step of the splash is a real request, shown as it completes - not a timer.
//
import * as api from './api.js';
import { brokerGet } from './api.js';
import { Connect } from './connect.js';

const $ = (id) => document.getElementById(id);

function stepRow(label) {
  const row = document.createElement('div');
  row.className = 'step';
  const mark = document.createElement('span');
  mark.className = 'mark';
  const text = document.createElement('span');
  text.textContent = label;
  const detail = document.createElement('span');
  detail.className = 'detail';
  row.append(mark, text, detail);
  $('steps').append(row);
  return {
    now() { row.className = 'step now'; },
    done(kind, d) {
      row.className = 'step ' + kind;
      mark.textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '×';
      detail.textContent = d || '';
    },
  };
}

async function splash() {
  const labels = ['c³ backend', 'Configuration', 'Last broker'];
  const steps = labels.map(stepRow);
  const bar = $('splash-bar');
  const progress = (i) => { bar.style.width = Math.round(100 * i / labels.length) + '%'; };

  // 1 - the backend
  steps[0].now();
  let status;
  try {
    status = await api.status();
  } catch (e) {
    steps[0].done('fail', 'no answer');
    const err = $('splash-error');
    err.hidden = false;
    err.textContent = 'The c³ backend does not answer: ' + e.message + '. Start it again with c3.';
    return null;
  }
  $('splash-version').textContent = status.c3;
  steps[0].done('ok', 'port ' + status.port);
  progress(1);

  // 2 - the configuration
  steps[1].now();
  let config = { brokers: [], ui: {} };
  try {
    config = await api.config();
    const n = (config.brokers || []).length;
    steps[1].done(status.configError ? 'warn' : 'ok', status.configError ? 'see the console' : n + ' broker' + (n === 1 ? '' : 's'));
    if (status.configError) console.warn('c3:', status.configError);
  } catch (e) {
    steps[1].done('warn', 'not read');
  }
  progress(2);

  // 3 - the last broker connected to, if any
  steps[2].now();
  const last = (config.brokers || [])[0];
  let lastReachable = false;
  if (!last) {
    steps[2].done('ok', 'none yet');
  } else {
    //
    // At most 3 seconds here: a host that does not answer at all would otherwise hold the splash for the
    // proxy's whole timeout - Connect then shows how the load ends
    //
    const r = await Promise.race([
      brokerGet(last.url, '/version'),
      new Promise((done) => setTimeout(() => done({ ok: false, reached: true, timeout: true }), 3000)),
    ]);
    lastReachable = r.ok;
    if (r.ok && r.body && r.body.product) steps[2].done('ok', `${r.body.product} ${r.body.version || ''}`.trim());
    else if (r.ok) steps[2].done('ok', 'reachable');
    else if (r.timeout) steps[2].done('warn', 'no answer yet');
    else steps[2].done('warn', r.reached ? 'answered ' + r.status : 'not reachable');
  }
  progress(3);

  return { status, config, last, lastReachable };
}

async function main() {
  const boot = await splash();
  if (!boot) return;

  const connect = new Connect();
  connect.setBrokers(boot.config.brokers);

  await new Promise((r) => setTimeout(r, 250));
  $('app').hidden = false;
  $('splash').classList.add('leaving');
  setTimeout(() => $('splash').remove(), 400);

  api.uiSet({ lastPage: 'connect' }).catch(() => {});

  if (boot.last) {
    $('broker-url').value = boot.last.url;
    connect.connect(boot.last.url);
  } else {
    $('broker-url').focus();
  }
}

main();
