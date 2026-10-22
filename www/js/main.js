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
import { Compile } from './compile.js';
import { Run } from './run.js';
import { assistInit } from './assist.js';
import { windowInit } from './window.js';
import { docsShow } from './docs.js';

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

//
// The pages: #compile, #run, #connect and #docs (#docs/<guide>: docs.js), the one shown kept as ui.lastPage
//
const PAGES = ['compile', 'run', 'connect', 'docs'];

function pageShow(page, compile, run) {
  for (const p of PAGES) {
    $('page-' + p).hidden = (p !== page);
    const a = $('nav-' + p);
    a.classList.toggle('active', p === page);
    if (p === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (page === 'compile') compile.refresh();
  if (page === 'run') run.refresh(); else run.hide();
  if (page === 'docs') docsShow(location.hash);
  window.dispatchEvent(new Event('resize'));          // a page shown again measures itself
  api.uiSet({ lastPage: page }).catch(() => {});
}

async function main() {
  const boot = await splash();
  if (!boot) return;

  assistInit();
  windowInit();
  const connect = new Connect();
  connect.setBrokers(boot.config.brokers);

  const compile = new Compile();
  compile.init(boot.config);                          // the choice and the presets; the rest when the page is shown

  //
  // Run: a broker opened in Connect - the list as the backend keeps it now (a started broker is in it)
  //
  const run = new Run({
    onConnect: async (url) => {
      try { connect.setBrokers((await api.config()).brokers || []); } catch (e) { /* the list as it was */ }
      location.hash = '#connect';
      $('broker-url').value = url;
      connect.connect(url);
    },
  });

  //
  // Compile's "Run it": Run, with that build in the form
  //
  window.addEventListener('c3:run', (e) => {
    location.hash = '#run';
    run.preselectBuild(e.detail.build);
  });

  await new Promise((r) => setTimeout(r, 250));
  $('app').hidden = false;
  $('splash').classList.add('leaving');
  setTimeout(() => $('splash').remove(), 400);

  const fromHash = () => PAGES.find((p) => location.hash === '#' + p || location.hash.startsWith('#' + p + '/'));
  const first = fromHash() || (PAGES.includes((boot.config.ui || {}).lastPage) ? boot.config.ui.lastPage : 'connect');
  if (fromHash() !== first) history.replaceState(null, '', '#' + first);
  pageShow(first, compile, run);
  window.addEventListener('hashchange', () => pageShow(fromHash() || 'connect', compile, run));

  // A link to a section of a page (the Documentation page's guides): scrolled to, the page's hash kept
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-scroll]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (boot.last) {
    $('broker-url').value = boot.last.url;
    connect.connect(boot.last.url);
  } else if (first === 'connect') {
    $('broker-url').focus();
  }
}

main();
