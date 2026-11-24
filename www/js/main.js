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
import { Dashboard } from './dashboard.js';
import { assistInit } from './assist.js';
import { windowInit } from './window.js';
import { headerInit } from './header.js';
import { docsInit, docsShow } from './docs.js';
import { i18nInit, t, plural, LANGUAGES, language, setLanguage } from './i18n.js';
import { openMenu } from './menu.js';

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
  const labels = [t('c³ backend'), t('Configuration'), t('Last broker')];
  const steps = labels.map(stepRow);
  const bar = $('splash-bar');
  const progress = (i) => { bar.style.width = Math.round(100 * i / labels.length) + '%'; };

  // 1 - the backend
  steps[0].now();
  let status;
  try {
    status = await api.status();
  } catch (e) {
    steps[0].done('fail', t('no answer'));
    const err = $('splash-error');
    err.hidden = false;
    err.textContent = t('The c³ backend does not answer: {error}. Start it again with c3.', { error: e.message });
    return null;
  }
  $('splash-version').textContent = status.c3;
  steps[0].done('ok', t('port {port}', { port: status.port }));
  progress(1);

  // 2 - the configuration
  steps[1].now();
  let config = { brokers: [], ui: {} };
  try {
    config = await api.config();
    const n = (config.brokers || []).length;
    steps[1].done(status.configError ? 'warn' : 'ok', status.configError ? t('see the console') : plural(n, '{n} broker', '{n} brokers'));
    if (status.configError) console.warn('c3:', status.configError);
  } catch (e) {
    steps[1].done('warn', t('not read'));
  }
  progress(2);

  // 3 - the last broker connected to, if any
  steps[2].now();
  const last = (config.brokers || [])[0];
  let lastReachable = false;
  if (!last) {
    steps[2].done('ok', t('none yet'));
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
    else if (r.ok) steps[2].done('ok', t('reachable'));
    else if (r.timeout) steps[2].done('warn', t('no answer yet'));
    else steps[2].done('warn', r.reached ? t('answered {status}', { status: r.status }) : t('not reachable'));
  }
  progress(3);

  return { status, config, last, lastReachable };
}

//
// The pages: #compile, #run, #connect, #dashboard and #docs (#docs/<guide>: docs.js), the one shown kept as ui.lastPage
//
const PAGES = ['compile', 'run', 'connect', 'dashboard', 'docs'];

function pageShow(page, compile, run, dashboard) {
  for (const p of PAGES) {
    $('page-' + p).hidden = (p !== page);
    const a = $('nav-' + p);
    a.classList.toggle('active', p === page);
    if (p === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (page === 'compile') compile.refresh();
  if (page === 'run') run.refresh(); else run.hide();
  if (page === 'dashboard') dashboard.refresh(); else dashboard.hide();
  if (page === 'docs') docsShow(location.hash);
  window.dispatchEvent(new Event('resize'));          // a page shown again measures itself
  api.uiSet({ lastPage: page }).catch(() => {});
}

//
// The language button: the four languages, the one in use checked
//
function languageButton() {
  const b = $('lang-btn');
  const flag = document.createElement('img');
  flag.src = `img/flags/${language()}.svg`;
  flag.alt = '';
  b.replaceChildren(flag);
  b.title = b.ariaLabel = `${t('Language')}: ${LANGUAGES[language()]}`;
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect();
    openMenu({
      x: r.left, y: r.bottom + 4, label: t('Language'), returnFocus: b,
      items: Object.entries(LANGUAGES).map(([code, name]) => ({ icon: `img/flags/${code}.svg`, label: name + (code === language() ? '  ✓' : ''), action: () => setLanguage(code) })),
    });
  });
}

//
// The text size: c³'s text in percent of its own (its sizes are in rem: the root's size scales them all), kept in
// c3.json as ui.textSize - and in this browser too, so a page opened again starts at it before the config comes
//
const TEXT_SIZES = ['90', '100', '115', '130', '150', '175', '200'];

function textSizeApply(size) {
  if (!TEXT_SIZES.includes(size)) size = '100';
  document.documentElement.style.fontSize = size === '100' ? '' : size + '%';
  try { localStorage.setItem('c3.textSize', size); } catch { /* the config keeps it */ }
  window.dispatchEvent(new Event('resize'));          // what measures itself, again
  return size;
}

function textSizeButton(initial) {
  let size = textSizeApply(initial);
  const b = $('size-btn');
  b.title = b.ariaLabel = `${t('Text size')}: ${size} %`;
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect();
    openMenu({
      x: r.left, y: r.bottom + 4, label: t('Text size'), returnFocus: b,
      items: TEXT_SIZES.map((s) => ({
        label: s + ' %' + (s === size ? '  ✓' : ''),
        action: () => {
          size = textSizeApply(s);
          b.title = b.ariaLabel = `${t('Text size')}: ${size} %`;
          api.uiSet({ textSize: size }).catch(() => {});
        },
      })),
    });
  });
}

try { textSizeApply(localStorage.getItem('c3.textSize') || '100'); } catch { /* 100 % */ }

async function main() {
  await i18nInit();
  languageButton();
  const boot = await splash();
  if (!boot) return;
  textSizeButton((boot.config.ui || {}).textSize || (() => { try { return localStorage.getItem('c3.textSize'); } catch { return null; } })() || '100');

  docsInit();
  windowInit();
  headerInit();
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

  const dashboard = new Dashboard();

  assistInit({ connect, compile, run });

  //
  // Compile's "Run it": Run, with that build in the form
  //
  window.addEventListener('c3:run', (e) => {
    location.hash = '#run';
    run.preselectBuild(e.detail.build);
  });

  //
  // Compile's "Map DDS topics, services and actions": Operate, its form with the dds bridge, the mapper open
  //
  window.addEventListener('c3:ddsmap', () => {
    window.addEventListener('hashchange', () => run.ddsMapFromCompile(), { once: true });
    location.hash = '#run';
  });

  //
  // Compile's "Map an OPC UA server": Operate, its form with the opcua bridge, the mapper open
  //
  window.addEventListener('c3:opcuamap', () => {
    window.addEventListener('hashchange', () => run.opcuaMapFromCompile(), { once: true });
    location.hash = '#run';
  });

  //
  // Compile's "Map an AAS server": Operate, its form with the aas bridge, its AAS part open at the server's URL
  //
  window.addEventListener('c3:aasmap', () => {
    window.addEventListener('hashchange', () => run.aasMapFromCompile(), { once: true });
    location.hash = '#run';
  });

  await new Promise((r) => setTimeout(r, 250));
  $('app').hidden = false;
  $('splash').classList.add('leaving');
  setTimeout(() => $('splash').remove(), 400);

  const fromHash = () => PAGES.find((p) => location.hash === '#' + p || location.hash.startsWith('#' + p + '/'));
  const first = fromHash() || (PAGES.includes((boot.config.ui || {}).lastPage) ? boot.config.ui.lastPage : 'connect');
  if (fromHash() !== first) history.replaceState(null, '', '#' + first);
  pageShow(first, compile, run, dashboard);
  window.addEventListener('hashchange', () => pageShow(fromHash() || 'connect', compile, run, dashboard));

  if (boot.last) {
    $('broker-url').value = boot.last.url;
    connect.connect(boot.last.url);
  } else if (first === 'connect') {
    $('broker-url').focus();
  }
}

main();
