//
// compile.js - the Compile page: a broker built by coraine-build, driven by the backend
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// What the page shows comes from the backend: what this machine can do (GET /api/capabilities), the
// feature switches of the source that is installed (GET /api/compile/features), the exact command a
// choice runs (POST /api/builds/command), the builds kept (GET /api/builds). A build's output is followed
// as server-sent events (GET /api/builds/<name>/log): its lines, an event "build" at each phase, "end"
// when it is over.
//
import * as api from './api.js';
import { t, tk, plural } from './i18n.js';
import { Source } from './source.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// The phases coraine-build announces ("coraine-build: phase <name>"); 'unpack' is the time before the
// first. The weights are the share of a build's time when no earlier build of the same mode says better.
//
const PHASES = {
  release: ['unpack', 'build', 'install', 'bridges', 'check', 'done'],
  debug:   ['unpack', 'build', 'install', 'bridges', 'check', 'done'],
  pgo:     ['unpack', 'build', 'tools', 'train', 'install', 'bridges', 'check', 'done'],
  tune:    ['unpack', 'build', 'tools', 'train', 'install', 'bridges', 'check', 'done'],
};
// phasesOf - a build's phases: its mode's, and 'image' before 'done' when it makes a Docker image too
const phasesOf = (b) => {
  const names = PHASES[b.mode] || PHASES.release;
  return b.imageAsked ? [...names.slice(0, -1), 'image', ...(b.imageFileAsked ? ['image-file'] : []), 'done'] : names;
};
const WEIGHTS = { unpack: 3, build: 80, tools: 12, train: 70, install: 2, bridges: 10, check: 2, image: 40, 'image-file': 10, done: 0 };
// pgo and tune: 'train' holds the instrumented build, the training and the rebuild with the profile - the
// most of such a build (12 min and more on a laptop), 'build' only the libraries
const MODE_WEIGHTS = { pgo: { build: 20, train: 900 }, tune: { build: 20, train: 900 } };

// What a phase does - under the phase chips while it runs: a phase of minutes says what it is busy with
const PHASE_WHAT = {
  unpack:  tk('Unpacking the source.'),
  build:   tk('Compiling.'),
  tools:   tk('Building the tools the training drives the broker with (wrk scripts, the notification receiver).'),
  train:   tk('Training: the broker is built instrumented, run under every standard request shape - queries, '
         + 'PATCHes, creates, notifications, a forwarding chain - to record where its time goes, then built again '
         + 'with that profile. This is the longest phase: 10 minutes and more, with a line per scenario.'),
  install: tk('Installing into install/.'),
  bridges: tk('Building the bridges ticked.'),
  check:   tk('Checking the result: --version, the features compiled in.'),
  image:   tk('Making the Docker image: the base image of this distribution, the libraries the broker links, the build.'),
  'image-file': tk('Saving the image as a file: image.tar.gz in the build\'s directory (docker save, gzip).'),
};

const MODES = [
  ['release', tk('Release'),              tk('Optimised build, no training. Traces compiled out.')],
  ['pgo',     tk('Profile-guided'),       tk('Built instrumented, trained on the standard request shapes, rebuilt with the profile.')],
  ['tune',    tk('Tuned for a workload'), tk('Trained on your workload; allocator and lock policy measured on it.')],
  ['debug',   tk('Debug'),                tk('Traces compiled in (--traceLevels works) - for reproducing a crash report.')],
];
const MODE_LABEL = Object.fromEntries(MODES.map(([id, label]) => [id, label]));

const mib = (b) => (b / (1024 * 1024)).toFixed(1) + ' MiB';

//
// The states of a build, as the backend names them - shown in the user's language
//
const STATES = { running: tk('running'), succeeded: tk('succeeded'), failed: tk('failed'), cancelled: tk('cancelled'), interrupted: tk('interrupted') };
const stateText = (s) => (STATES[s] ? t(STATES[s]) : s);

//
// orList / andList - names joined into one phrase: "a, b or c" in the user's language
//
const orList = (items) => (items.length ? items.reduce((a, b) => t('{a} or {b}', { a, b })) : '');
const andList = (items) => (items.length ? items.reduce((a, b) => t('{a} and {b}', { a, b })) : '');
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const duration = (s) => (s >= 60 ? t('{m} min {s} s', { m: Math.floor(s / 60), s: s % 60 }) : t('{s} s', { s }));

//
// shellQuote - as the backend quotes the command it runs
//
//
// The HTTP servers coraine-build builds with (--http-server); mhd is its default
//
const HTTP_SERVERS = [
  ['mhd',     'libmicrohttpd',          tk('An external library (libmicrohttpd 1.0.10). Everything is built.')],
  ['builtin', 'corHttp',                tk('No external library. One listener - what needs a second port is not built.')],
];

//
// The temporal databases (TRoE) a broker can keep its history in - each a switch of the source (CMakeLists.txt);
// none ticked: the broker keeps no history (--troe none, its default) - it is kept elsewhere, by subscription
//
const TROES = [
  ['TROE_CORDB',     'corDB'],
  ['TROE_TIMESCALE', 'TimescaleDB'],
];
const TROE_NAMES = new Set(TROES.map(([n]) => n));
const HTTP_LABEL = Object.fromEntries(HTTP_SERVERS.map(([id, label]) => [id, label]));

//
// httpHas - a server is in the build: the choice is it, or both (coraine-build --http-server both: the broker
// carries both and picks one at start, --httpServer, libmicrohttpd unless told)
//
const httpHas   = (choice, id) => choice === id || choice === 'both';
const httpLabel = (choice) => (choice === 'both') ? t('{a} and {b}', { a: HTTP_LABEL.mhd, b: HTTP_LABEL.builtin }) : t(HTTP_LABEL[choice]);

//
// The build settings a switch may need ("requires": ["HTTP_SERVER=mhd"]): what to call them, why the
// switch needs them, and the choice that gives them back
//
const SETTINGS = {
  'HTTP_SERVER=mhd': {
    label: tk('the libmicrohttpd HTTP server'),
    why:   tk('it listens on a port of its own, and only libmicrohttpd has a second listener - corHttp has one'),
    give:  tk('tick libmicrohttpd under HTTP server'),
  },
};

//
// The groups c³ names itself (the others come from the source's CMake): kept in English, shown translated
//
// The groups c³ makes, and coraine's own (CMakeLists.txt "# Group:" lines) - a group coraine adds later shows as named
const GROUP_NAMES = {
  Other: tk('Other'), Bridges: tk('Bridges'), Snapshot: tk('Snapshot'), Snapshots: tk('Snapshots'), Geo: tk('Geo'),
  Security: tk('Security'), 'Beyond NGSI-LD': tk('Beyond NGSI-LD'), Protocols: tk('Protocols'), Operations: tk('Operations'),
  'Stores and tools': tk('Stores and tools'),
};
const groupName = (name) => (GROUP_NAMES[name] ? t(GROUP_NAMES[name]) : name);

//
// openGroupsKey - the groups the Features card has open, remembered in this browser
//
const OPEN_GROUPS_KEY = 'c3.compile.openGroups';

function openGroupsLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch (e) {
    return new Set();
  }
}

function openGroupsSave(set) {
  try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...set])); } catch (e) { /* not kept: fine */ }
}

function shellQuote(a) {
  if (a !== '' && /^[A-Za-z0-9_./=,:@+%-]+$/.test(a)) return a;
  return "'" + a.replace(/'/g, "'\\''") + "'";
}

//
// What each choice is and what it costs: the source's own doc/building-details.md, a "#### <heading>" per
// choice ("Build mode: Release", "HTTP server: libmicrohttpd", "Store: corDB only", "`SUBSCRIPTIONS`" - or
// several switches in one heading, comma-separated), shown behind each box's '?'
//
const DOC_BASE = 'https://github.com/SEAMWARE/coraine/blob/main/doc/';
const MODE_DOC = { release: 'Build mode: Release', pgo: 'Build mode: Profile-guided', tune: 'Build mode: Tuned for a workload', debug: 'Build mode: Debug' };
const HTTP_DOC = { mhd: 'HTTP server: libmicrohttpd', builtin: ['HTTP server: corHttp', 'HTTP server: corHttp (built in)'] };
const TROE_DOC = { TROE_CORDB: 'Temporal: corDB', TROE_TIMESCALE: 'Temporal: TimescaleDB' };
const STORE_DOC = { false: 'Store: corDB only', true: 'Store: corDB + mongoc' };
const BRIDGE_DOC = { mqtt: 'MQTT', modbus: 'Modbus', dds: 'DDS', ckan: 'CKAN', opcua: 'OPC UA', aas: 'AAS' };

function docSections(md) {
  const out = new Map();
  if (!md) return out;
  let key = null;
  let body = [];
  let fence = false;
  const flush = () => { if (key) out.set(key, body.join('\n').trim()); };
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (!fence && /^#{1,4} /.test(line)) {
      flush();
      key = line.startsWith('#### ') ? line.slice(5).replace(/`/g, '').trim() : null;
      body = [];
      continue;
    }
    if (key) body.push(line);
  }
  flush();
  return out;
}

//
// docFeature - the section of a switch: its own heading, or one that names it among others
//
function docFeature(doc, name) {
  for (const [k, v] of doc) {
    if (k.split(/,\s*/).includes(name)) return { title: k, text: v };
  }
  return null;
}

//
// docSize - what the section says the choice changes in the install: "-64 KiB", "+39.2 MiB", "< 4 KiB",
// "no effect yet" (a switch declared that removes nothing); '' when it says no size
//
function docSize(text) {
  if (!text) return '';
  if (/\*\*Declared, removes nothing/.test(text)) return 'no effect yet';
  const m = text.match(/Size(?:, on)?:\s+\**([+-]?[\d.]+\s(?:KiB|MiB))/);
  if (m) return m[1].replace('-', '−').replace(/\s/, ' ');
  if (/Size:\s+under a page/.test(text)) return '< 4 KiB';
  return '';
}

//
// tickCost - what ticking a box of Server and databases adds, from the source's doc, whose sections measure a
// choice against the other: libmicrohttpd's is what corHttp alone saves, corHttp's the code it adds ("for 12 KiB
// of corHttp"), mongoc's what corDB alone saves
//
function tickCost(text, what) {
  if (!text) return '';
  if (what === 'part') { const m = text.match(/for\s+([\d.]+\s(?:KiB|MiB))\s+of/); return m ? m[1].replace(/\s/, ' ') : ''; }
  return docSize(text).replace('−', '');                  // 'saved' - the size the other choice saves, unsigned
}

const sizeText = (size) => (size === 'no effect yet' ? t('no effect yet') : size);

//
// mdInline / mdRender - the little Markdown the doc's sections use: paragraphs, "- " lists, ``` blocks,
// `code`, **bold**, [links]. DOM nodes, never innerHTML: the text is the source's
//
function mdHref(href) {
  if (/^https?:/.test(href)) return href;
  if (href.startsWith('#')) return DOC_BASE + 'building-details.md' + href;
  return DOC_BASE + href;
}

function mdInline(text) {
  const frag = document.createDocumentFragment();
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > at) frag.append(text.slice(at, m.index));
    if (m[1] !== undefined) frag.append(el('code', '', m[1]));
    else if (m[2] !== undefined) frag.append(el('strong', '', m[2]));
    else {
      const a = el('a');
      a.href = mdHref(m[4]);
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(mdInline(m[3]));
      frag.append(a);
    }
    at = re.lastIndex;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

function mdRender(md) {
  const root = el('div', 'cp-doc');
  const lines = md.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (line.trim().startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i].replace(/^ {2}/, ''));
      i++;
      root.append(el('pre', '', code.join('\n')));
      continue;
    }
    if (/^- /.test(line)) {
      const ul = el('ul');
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```')) {
        const item = [lines[i].replace(/^- /, '')];
        for (i++; i < lines.length && /^ {2}\S/.test(lines[i]) && !lines[i].trim().startsWith('```'); i++) item.push(lines[i].trim());
        const li = el('li');
        li.append(mdInline(item.join(' ')));
        ul.append(li);
        if (i < lines.length && !/^- /.test(lines[i])) break;
      }
      root.append(ul);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() !== '' && !/^- /.test(lines[i]) && !lines[i].trim().startsWith('```'); i++) para.push(lines[i].trim());
    const p = el('p');
    p.append(mdInline(para.join(' ')));
    root.append(p);
  }
  return root;
}

//
// helpShow - a section in a dialog; Escape, the button or a click beside it closes it
//
export function helpShow(title, text) {
  const ov = el('div', 'overlay cp-modal');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', title);
  const card = el('div', 'card cp-help-card');
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const ok = el('button', 'btn', t('Close'));
  ok.type = 'button';
  ok.addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  const h = el('h3');
  h.append(mdInline(title));
  const actions = el('div', 'actions');
  actions.append(ok);
  card.append(h, mdRender(text), actions);
  ov.append(card);
  document.body.append(ov);
  ok.focus();
}

//
// MAPS - the bridges whose mapping is in Operate: the button here, the question before going, the event main.js turns
// into Operate with the bridge ticked in its broker form and its mapping open
//
const MAPS = [
  { bridge: 'dds', label: tk('Map DDS topics, services and actions'), event: 'c3:ddsmap',
    heading: tk('The DDS mapping is in Operate'),
    where:   tk('The mapper opens in the Operate tab, with the dds bridge ticked in its broker form. What is chosen here stays as it is: the Compile tab brings you back, to build.'),
    how:     tk('Discover asks your DDS system what it announces: c³ joins its DDS domain from this machine, so it must reach it - DDS discovery is multicast, on this host or its network. Where c³ does not reach it, import an inventory.json written where it runs. Discover uses a broker with the dds bridge: an installed coraine, a build, or an image with it.') },
  { bridge: 'opcua', label: tk('Map an OPC UA server'), event: 'c3:opcuamap',
    heading: tk('The OPC UA mapping is in Operate'),
    where:   tk('The mapper opens in the Operate tab, with the opcua bridge ticked in its broker form. What is chosen here stays as it is: the Compile tab brings you back, to build.'),
    how:     tk('Discover reads your OPC UA server\'s address space: c³ connects to it from this machine, so it must reach its opc.tcp:// URL. Where c³ does not reach it, import an inventory.json read where it runs. Discover uses a native broker with the opcua bridge: an installed coraine or a build.') },
  { bridge: 'aas', label: tk('Map an AAS server'), event: 'c3:aasmap',
    heading: tk('The AAS mapping is in Operate'),
    where:   tk('Its AAS part opens in the Operate tab, with the aas bridge ticked in its broker form. What is chosen here stays as it is: the Compile tab brings you back, to build.'),
    how:     tk('Discover the server reads its shells and submodels: c³ connects to it from this machine, so it must reach its URL. Each shell or submodel picked becomes an AssetChannel, its model a graph of entities. Discover uses a native broker with the aas bridge: an installed coraine or a build.') },
];

//
// stampNow - the default build name's time, as the backend makes it: YYYYMMDD-HHMMSS, local time. The page fixes it
// when Compile is shown and after a build starts - the name does not move with every change of the choice
//
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

//
// mapAsk - before Operate is shown for a bridge's mapping: what is left here stays as it is, the way back is the
// Compile tab
//
function mapAsk(m) {
  const ov = el('div', 'overlay cp-modal');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', t(m.label));
  const card = el('div', 'card cp-help-card');
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const cancel = el('button', 'btn', t('Stay here'));
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  const go = el('button', 'btn primary', t('Go to Operate'));
  go.type = 'button';
  go.addEventListener('click', () => { close(); window.dispatchEvent(new CustomEvent(m.event)); });
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  const actions = el('div', 'actions');
  actions.append(cancel, go);
  card.append(el('h3', '', t(m.heading)), el('p', '', t(m.where)), el('p', '', t(m.how)), actions);
  ov.append(card);
  document.body.append(ov);
  go.focus();
}

//
// helpButton - the '?' of a box; null when the source's doc has no section for it
//
function helpButton(section, inline) {
  if (!section) return null;
  const q = el('button', 'cp-q' + (inline ? ' inline' : ''), '?');
  q.type = 'button';
  q.title = t('What is {what}?', { what: section.title.replace(/`/g, '') });
  q.setAttribute('aria-label', q.title);
  q.addEventListener('click', (e) => { e.stopPropagation(); helpShow(section.title, section.text); });
  return q;
}

//
// withHelp - a box and its '?' in the top right corner
//
function withHelp(box, section, cls) {
  const q = helpButton(section, false);
  if (!q) return box;
  const w = el('div', cls);
  w.append(box, q);
  return w;
}

export class Compile {
  constructor() {
    this.caps = null;             // GET /api/capabilities
    this.features = [];           // [{name, default, description, group, requires, requiresAny}]
    this.openGroups = openGroupsLoad();   // the groups shown open
    this.featureError = '';
    this.doc = new Map();         // the source's doc/building-details.md, by "#### " heading
    this.bridges = [];            // [{name, default, description, available, why}] - coraine-build --list-bridges
    this.httpServers = ['mhd', 'builtin'];   // coraine-build's --http-server values ("httpServers"; older: these two)
    this.choice = { mode: 'release', httpServer: 'mhd', features: {}, bridges: {}, workload: '', output: 'binary', imageFile: false };
    this.imageFileCap = false;              // coraine-build --image-file (its usage names it; "imageFile" of the features)
    this.presets = [];
    this.builds = [];
    this.plan = null;             // the last POST /api/builds/command answer
    this.run = null;              // the build in the panel
    this.runLines = 0;
    this.es = null;
    this.poll = null;
    this.saveTimer = null;
    this.cmdTimer = null;
    this.elapsedTimer = null;
    this.armed = null;            // the build whose Delete was pressed once
    this.source = new Source(this);   // the Source card
    this.featuresFrom = '';       // the source the features and bridges were read from

    $('cp-build').addEventListener('click', () => this.start());
    $('cp-cancel').addEventListener('click', () => this.cancel());
    $('cp-run-close').addEventListener('click', () => this.closeRun());
    $('cp-building').addEventListener('click', () => this.showRun());
    $('cp-name').addEventListener('input', () => this.commandSoon());
    $('cp-exe').addEventListener('input', () => this.commandSoon());
    $('cp-image').addEventListener('input', () => this.commandSoon());
    $('cp-workload-path').addEventListener('input', () => { this.choice.workload = $('cp-workload-path').value.trim(); this.changed(); });
    $('cp-preset-save').addEventListener('click', () => this.presetSave());
    $('cp-preset-load').addEventListener('click', () => this.presetLoad());
    $('cp-preset-del').addEventListener('click', () => this.presetDelete());
    this.source.bind();
  }

  //
  // init - the configuration's choice and presets; what the backend knows comes with refresh()
  //
  init(config) {
    const c = (config && config.compile) || {};
    if (c.choice) {
      this.choice = {
        mode: c.choice.mode || 'release',
        httpServer: c.choice.httpServer || 'mhd',
        features: { ...(c.choice.features || {}) },
        bridges: { ...(c.choice.bridges || {}) },
        workload: c.choice.workload || '',
        output: c.choice.output === 'image' ? 'image' : 'binary',
        imageFile: c.choice.imageFile === true,
      };
    }
    this.presets = Array.isArray(c.presets) ? c.presets : [];
    this.renderPresets();
  }

  //
  // refresh - capabilities, features and builds again (the page is shown: something may have been installed);
  // force: the source changed (another kind or directory, a repository cloned) - its features and bridges again
  //
  //
  // refresh - capabilities, the feature list (force: read again), the Source card (unless keepSource: a branch chosen
  // there changes nothing it shows), the builds
  //
  async refresh(force, keepSource) {
    this.stamp = stampNow();                 // the default name's time: when the page was shown, not each change
    try {
      this.caps = await api.capabilities();
    } catch (e) {
      this.caps = { compile: { available: false, why: t('the backend does not answer: {error}', { error: e.message }) } };
    }
    const cc = this.caps.compile;

    $('cp-host').textContent = t('build host · {host}', { host: this.caps.host || t('this machine') });
    $('page-compile').classList.toggle('cp-off', !cc.available);
    $('cp-unavail').hidden = !!cc.available;
    $('cp-unavail-why').textContent = cc.why ? cc.why.charAt(0).toUpperCase() + cc.why.slice(1) + '.' : '';
    $('cp-build').disabled = !cc.available || !!this.source.blocking();

    const from = (cc.source || '') + '|' + (cc.version || '');
    if (cc.available && (this.features.length === 0 || force || from !== this.featuresFrom)) {
      this.featuresFrom = from;
      try {
        const f = await api.compileFeatures();
        this.features = f.features || [];
        this.doc = docSections(f.doc);
        this.bridges = Array.isArray(f.bridges) ? f.bridges : [];
        this.httpServers = Array.isArray(f.httpServers) ? f.httpServers : ['mhd', 'builtin'];
        this.imageFileCap = f.imageFile === true;
        if (this.choice.httpServer === 'both' && !this.httpServers.includes('both')) this.choice.httpServer = 'mhd';
        this.featureError = '';
      } catch (e) {
        this.featureError = e.message;
      }
    } else if (!cc.available) {
      this.bridges = [];              // the old source's - the list of repositories asks for none
      this.featuresFrom = '';
    }

    //
    // No mongo-c driver and no choice made: corDB only, which builds
    //
    if (cc.available && !cc.mongoc && !('MONGOC' in this.choice.features)) this.choice.features.MONGOC = false;

    this.render();
    if (!keepSource) await this.source.update(force);
    await this.loadBuilds();

    //
    // A build that runs: shown, and followed
    //
    const running = this.builds.find((b) => b.state === 'running');
    if (running && (!this.run || this.run.name !== running.name)) this.open(running);
  }

  isDefault(name) {
    const f = this.features.find((x) => x.name === name);
    return f ? !!f.default : true;
  }

  isOn(name) {
    return (name in this.choice.features) ? this.choice.features[name] : this.isDefault(name);
  }

  //
  // forcedBy - what keeps a switch off whatever is chosen (CMakeLists.txt): each of its "requires" that does
  // not hold, and its "requiresAny" - as one entry, an array - when none of them does (one is enough)
  //
  forcedBy(f) {
    const forced = (f.requires || []).filter((r) => !this.reqMet(r));
    const any = f.requiresAny || [];
    if (any.length > 0 && !any.some((r) => this.reqMet(r))) forced.push(any);
    return forced;
  }

  //
  // needsOf - everything a switch needs, for its card: each of "requires", and "requiresAny" as one entry
  //
  needsOf(f) {
    const needs = (f.requires || []).slice();
    if ((f.requiresAny || []).length > 0) needs.push(f.requiresAny);
    return needs;
  }

  //
  // reqMet - a requirement holds: a switch that is on, or a build setting coraine-build builds with (NAME=value)
  //
  reqMet(r) {
    const eq = r.indexOf('=');
    if (eq < 0) return this.isOn(r);
    if (r.slice(0, eq) === 'HTTP_SERVER') return httpHas(this.choice.httpServer || 'mhd', r.slice(eq + 1));
    return false;
  }

  //
  // reqLabel - a requirement's name; of a "requiresAny", its switches with "or"
  //
  reqLabel(r) {
    if (Array.isArray(r)) return orList(r.map((x) => this.reqLabel(x)));
    return (r.indexOf('=') < 0) ? r : ((SETTINGS[r] && t(SETTINGS[r].label)) || r);
  }

  //
  // offLabel - the requirements that do not hold, for "... is off" / "... are off"
  //
  offLabel(forced) {
    const what = andList(forced.map((r) => !Array.isArray(r) ? this.reqLabel(r)
                                  : (r.length === 2 ? t('both {a} and {b}', { a: r[0], b: r[1] }) : t('all of {list}', { list: r.join(', ') }))));
    return (forced.length > 1 || Array.isArray(forced[0])) ? t('{what} are off', { what }) : t('{what} is off', { what });
  }

  //
  // forcedWhy - a forced-off switch's explanation, for its tooltip: what it needs, why, and how to have it
  //
  forcedWhy(f, forced) {
    return forced.map((r) => {
      if (Array.isArray(r)) {
        return r.length === 2 ? t('{name} needs {list} - one of them is enough, and both are off. To have it, switch one of them on.', { name: f.name, list: orList(r) })
                              : t('{name} needs {list} - one of them is enough, and all are off. To have it, switch one of them on.', { name: f.name, list: orList(r) });
      }
      const st = SETTINGS[r];
      return st ? t('{name} needs {label}: {why}. To have it, {give}.', { name: f.name, label: t(st.label), why: t(st.why), give: t(st.give) })
                : t('{name} needs {req}, which is off. To have it, switch {req} on.', { name: f.name, req: r });
    }).join('\n');
  }

  //
  // lostWith - the switches a choice of HTTP server would turn off: on now, and needing what it does not give
  //
  lostWith(httpServer) {
    const was = this.choice.httpServer;
    const onNow = this.features.filter((f) => this.isOn(f.name) && this.forcedBy(f).length === 0);
    this.choice.httpServer = httpServer;
    const lost = onNow.filter((f) => this.forcedBy(f).length > 0);
    this.choice.httpServer = was;
    return lost;
  }

  //
  // httpServerSet - the choice, after asking when it turns switches off
  //
  httpServerSet(id) {
    if (id === this.choice.httpServer) return;
    const lost = this.lostWith(id);
    const apply = () => { this.choice.httpServer = id; this.changed(); };
    if (lost.length === 0) { apply(); return; }

    const ov = el('div', 'overlay cp-modal');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', t('Switch to {server}', { server: t(HTTP_LABEL[id]) }));
    const card = el('div', 'card');
    const list = el('ul', 'cp-lost');
    for (const f of lost) {
      const li = el('li');
      li.append(el('span', 'mono', f.name), el('span', '', ' - ' + f.description));
      const why = (f.requires || []).filter((r) => SETTINGS[r]).map((r) => t(SETTINGS[r].why));
      if (why.length) li.append(el('div', 'why', t('Not built: {why}.', { why: why.join('; ') })));
      list.append(li);
    }
    const yes = el('button', 'btn primary', t('Switch to {server}', { server: t(HTTP_LABEL[id]) }));
    const no = el('button', 'btn', t('Keep {server}', { server: httpLabel(this.choice.httpServer) }));
    yes.type = no.type = 'button';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    yes.addEventListener('click', () => { close(); apply(); });
    no.addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    const actions = el('div', 'actions');
    actions.append(yes, no);
    const server = t(HTTP_LABEL[id]), back = httpLabel(this.choice.httpServer);
    card.append(el('h3', '', t('Switch to {server}?', { server })),
                el('p', '', plural(lost.length, 'With {server}, this switch is not built:', 'With {server}, these switches are not built:', { server })),
                list,
                el('p', '', plural(lost.length, 'Switching back to {server} turns it on again.', 'Switching back to {server} turns them on again.', { server: back })),
                actions);
    ov.append(card);
    document.body.append(ov);
    no.focus();
  }

  //
  // featureGroups - the switches shown, by group, in the order the source lists them
  //
  featureGroups(shown) {
    const groups = [];
    for (const f of shown) {
      const name = f.group || 'Other';
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push(g = { name, features: [] });
      g.features.push(f);
    }
    return groups;
  }

  //
  // changedFeatures - only the switches that differ from their defaults: the command says what is different
  //
  //
  // isBridgeOn - the choice made, else the bridge's default
  //
  isBridgeOn(br) {
    return (br.name in this.choice.bridges) ? !!this.choice.bridges[br.name] : !!br.default;
  }

  //
  // bridgesArg - the bridges to build when they differ from coraine-build's default, else undefined (the
  // command says what is different); [] is none
  //
  bridgesArg() {
    if (!this.bridges.length) return undefined;
    const on = this.bridges.filter((br) => this.canTick(br) && this.isBridgeOn(br)).map((br) => br.name);
    const def = this.bridges.filter((br) => br.default).map((br) => br.name);
    return (on.join(',') === def.join(',')) ? undefined : on;
  }

  //
  // canTick - a bridge that can be switched on: buildable here, or its repository not cloned yet when the
  // source is git clones (Source then lists it as missing, and Build waits for the clone)
  //
  cloneable(br) {
    return !br.available && !!br.repository && br.why === 'not in this source' && this.source.isClones();
  }

  canTick(br) {
    return br.available || this.cloneable(br);
  }

  //
  // sourceChanged - the Source card read the repositories: the subtitle, the summary, Build
  //
  sourceChanged() {
    this.renderSourceText();
    this.commandSoon();
  }

  renderSourceText() {
    const cc = (this.caps && this.caps.compile) || {};
    let sub;
    if (cc.sourceFlag) sub = t('from {source} (--source)', { source: cc.source });
    else if (cc.sourceKind === 'clones') sub = t('from the git clones in {dir}', { dir: cc.clonesDir || '?' });
    else if (cc.sourceKind === 'package') sub = t('from the source coraine-dev installs');
    else sub = t('from the source below');
    $('cp-sub-source').textContent = sub;
    const blocking = this.source.blocking();
    $('cp-sum-source').textContent = blocking ? blocking
      : (cc.sourceKind === 'clones' ? t('git clones') + ', ' : '') + (cc.version ? 'coraine ' + cc.version : (cc.source || '-'));
    $('cp-sum-source').classList.toggle('cp-warn', !!blocking);
  }

  changedFeatures() {
    const out = {};
    for (const [name, on] of Object.entries(this.choice.features)) {
      if (this.features.length && !this.features.find((f) => f.name === name)) continue;     // not in this source
      if (on !== this.isDefault(name)) out[name] = on;
    }
    return out;
  }

  //
  // tick - a tick box of Server and databases: the label, ticked or not (aria-checked); the caller adds the click
  //
  tick(label, on) {
    const b = el('button', 'cp-tick', label);
    b.type = 'button';
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', String(on));
    return b;
  }

  //
  // pill - a choice of the card, its size and its '?' beside it
  //
  pill(b, section, cost) {
    const size = (cost !== undefined) ? cost : docSize(section && section.text);
    if (size) b.append(el('span', 'psz', ' ' + sizeText(size)));
    const w = el('span', 'cp-segitem');
    w.append(b, helpButton(section, true) || el('span', 'cp-q inline ghost'));    // without a '?', its room: the buttons one width
    return w;
  }

  // title: a heading of the source's doc, or several - the first the doc has (a heading renamed, an older source)
  docAt(title) {
    const found = [].concat(title).find((h) => this.doc.has(h));
    return found ? { title: found, text: this.doc.get(found) } : null;
  }

  //
  // imageOn - a Docker image of the build too: chosen, and an engine here (docker or podman, as Operate's)
  //
  imageOn() { return this.choice.output === 'image' && !!(this.caps && this.caps.run && this.caps.run.containers); }

  //
  // renderOutput - Binary, or Binary and Docker image (greyed without docker or podman); the image's name
  //
  renderOutput() {
    const run = (this.caps && this.caps.run) || {};
    const cont = !!run.containers;
    $('cp-output').replaceChildren(...[['binary', t('Binary')], ['image', t('Binary and Docker image')]].map(([v, label]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === 'image' ? this.imageOn() : !this.imageOn()));
      if (v === 'image' && !cont) b.disabled = true;
      b.addEventListener('click', () => { if (this.choice.output !== v) { this.choice.output = v; this.changed(); } });
      return b;
    }));
    //
    // Nothing appears or goes on a click (the card would change size): the note only says why there is no image,
    // and the image's name is always there - greyed for a binary
    //
    $('cp-output-note').textContent = !cont ? (run.containersWhy || t('install docker or podman')) : '';
    $('cp-image').disabled = !this.imageOn();
    $('cp-image-row').classList.toggle('off', !this.imageOn());
    //
    // Save as a file: the image as <build>/image.tar.gz too (docker save), for a machine without a registry - from a
    // source whose coraine-build can; greyed for a binary
    //
    const fileBox = $('cp-imagefile');
    fileBox.hidden = !this.imageFileCap;
    if (this.imageFileCap) {
      const f = this.tick(t('Save as a file'), this.imageOn() && this.choice.imageFile);
      f.title = t('The image as a file too - image.tar.gz in the build\'s directory, about 70 MiB - to take it to a machine without a registry: docker load -i image.tar.gz there, then docker run <name>');
      if (!this.imageOn()) f.setAttribute('aria-disabled', 'true');
      else f.addEventListener('click', () => { this.choice.imageFile = !this.choice.imageFile; this.changed(); });
      fileBox.replaceChildren(f);
    }
  }

  render() {
    const cc = (this.caps && this.caps.compile) || {};
    this.renderOutput();

    //
    // HTTP server: libmicrohttpd or corHttp - corHttp not with a training build (coraine-build refuses)
    //
    const isTraining = (m) => (m === 'pgo' || m === 'tune');
    const http = $('cp-http');
    const cur = this.choice.httpServer;
    const canBoth = this.httpServers.includes('both');
    http.replaceChildren(...HTTP_SERVERS.map(([id, label, desc]) => {
      const on = httpHas(cur, id);
      const other = (id === 'mhd') ? 'builtin' : 'mhd';
      const b = this.tick(t(label), on);
      const training = isTraining(this.choice.mode);
      let why = '';
      if (on && cur === id) why = t('One HTTP server at least - tick the other first');
      else if (!on && training) why = t('Not with {mode} yet: coraine-build trains with libmicrohttpd only. Choose Release or Debug for this.', { mode: t(MODE_LABEL[this.choice.mode]) });
      if (why) { b.setAttribute('aria-disabled', 'true'); b.title = why; }
      else b.title = t(desc) + (!on && !canBoth ? '\n' + t('This source builds one HTTP server: ticking it unticks {server}.', { server: t(HTTP_LABEL[other]) }) : '');
      b.addEventListener('click', () => {
        if (why) return;
        if (on) this.httpServerSet(other);                       // unticked: the other one alone
        else this.httpServerSet(canBoth ? 'both' : id);          // ticked: both, or this one instead
      });
      const corHttpDoc = this.docAt(HTTP_DOC.builtin);
      const cost = tickCost(corHttpDoc && corHttpDoc.text, (id === 'mhd') ? 'saved' : 'part');
      return this.pill(b, this.docAt(HTTP_DOC[id]), cost);
    }));
    const lostNow = this.features.filter((f) => (f.requires || []).some((r) => SETTINGS[r]) && this.forcedBy(f).length > 0).map((f) => f.name);
    $('cp-http-note').textContent = (cur === 'both') ? t('Chosen at start: --httpServer')
      : (cur === 'builtin') ? (lostNow.length ? t('No external library. Not built with it: {list}.', { list: lostNow.join(', ') }) : t('No external library.'))
      : '';

    //
    // Stores: mongoc is the MONGOC switch, corDB the CORDB switch (an older source has none: always built); one at
    // least - the broker keeps its entities in one - and corDB with pgo / tune (their training runs on corDB)
    //
    const mongoc = this.isOn('MONGOC');
    const hasCordbSwitch = this.features.some((f) => f.name === 'CORDB');
    const cordbOn = !hasCordbSwitch || this.isOn('CORDB');
    const store = $('cp-store');
    const cordb = this.tick('corDB', cordbOn);
    const mb = this.tick('mongoc', mongoc);
    const lastStore = (on, other) => on && !other;
    let cordbWhy = '';
    if (!hasCordbSwitch) cordbWhy = t('Always built by this source');
    else if (lastStore(cordbOn, mongoc)) cordbWhy = t('One current-state database at least - tick mongoc first');
    else if (cordbOn && isTraining(this.choice.mode)) cordbWhy = t('Not without corDB with {mode}: its training runs the broker on corDB. Choose Release or Debug for this.', { mode: t(MODE_LABEL[this.choice.mode]) });
    if (cordbWhy) { cordb.setAttribute('aria-disabled', 'true'); cordb.title = cordbWhy; }
    else cordb.addEventListener('click', () => { this.choice.features.CORDB = !cordbOn; this.changed(); });
    if (lastStore(mongoc, cordbOn)) { mb.setAttribute('aria-disabled', 'true'); mb.title = t('One current-state database at least - tick corDB first'); }
    else mb.addEventListener('click', () => { this.choice.features.MONGOC = !mongoc; this.changed(); });
    const cordbDoc = this.docAt(['CORDB', STORE_DOC[false]]);
    const onlyDoc = this.docAt(STORE_DOC[false]);
    const cordbCostDoc = this.docAt(['Store: mongoc only', 'CORDB']);     // what mongoc alone saves, as mongoc's is what corDB alone does
    store.replaceChildren(this.pill(cordb, cordbDoc, hasCordbSwitch ? tickCost(cordbCostDoc && cordbCostDoc.text, 'saved') : ''),
                          this.pill(mb, this.docAt(STORE_DOC[true]), tickCost(onlyDoc && onlyDoc.text, 'saved')));
    const sn = $('cp-store-note');
    sn.textContent = (!cc.mongoc && mongoc) ? t('The mongo-c driver v2 is not installed here: this build would stop. Untick mongoc, or install it.') : (!cc.mongoc ? t('mongoc needs the mongo-c driver v2 (not installed here).') : '');
    sn.className = 'cp-note' + ((!cc.mongoc && mongoc) ? ' warn' : '');

    //
    // Temporal history: corDB and TimescaleDB, any of them - the source's switches; an older source without them
    // builds both
    //
    const troes = TROES.filter(([n]) => this.features.some((f) => f.name === n));
    const troe = $('cp-troe');
    const tn = $('cp-troe-note');
    troe.replaceChildren(...troes.map(([n, label]) => {
      const f = this.features.find((x) => x.name === n);
      const forced = this.forcedBy(f);
      const b = this.tick(label, this.isOn(n) && forced.length === 0);
      if (forced.length) {
        b.setAttribute('aria-disabled', 'true');
        b.title = forced.includes('CORDB') ? t('corDB\'s history needs corDB: tick it under Current-state databases') : this.forcedWhy(f, forced);
        return this.pill(b, this.docAt(TROE_DOC[n]));
      }
      b.addEventListener('click', () => { this.choice.features[n] = !this.isOn(n); this.changed(); });
      return this.pill(b, this.docAt(TROE_DOC[n]));
    }));
    const troeOn = troes.filter(([n]) => this.isOn(n) && this.forcedBy(this.features.find((x) => x.name === n)).length === 0).map(([, label]) => label);
    troe.hidden = troes.length === 0;
    tn.textContent = (troes.length === 0) ? t('corDB and TimescaleDB, always built by this source')
      : (troeOn.length === 0 ? t('None: no history in the broker - keep it elsewhere, by subscription: QuantumLeap, Cygnus, Kafnus') : '');

    //
    // Features
    //
    const list = $('cp-features');
    const shown = this.features.filter((f) => f.name !== 'MONGOC' && f.name !== 'CORDB' && !TROE_NAMES.has(f.name));
    const groups = this.featureGroups(shown);
    let on = 0;

    const featureButton = (f) => {
      const forced = this.forcedBy(f);
      const isOn = this.isOn(f.name) && forced.length === 0;

      const b = el('button', 'cp-feature' + ((this.isOn(f.name) !== !!f.default) ? ' changed' : ''));
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(isOn));
      if (forced.length > 0) b.setAttribute('aria-disabled', 'true');    // not disabled: a disabled button shows no tooltip
      b.title = forced.length ? this.forcedWhy(f, forced) : f.description;
      const txt = el('span', 'txt');
      txt.append(el('span', 'fn', f.name), el('span', 'fd', f.description));
      const section = docFeature(this.doc, f.name);
      const size = docSize(section && section.text);
      if (size) txt.append(el('span', 'fsz', (size === 'no effect yet') ? t('compiled out: no effect yet') : (f.default ? t('off: {size}', { size }) : t('on: {size}', { size }))));
      const needs = this.needsOf(f).map((r) => this.reqLabel(r));
      if (forced.length) txt.append(el('span', 'fr', t('Off: needs {needs} - {off}', { needs: andList(needs), off: this.offLabel(forced) })));
      else if (needs.length) txt.append(el('span', 'fq', t('Needs {needs}', { needs: andList(needs) })));
      txt.append(el('span', 'fdef', (f.default ? t('default on') : t('default off')) + ((this.isOn(f.name) !== !!f.default) ? ' · ' + t('changed') : '')));
      b.append(el('span', 'cp-fbox'), txt);
      b.addEventListener('click', () => { if (forced.length) return; this.choice.features[f.name] = !this.isOn(f.name); this.changed(); });
      return { b: withHelp(b, section, 'cp-fwrap'), isOn };
    };

    const groupSection = (name, items, changed) => {
      const open = this.openGroups.has(name);
      const sec = el('div', 'cp-fgroup' + (open ? ' open' : ''));
      const head = el('button', 'cp-fghead');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(open));

      const gOn = items.filter((x) => x.isOn).length;
      head.append(el('span', 'chev', open ? '▾' : '▸'), el('span', 'gname', groupName(name)),
                  el('span', 'gcount', t('{on} of {n} on', { on: gOn, n: items.length })));
      if (changed) head.append(el('span', 'gchanged', t('{n} changed', { n: changed })));
      head.addEventListener('click', () => {
        if (this.openGroups.has(name)) this.openGroups.delete(name); else this.openGroups.add(name);
        openGroupsSave(this.openGroups);
        this.render();
      });

      const body = el('div', 'cp-features');
      body.setAttribute('role', 'group');
      body.setAttribute('aria-label', groupName(name));
      body.hidden = !open;
      body.replaceChildren(...items.map((x) => x.b));

      sec.append(head, body);
      return sec;
    };

    const sections = groups.map((g) => {
      const items = g.features.map(featureButton);
      on += items.filter((x) => x.isOn).length;
      return groupSection(g.name, items, g.features.filter((f) => this.isOn(f.name) !== !!f.default).length);
    });

    //
    // Bridges: plugins built from repositories of their own (coraine-build --bridges), a group of their own
    //
    const bridgeButton = (br) => {
      const tickable = this.canTick(br);
      const isOn = tickable && this.isBridgeOn(br);
      const changed = this.isBridgeOn(br) !== !!br.default;
      const b = el('button', 'cp-feature' + (changed ? ' changed' : ''));
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(isOn));
      if (!tickable) b.setAttribute('aria-disabled', 'true');
      b.title = br.available ? br.description : this.cloneable(br) ? t('Its repository, {repo}, is not cloned - switched on, Source lists it to clone', { repo: br.repository }) : t('Not here: {why}', { why: br.why });
      const txt = el('span', 'txt');
      txt.append(el('span', 'fn', br.name), el('span', 'fd', br.description));
      const section = this.docAt('Bridge: ' + (BRIDGE_DOC[br.name] || br.name));
      const size = docSize(section && section.text);
      if (size) txt.append(el('span', 'fsz', t('on: {size}', { size: sizeText(size) })));
      if (this.cloneable(br)) txt.append(el('span', 'fr', isOn ? t('Not cloned: {repo} - clone it under Source', { repo: br.repository }) : t('Not cloned: {repo} - switch on to clone it', { repo: br.repository })));
      else if (!br.available) txt.append(el('span', 'fr', t('Not here: {why}', { why: br.why })));
      txt.append(el('span', 'fdef', (br.default ? t('default on') : t('default off')) + (changed ? ' · ' + t('changed') : '')));
      b.append(el('span', 'cp-fbox'), txt);
      b.addEventListener('click', () => { if (!tickable) return; this.choice.bridges[br.name] = !this.isBridgeOn(br); this.changed(); });
      return { b: withHelp(b, section, 'cp-fwrap'), isOn };
    };
    if (this.bridges.length) {
      const items = this.bridges.map(bridgeButton);
      sections.push(groupSection('Bridges', items, this.bridges.filter((br) => this.isBridgeOn(br) !== !!br.default).length));
      groups.push({ name: 'Bridges', features: [] });
      for (const m of MAPS) {
        const br = this.bridges.find((x) => x.name === m.bridge);
        if (!br) continue;                                   // a source without that bridge: no button
        const map = el('button', 'btn primary cp-ddsmap', t(m.label));
        map.type = 'button';
        map.disabled = !(br.available && this.isBridgeOn(br));
        map.title = map.disabled ? t('switch the {bridge} bridge on first', { bridge: m.bridge }) : t('in Operate - the Compile tab brings you back');
        map.addEventListener('click', () => mapAsk(m));
        sections.push(map);
      }
    }

    list.replaceChildren(...sections);

    const all = $('cp-fexpand');
    const allOpen = groups.length > 0 && groups.every((g) => this.openGroups.has(g.name));
    all.hidden = groups.length === 0;
    all.textContent = allOpen ? t('Collapse all') : t('Expand all');
    all.onclick = () => {
      if (allOpen) this.openGroups.clear(); else groups.forEach((g) => this.openGroups.add(g.name));
      openGroupsSave(this.openGroups);
      this.render();
    };
    $('cp-fcount').textContent = shown.length ? t('{on} of {n} compiled in · a feature switched off is not in the binary at all', { on, n: shown.length }) : '';
    $('cp-fnote').textContent = this.featureError ? t('The feature list could not be read: {error}', { error: this.featureError })
      : (!cc.available ? t('The switches come from the source - choose it under Source.') : '');

    //
    // Optimisation
    //
    const opts = $('cp-opts');
    opts.replaceChildren(...MODES.map(([id, label, desc]) => {
      const b = el('button', 'cp-opt');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.choice.mode === id));
      const trains = (id === 'pgo' || id === 'tune');
      b.disabled = trains && cc.available && !cc.pgo;
      const byServer = trains && !b.disabled && (this.choice.httpServer !== 'mhd');
      const byStore = trains && !b.disabled && !byServer && !cordbOn;
      b.append(el('span', 'ol', t(label)), el('span', 'od', t(desc)));
      if (b.disabled) b.append(el('span', 'ow', cc.pgoWhy || t('not available here')));
      if (byServer) {
        b.setAttribute('aria-disabled', 'true');
        b.title = t('Not with corHttp yet: coraine-build trains with libmicrohttpd only. Tick libmicrohttpd alone under HTTP server for this.');
        b.append(el('span', 'ow', t('not with corHttp yet')));
      }
      if (byStore) {
        b.setAttribute('aria-disabled', 'true');
        b.title = t('Not without corDB: coraine-build trains the broker on corDB. Tick corDB under Current-state databases for this.');
        b.append(el('span', 'ow', t('not without corDB')));
      }
      b.addEventListener('click', () => { if (byServer || byStore) return; this.choice.mode = id; this.changed(); });
      return withHelp(b, this.docAt(MODE_DOC[id]), 'cp-owrap');
    }));
    $('cp-workload').hidden = this.choice.mode !== 'tune';
    if ($('cp-workload-path').value !== this.choice.workload) $('cp-workload-path').value = this.choice.workload;

    //
    // This build
    //
    const off = shown.filter((f) => !(this.isOn(f.name) && this.forcedBy(f).length === 0)).map((f) => f.name);
    const arch = (this.caps && this.caps.arch) || '';
    const tv = { arch: arch || t('this machine'), distribution: (this.caps && this.caps.distribution) || t('this distribution') };
    $('cp-sum-target').textContent = this.imageOn() ? t('{arch} · {distribution} · binary and Docker image', tv) : t('{arch} · {distribution} · binary', tv);
    $('cp-sum-server').textContent = (this.choice.httpServer === 'mhd') ? t('{server} (coraine-build\'s default)', { server: t(HTTP_LABEL.mhd) })
      : (this.choice.httpServer === 'both') ? t('{servers} - chosen at start (--httpServer), libmicrohttpd unless told', { servers: httpLabel('both') })
      : t(HTTP_LABEL[this.choice.httpServer]);
    $('cp-sum-stores').textContent = t('{stores}; history: {history}', {
      stores:  (cordbOn && mongoc) ? 'corDB + mongoc' : (cordbOn ? t('corDB only') : t('mongoc only')),
      history: (troes.length === 0) ? 'corDB, TimescaleDB' : (troeOn.length ? troeOn.join(', ') : t('none')),
    });
    $('cp-sum-opt').textContent = t(MODE_LABEL[this.choice.mode]) + (this.choice.mode === 'tune' && this.choice.workload ? ' - ' + this.choice.workload : '');
    $('cp-sum-features').textContent = shown.length ? (off.length ? t('{n} off: {list}', { n: off.length, list: off.join(', ') }) : t('all {n} on', { n: shown.length })) : '-';
    const brOn = this.bridges.filter((br) => this.canTick(br) && this.isBridgeOn(br)).map((br) => br.name);
    $('cp-sum-bridges').textContent = this.bridges.length ? (brOn.length ? brOn.join(', ') : t('none')) : '-';
    this.renderSourceText();

    this.commandSoon();
  }

  //
  // changed - a choice was made: drawn again, and kept (c3.json, "compile": {"choice"})
  //
  changed() {
    this.render();
    this.source.update();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api.compileChoice({ mode: this.choice.mode, httpServer: this.choice.httpServer, features: this.choice.features, bridges: this.choice.bridges, workload: this.choice.workload, output: this.choice.output, imageFile: this.choice.imageFile }).catch(() => {});
    }, 400);
  }

  body() {
    const b = { mode: this.choice.mode, features: this.changedFeatures() };
    const bridges = this.bridgesArg();
    if (bridges) b.bridges = bridges;
    if (this.choice.httpServer !== 'mhd') b.httpServer = this.choice.httpServer;
    const name = $('cp-name').value.trim();
    b.name = name || this.choice.mode + '-' + (this.stamp || (this.stamp = stampNow()));
    const exe = $('cp-exe').value.trim();
    if (exe && exe !== 'coraine') b.executable = exe;
    if (this.choice.mode === 'tune') b.workload = this.choice.workload;
    if (this.imageOn()) b.image = $('cp-image').value.trim() || true;
    if (this.imageOn() && this.imageFileCap && this.choice.imageFile) b.imageFile = true;
    return b;
  }

  commandSoon() {
    clearTimeout(this.cmdTimer);
    this.cmdTimer = setTimeout(() => this.command(), 120);
  }

  //
  // command - the exact command, from the backend: one option a line
  //
  async command() {
    const box = $('cp-cmd');
    try {
      const p = await api.buildCommand(this.body());
      this.plan = p;
      const a = p.argv.map(shellQuote);
      const lines = [];
      let i = 0;
      let first = a[i++] + ' ' + a[i++];
      if (this.choice.mode === 'tune') first += ' ' + a[i++];
      lines.push(first);
      while (i < a.length - 1) {
        if (a[i].startsWith('--') && i + 1 < a.length - 1) { lines.push(a[i] + ' ' + a[i + 1]); i += 2; } else lines.push(a[i++]);
      }
      lines.push(a[a.length - 1]);
      box.textContent = lines.join(' \\\n  ');
      box.classList.remove('err');
      $('cp-name').placeholder = p.name;
      $('cp-image').placeholder = p.image || 'localhost/' + (p.executable || 'coraine').toLowerCase() + ':' + p.name;   // the default, greyed too
      const blocking = this.source.blocking();
      $('cp-build').disabled = !(this.caps && this.caps.compile.available) || (this.run && this.run.state === 'running') || !!blocking;
      $('cp-build').title = blocking ? t('Waits: {why}', { why: blocking }) : '';
    } catch (e) {
      this.plan = null;
      box.textContent = e.message;
      box.classList.add('err');
      $('cp-build').disabled = true;
    }
  }

  //
  // start - POST /api/builds with the name the command showed
  //
  async start() {
    if (!this.plan) return;
    const b = this.body();
    b.name = this.plan.name;
    $('cp-build').disabled = true;
    try {
      const build = await api.buildStart(b);
      $('cp-name').value = '';
      this.stamp = stampNow();                // the next build, a name of its own
      this.open(build);
      this.loadBuilds();
      this.showRun();
    } catch (e) {
      const box = $('cp-cmd');
      box.textContent = e.message;
      box.classList.add('err');
      setTimeout(() => this.commandSoon(), 4000);
    }
  }

  async cancel() {
    if (!this.run) return;
    $('cp-cancel').disabled = true;
    try { await api.buildDelete(this.run.name); } catch (e) { $('cp-log-note').textContent = e.message; }
  }

  // ------------------------------------------------------------------ the build panel

  closeRun() {
    this.stopFollowing();
    this.run = null;
    $('cp-run').hidden = true;
    $('cp-building').hidden = true;
    this.renderBuilds();
    this.commandSoon();
  }

  stopFollowing() {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.poll) { clearTimeout(this.poll); this.poll = null; }
    clearInterval(this.elapsedTimer);
  }

  //
  // open - a build in the panel: its log from the start, followed while it runs
  //
  open(build) {
    this.stopFollowing();
    this.followed = build.state === 'running' ? build.name : null;   // its end gets the popup; a build ended already, none
    this.run = build;
    this.runLines = build.lines || 0;
    this.lastLine = '';
    this.lastLineAt = Date.now();
    this.viewPicked = false;
    $('cp-run').hidden = false;
    $('cp-log').replaceChildren();
    $('cp-log-note').textContent = '';
    this.showView('log');
    this.renderRun();
    this.renderBuilds();
    this.elapsedTimer = setInterval(() => this.renderElapsed(), 1000);

    if (this.caps && this.caps.compile && this.caps.compile.liveLog === false) {
      this.pollLog(0);
      return;
    }

    const es = new EventSource('/api/builds/' + encodeURIComponent(build.name) + '/log');
    this.es = es;
    let first = true;
    es.onmessage = (e) => {
      this.append(e.data);
      this.runLines += e.data.split('\n').length;
      this.renderProgress();
    };
    es.addEventListener('build', (e) => {
      const b = JSON.parse(e.data);
      if (first) { first = false; } else this.runLines = b.lines;
      this.run = b;
      this.renderRun();
    });
    es.addEventListener('end', (e) => {
      es.close();
      this.es = null;
      this.run = JSON.parse(e.data);
      this.runLines = this.run.lines;
      this.renderRun();
      this.loadBuilds();
      this.commandSoon();
      this.ended(this.run);
    });
    es.addEventListener('skipped', (e) => {
      $('cp-log-note').textContent = t('The first {size} of the log are not shown here - the whole log: {path}', { size: mib(Number(e.data)), path: this.run.log });
    });
    es.addEventListener('busy', (e) => { $('cp-log-note').textContent = e.data; });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) $('cp-log-note').textContent = t('The log stream closed.');
    };
  }

  //
  // pollLog - a backend without streamed responses: the log file by Range, and the record, every second
  //
  async pollLog(from) {
    const name = this.run.name;
    try {
      const r = await fetch('/api/builds/' + encodeURIComponent(name) + '/log', { headers: { Range: 'bytes=' + from + '-' } });
      if (r.status === 206 || r.status === 200) {
        const text = await r.text();
        const cut = text.lastIndexOf('\n') + 1;
        if (cut > 0) { this.append(text.slice(0, cut - 1)); from += new TextEncoder().encode(text.slice(0, cut)).length; }
      }
      this.run = await api.build(name);
      this.runLines = this.run.lines;
      this.renderRun();
    } catch (e) { /* the next round */ }
    if (this.run && this.run.name === name && this.run.state === 'running') this.poll = setTimeout(() => this.pollLog(from), 1000);
    else { this.loadBuilds(); this.commandSoon(); if (this.run && this.run.name === name) this.ended(this.run); }
  }

  //
  // ended - a build followed here has ended: a popup says so - "Start it" opens Operate with it chosen (its image
  // when it made one, else the build itself, natively)
  //
  ended(b) {
    if (this.followed !== b.name) return;
    this.followed = null;
    const ok = b.state === 'succeeded';
    $('cp-done-title').textContent = ok ? t('The compilation is done') : t('The compilation {state}', { state: stateText(b.state) });
    $('cp-done-what').textContent = ok
      ? (b.image ? t('{name}, and its image {image}', { name: b.name, image: b.image }) : b.name) + ' · ' + duration(b.seconds || 0)
      : (b.error || '');
    $('cp-done-start').hidden = !ok;
    $('cp-done-start').onclick = () => {
      $('cp-done').close();
      window.dispatchEvent(new CustomEvent('c3:run', { detail: b.image ? { image: b.image } : { build: b.name } }));
    };
    $('cp-done-close').onclick = () => $('cp-done').close();
    if (!$('cp-done').open) $('cp-done').showModal();
    if (ok) $('cp-done-start').focus();
  }

  //
  // append - lines of output, kept to the last 20 000 in the page (the log file has them all)
  //
  append(text) {
    const pre = $('cp-log');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      if (line.trim() !== '') { this.lastLine = line.trim(); this.lastLineAt = Date.now(); }
      let cls = '';
      if (line.startsWith('coraine-build: phase ')) cls = 'ph';
      else if (line.startsWith('c3: ')) cls = 'c3';
      else if (/\berror\b|coraine-build: .*(failed|no |not )/i.test(line) && !/-Werror|error\.[ch]/.test(line)) cls = 'er';
      const s = cls ? el('span', cls, line + '\n') : document.createTextNode(line + '\n');
      frag.append(s);
    }
    pre.append(frag);
    while (pre.childNodes.length > 20000) pre.firstChild.remove();
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }

  renderElapsed() {
    const b = this.run;
    if (!b) return;
    const s = b.ended ? b.seconds : Math.max(0, Math.round((Date.now() - new Date(b.started).getTime()) / 1000));
    $('cp-run-elapsed').textContent = duration(s);
    this.renderNow();
    if (b.state === 'running') this.renderProgress();
  }

  //
  // showRun - the build panel scrolled into view: Build is in the side column, the panel at the page's top
  //
  showRun() {
    const panel = $('cp-run');
    if (panel.hidden) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('cp-log').focus({ preventScroll: true });
  }

  //
  // renderNow - while a build runs: the phase and how long it has run, the last line of output - and, when
  // nothing came for a while, for how long (PGO's training runs minutes without a line); the same, short,
  // under the side column's Build button
  //
  renderNow() {
    const b = this.run;
    const now = $('cp-now');
    const side = $('cp-building');
    //
    // Nothing changes size while the panel is open: the line keeps its height (CSS) and says how the build ended,
    // the side column's line stays until the panel is closed
    //
    if (!b) { now.replaceChildren(); side.hidden = true; return; }
    if (b.state !== 'running') {
      const how = t('{state} in {time}', { state: stateText(b.state), time: duration(b.seconds || 0) });
      const view = (v, label) => {
        const btn = el('button', 'btn small cp-view', label);
        btn.type = 'button';
        btn.dataset.v = v;
        btn.setAttribute('aria-pressed', String(this.view === v));
        btn.addEventListener('click', () => { this.viewPicked = true; this.showView(v); });
        return btn;
      };
      if (!now.querySelector('.cp-view')) now.replaceChildren(el('span', '', how + ' '), view('result', t('Result')), view('log', t('Output')));
      side.hidden = false;
      side.textContent = b.name + ' - ' + how + ' · show ↑';
      return;
    }
    const p = b.phases && b.phases.find((x) => x.name === b.phase);
    const since = p ? p.at : b.started;
    const inPhase = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
    const quiet = Math.round((Date.now() - (this.lastLineAt || Date.now())) / 1000);
    const parts = [el('span', '', t('{phase} for {time}', { phase: b.phase || 'unpack', time: duration(inPhase) }))];
    if (quiet >= 15) parts.push(el('span', 'quiet', ' · ' + t('no output for {time} - still working', { time: duration(quiet) })));
    if (this.lastLine) parts.push(document.createTextNode(' · '), el('span', 'ln', this.lastLine));
    const what = PHASE_WHAT[b.phase || 'unpack'] ? t(PHASE_WHAT[b.phase || 'unpack']) : '';
    if (b.mode === 'tune' && b.phase === 'train') parts.push(el('div', 'what', t('Training on your workload, then measuring the allocator and lock policy on it - 10 minutes and more.')));
    else if (what) parts.push(el('div', 'what', what));
    now.replaceChildren(...parts);
    side.hidden = false;
    side.textContent = t('Building {name} - {phase}, {time} · show ↑', { name: b.name, phase: b.phase || 'unpack', time: $('cp-run-elapsed').textContent });
  }

  renderRun() {
    const b = this.run;
    if (!b) return;
    $('cp-run-name').textContent = b.name;
    const st = $('cp-run-state');
    st.textContent = stateText(b.state);
    st.className = 'badge ' + b.state;
    $('cp-cancel').style.visibility = b.state === 'running' ? 'visible' : 'hidden';   // keeps its place: nothing beside it moves
    $('cp-cancel').disabled = false;
    this.renderElapsed();

    const names = phasesOf(b);
    //
    // The phases as a flow, unpack -> build -> ...: finished green, the current one magenta, the rest grey; the
    // phase a build ended in red when it failed (outlined when it was cancelled)
    //
    const shown = names.filter((n) => n !== 'done');
    const cur = b.phase === 'done' ? shown.length : Math.max(0, shown.indexOf(b.phase || 'unpack'));
    const flow = [];
    shown.forEach((n, i) => {
      let cls = 'todo';
      let what = t('not started');
      if (b.state === 'succeeded' || i < cur) { cls = 'done'; what = t('finished'); }
      else if (i === cur && b.state === 'running') { cls = 'now'; what = t('running'); }
      else if (i === cur && b.state === 'failed') { cls = 'failed'; what = t('failed here'); }
      else if (i === cur) { cls = 'stopped'; what = t('{state} here', { state: stateText(b.state) }); }
      if (i > 0) {
        const arrow = el('span', 'cp-arrow ' + (cls === 'todo' ? 'todo' : cls === 'now' || cls === 'failed' || cls === 'stopped' ? 'into' : 'done'));
        arrow.setAttribute('aria-hidden', 'true');
        flow.push(arrow);
      }
      const step = el('span', 'cp-phase ' + cls);
      step.append(el('span', 'dot', cls === 'done' ? '✓' : cls === 'failed' ? '✕' : ''), el('span', 'lbl', n));
      step.title = n + ' - ' + what;
      step.setAttribute('aria-label', n + ', ' + what);
      flow.push(step);
    });
    $('cp-phases').replaceChildren(...flow);
    this.renderProgress();

    if (b.state === 'running') {
      this.showView('log');
      return;
    }
    this.renderResult(b);
    if (!this.viewPicked) this.showView('result');
  }

  //
  // showView - the result or the output, in the same box: a finished build's result does not push the page down
  //
  showView(v) {
    this.view = v;
    $('cp-result').hidden = v !== 'result';
    $('cp-log').hidden = v === 'result';
    for (const btn of document.querySelectorAll('#cp-now .cp-view')) btn.setAttribute('aria-pressed', String(btn.dataset.v === v));
  }

  //
  // renderProgress - the phases done, and how far into the current one: its lines against the same phase
  // of the last build of this mode that succeeded (its times as the phases' weights), else the defaults
  //
  renderProgress() {
    const b = this.run;
    const bar = $('cp-bar');
    bar.className = 'cp-bar ' + (b.state === 'failed' || b.state === 'interrupted' ? 'failed' : b.state === 'cancelled' ? 'cancelled' : '');
    if (b.state === 'succeeded') { $('cp-bar-fill').style.width = '100%'; return; }

    const names = phasesOf(b);
    const prev = this.builds.find((x) => x.state === 'succeeded' && x.mode === b.mode && x.name !== b.name && x.phases && x.phases.length);
    const at = (build, n) => {             // [line, time] at which phase n started in 'build'
      if (n === 'unpack') return [2, new Date(build.started).getTime() / 1000];
      const p = build.phases.find((x) => x.name === n);
      return p ? [p.line, new Date(p.at).getTime() / 1000] : null;
    };
    const weight = {};
    const lines = {};
    const mw = MODE_WEIGHTS[b.mode] || {};
    names.forEach((n, i) => {
      weight[n] = mw[n] || WEIGHTS[n] || 1;
      if (prev && i + 1 < names.length) {
        const a = at(prev, n);
        const z = (i + 1 < names.length) ? at(prev, names[i + 1]) : null;
        if (a && z) { weight[n] = Math.max(0.5, z[1] - a[1]); lines[n] = Math.max(1, z[0] - a[0]); }
      }
    });
    const total = names.reduce((s, n) => s + weight[n], 0);
    const cur = Math.max(0, names.indexOf(b.phase));
    let done = 0;
    for (let i = 0; i < cur; i++) done += weight[names[i]];
    const start = at(b, names[cur]);
    let frac = 0.5;
    let over = false;                      // the phase has outrun its estimate: the bar says "working", not a number
    if (start && lines[names[cur]]) {
      const f = (this.runLines - start[0]) / lines[names[cur]];
      over = f >= 0.97;
      frac = Math.min(0.97, Math.max(0, f));
    } else if (start) {
      const f = (Date.now() / 1000 - start[1]) / (weight[names[cur]] * 1.5 || 1);
      over = f >= 0.9;
      frac = Math.min(0.9, f);
    }
    const quiet = Date.now() - (this.lastLineAt || Date.now()) >= 15000;
    if (b.state === 'running' && (over || quiet)) bar.classList.add('busy');
    const pct = Math.min(99, Math.round(100 * (done + weight[names[cur]] * frac) / total));
    $('cp-bar-fill').style.width = pct + '%';
    $('cp-bar').title = pct + '%';
  }

  renderResult(b) {
    const dl = $('cp-result');
    const row = (k, v) => { dl.append(el('dt', '', k)); const dd = el('dd'); if (typeof v === 'string') dd.textContent = v; else dd.append(v); dl.append(dd); };
    dl.replaceChildren();

    if (b.state === 'succeeded') {
      row(t('Size'), t('{size} on disk (install/), the broker {binary}', { size: mib(b.installBytes), binary: mib(b.binaryBytes) }));
    } else {
      row(t('Result'), b.error || stateText(b.state));
    }
    row(t('Built as'), (MODE_LABEL[b.mode] ? t(MODE_LABEL[b.mode]) : b.mode) + ' · ' + duration(b.seconds || 0) + ' · ' + when(b.started));

    if (b.builtFeatures) {
      const chips = el('div', 'cp-chips');
      for (const [name, on] of Object.entries(b.builtFeatures)) chips.append(el('span', 'cp-chip' + (on ? '' : ' off'), name));
      row(t('Features'), chips);
    } else {
      const asked = Object.entries(b.features || {}).map(([n, v]) => n + '=' + (v ? 'ON' : 'OFF')).join(', ');
      row(t('Features'), asked || t('the defaults'));
    }
    if (b.version) row('--version', el('pre', 'cp-ver', b.version.trim()));
    if (b.image) {
      const img = el('span', 'cp-chips');
      const nm = el('span', 'mono', b.image);
      const cp = el('button', 'btn', t('Copy'));
      cp.type = 'button';
      cp.addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(b.image));
      img.append(nm, cp);
      if (b.imageMiB) img.append(el('span', 'cp-note', t('{n} MiB', { n: b.imageMiB })));
      img.append(el('span', 'cp-note', t('by hand: {command}', { command: 'docker run --rm -p 1026:1026 ' + b.image + ' --database corDB' })));
      row(t('Image'), img);
      if (b.imageFile) {
        const fb = el('span', 'cp-chips');
        const fc = el('button', 'btn', t('Copy'));
        fc.type = 'button';
        fc.addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(b.imageFile));
        fb.append(el('span', 'mono', b.imageFile), fc);
        if (b.imageFileMiB) fb.append(el('span', 'cp-note', t('{n} MiB', { n: b.imageFileMiB })));
        fb.append(el('span', 'cp-note', t('on another machine: {command}', { command: 'docker load -i image.tar.gz' })));
        row(t('Image file'), fb);
      }
    } else if (b.imageAsked && b.state !== 'running') row(t('Image'), t('not made: {why}', { why: b.error || stateText(b.state) }));

    const dir = el('span', 'cp-chips');
    const path = el('span', 'mono', b.state === 'succeeded' ? b.install : b.dir);
    const copy = el('button', 'btn', t('Copy'));
    copy.type = 'button';
    copy.addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(path.textContent));
    dir.append(path, copy);
    row(t('Directory'), dir);

    const log = el('a', '', t('the whole log'));
    log.href = '/api/builds/' + encodeURIComponent(b.name) + '/log';
    log.target = '_blank';
    row(t('Log'), log);

    const runIt = el('button', 'btn primary', t('Run it'));
    runIt.type = 'button';
    runIt.title = t('Run: this build in the form, natively');
    runIt.addEventListener('click', () => window.dispatchEvent(new CustomEvent('c3:run', { detail: { build: b.name } })));
    const ri = el('span', 'cp-chips');
    ri.append(runIt, el('span', 'cp-note', t('opens Run with this build - by hand: {command}', { command: '. ' + b.install + '/env; ' + (b.executable || 'coraine') + ' --database corDB' })));
    if (b.state === 'succeeded') row('', ri);

  }

  // ------------------------------------------------------------------ builds kept

  async loadBuilds() {
    try {
      const r = await api.builds();
      this.builds = r.builds || [];
      $('cp-bdir').textContent = r.dir;
    } catch (e) {
      this.builds = [];
    }
    this.renderBuilds();
  }

  renderBuilds() {
    const box = $('cp-builds');
    $('cp-bcount').textContent = this.builds.length ? String(this.builds.length) : '';
    if (!this.builds.length) {
      box.replaceChildren(el('span', 'cp-note', t('None yet.')));
      return;
    }
    box.replaceChildren(...this.builds.map((b) => {
      const item = el('div', 'cp-bitem' + (this.run && this.run.name === b.name ? ' sel' : ''));
      const open = el('button', 'bopen');
      open.type = 'button';
      const meta = [MODE_LABEL[b.mode] ? t(MODE_LABEL[b.mode]) : b.mode, when(b.started)];
      if (b.installBytes) meta.push(mib(b.installBytes));
      if (b.image) meta.push(t('Docker image'));
      const off = Object.entries(b.features || {}).filter(([, v]) => !v).map(([n]) => n);
      if (off.length) meta.push(t('{list} off', { list: off.join(', ') }));
      open.append(el('span', 'bn', b.name), el('span', 'bm', meta.join(' · ')));
      open.addEventListener('click', () => this.open(b));
      const badge = el('span', 'badge ' + b.state, stateText(b.state));
      item.append(open, badge);
      if (b.state !== 'running') {
        const del = el('button', 'btn bdel' + (this.armed === b.name ? ' armed' : ''), this.armed === b.name ? t('Sure?') : t('Delete'));
        del.type = 'button';
        del.addEventListener('click', () => this.remove(b));
        item.append(del);
      }
      return item;
    }));
  }

  //
  // remove - Delete pressed twice: the directory, the log and the record
  //
  async remove(b) {
    if (this.armed !== b.name) {
      this.armed = b.name;
      this.renderBuilds();
      setTimeout(() => { if (this.armed === b.name) { this.armed = null; this.renderBuilds(); } }, 4000);
      return;
    }
    this.armed = null;
    try {
      await api.buildDelete(b.name);
      if (this.run && this.run.name === b.name) this.closeRun();
    } catch (e) {
      $('cp-bdir').textContent = e.message;
    }
    this.loadBuilds();
  }

  // ------------------------------------------------------------------ presets

  renderPresets() {
    const sel = $('cp-preset');
    const cur = sel.value;
    sel.replaceChildren(...(this.presets.length ? this.presets.map((p) => {
      const o = el('option', '', p.name + ' - ' + (MODE_LABEL[p.mode] ? t(MODE_LABEL[p.mode]) : p.mode || 'release'));
      o.value = p.name;
      return o;
    }) : [el('option', '', t('no presets yet'))]));
    if (cur && this.presets.find((p) => p.name === cur)) sel.value = cur;
    $('cp-preset-load').disabled = $('cp-preset-del').disabled = !this.presets.length;
    $('cp-pcount').textContent = this.presets.length ? String(this.presets.length) : '';
  }

  presetSave() {
    const name = $('cp-preset-name').value.trim();
    if (!name) { $('cp-preset-name').focus(); return; }
    const p = { name, mode: this.choice.mode, features: this.changedFeatures(), bridges: { ...this.choice.bridges } };
    if (this.choice.httpServer !== 'mhd') p.httpServer = this.choice.httpServer;
    if (this.choice.mode === 'tune' && this.choice.workload) p.workload = this.choice.workload;
    if (this.choice.output === 'image') p.output = 'image';
    if (this.choice.imageFile) p.imageFile = true;
    api.compilePresetSave(p).then((config) => {
      this.presets = (config.compile && config.compile.presets) || [];
      $('cp-preset-name').value = '';
      this.renderPresets();
      $('cp-preset').value = name;
    }).catch((e) => { $('cp-preset-name').value = ''; $('cp-preset-name').placeholder = e.message; });
  }

  presetLoad() {
    const p = this.presets.find((x) => x.name === $('cp-preset').value);
    if (!p) return;
    this.choice = { mode: p.mode || 'release', httpServer: p.httpServer || 'mhd', features: { ...(p.features || {}) }, bridges: { ...(p.bridges || {}) }, workload: p.workload || '', output: p.output === 'image' ? 'image' : 'binary', imageFile: p.imageFile === true };
    this.changed();
  }

  presetDelete() {
    const name = $('cp-preset').value;
    if (!this.presets.find((x) => x.name === name)) return;
    api.compilePresetDelete(name).then((config) => {
      this.presets = (config.compile && config.compile.presets) || [];
      this.renderPresets();
    }).catch(() => {});
  }
}
