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
const WEIGHTS = { unpack: 3, build: 80, tools: 12, train: 70, install: 2, bridges: 10, check: 2, done: 0 };

const MODES = [
  ['release', 'Release',              'Optimised build, no training. Traces compiled out.'],
  ['pgo',     'Profile-guided',       'Built instrumented, trained on the standard request shapes, rebuilt with the profile.'],
  ['tune',    'Tuned for a workload', 'Trained on your workload; allocator and lock policy measured on it.'],
  ['debug',   'Debug',                'Traces compiled in (--traceLevels works) - for reproducing a crash report.'],
];
const MODE_LABEL = Object.fromEntries(MODES.map(([id, label]) => [id, label]));

const mib = (b) => (b / (1024 * 1024)).toFixed(1) + ' MiB';
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const duration = (s) => (s >= 60 ? Math.floor(s / 60) + ' min ' : '') + (s % 60) + ' s';

//
// shellQuote - as the backend quotes the command it runs
//
//
// The HTTP servers coraine-build builds with (--http-server); mhd is its default
//
const HTTP_SERVERS = [
  ['mhd',     'libmicrohttpd',      'An external library (libmicrohttpd 1.0.10). Everything is built.'],
  ['builtin', 'corHttp (built in)', 'No external library. One listener - what needs a second port is not built.'],
];
const HTTP_LABEL = Object.fromEntries(HTTP_SERVERS.map(([id, label]) => [id, label]));

//
// The build settings a switch may need ("requires": ["HTTP_SERVER=mhd"]): what to call them, why the
// switch needs them, and the choice that gives them back
//
const SETTINGS = {
  'HTTP_SERVER=mhd': {
    label: 'the libmicrohttpd HTTP server',
    why:   'it listens on a port of its own, and only libmicrohttpd has a second listener - corHttp has one',
    give:  'choose libmicrohttpd under HTTP server',
  },
};

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
const HTTP_DOC = { mhd: 'HTTP server: libmicrohttpd', builtin: 'HTTP server: corHttp (built in)' };
const STORE_DOC = { false: 'Store: corDB only', true: 'Store: corDB + mongoc' };
const BRIDGE_DOC = { mqtt: 'MQTT', modbus: 'Modbus', dds: 'DDS', ckan: 'CKAN' };

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
function helpShow(title, text) {
  const ov = el('div', 'overlay cp-modal');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', title);
  const card = el('div', 'card cp-help-card');
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const ok = el('button', 'btn', 'Close');
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
// helpButton - the '?' of a box; null when the source's doc has no section for it
//
function helpButton(section, inline) {
  if (!section) return null;
  const q = el('button', 'cp-q' + (inline ? ' inline' : ''), '?');
  q.type = 'button';
  q.title = 'What is ' + section.title.replace(/`/g, '') + '?';
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
    this.features = [];           // [{name, default, description, group, requires}]
    this.openGroups = openGroupsLoad();   // the groups shown open
    this.featureError = '';
    this.doc = new Map();         // the source's doc/building-details.md, by "#### " heading
    this.bridges = [];            // [{name, default, description, available, why}] - coraine-build --list-bridges
    this.choice = { mode: 'release', httpServer: 'mhd', features: {}, bridges: {}, workload: '' };
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

    $('cp-build').addEventListener('click', () => this.start());
    $('cp-cancel').addEventListener('click', () => this.cancel());
    $('cp-run-close').addEventListener('click', () => this.closeRun());
    $('cp-name').addEventListener('input', () => this.commandSoon());
    $('cp-workload-path').addEventListener('input', () => { this.choice.workload = $('cp-workload-path').value.trim(); this.changed(); });
    $('cp-preset-save').addEventListener('click', () => this.presetSave());
    $('cp-preset-load').addEventListener('click', () => this.presetLoad());
    $('cp-preset-del').addEventListener('click', () => this.presetDelete());
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
      };
    }
    this.presets = Array.isArray(c.presets) ? c.presets : [];
    this.renderPresets();
  }

  //
  // refresh - capabilities, features and builds again (the page is shown: something may have been installed)
  //
  async refresh() {
    try {
      this.caps = await api.capabilities();
    } catch (e) {
      this.caps = { compile: { available: false, why: 'the backend does not answer: ' + e.message } };
    }
    const cc = this.caps.compile;

    $('cp-host').textContent = 'build host · ' + (this.caps.host || 'this machine');
    $('page-compile').classList.toggle('cp-off', !cc.available);
    $('cp-unavail').hidden = !!cc.available;
    $('cp-unavail-why').textContent = cc.why ? cc.why.charAt(0).toUpperCase() + cc.why.slice(1) + '.' : '';
    $('cp-build').disabled = !cc.available;

    if (cc.available && this.features.length === 0) {
      try {
        const f = await api.compileFeatures();
        this.features = f.features || [];
        this.doc = docSections(f.doc);
        this.bridges = Array.isArray(f.bridges) ? f.bridges : [];
        this.featureError = '';
      } catch (e) {
        this.featureError = e.message;
      }
    }

    //
    // No mongo-c driver and no choice made: corDB only, which builds
    //
    if (cc.available && !cc.mongoc && !('MONGOC' in this.choice.features)) this.choice.features.MONGOC = false;

    this.render();
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
  // forcedOff - a switch is off whatever is chosen when one it requires is off (CMakeLists.txt)
  //
  forcedBy(f) {
    return (f.requires || []).filter((r) => !this.reqMet(r));
  }

  //
  // reqMet - a requirement holds: a switch that is on, or a build setting coraine-build builds with (NAME=value)
  //
  reqMet(r) {
    const eq = r.indexOf('=');
    if (eq < 0) return this.isOn(r);
    const built = { HTTP_SERVER: this.choice.httpServer || 'mhd' };
    return built[r.slice(0, eq)] === r.slice(eq + 1);
  }

  reqLabel(r) {
    return (r.indexOf('=') < 0) ? r : ((SETTINGS[r] && SETTINGS[r].label) || r);
  }

  //
  // forcedWhy - a forced-off switch's explanation, for its tooltip: what it needs, why, and how to have it
  //
  forcedWhy(f, forced) {
    return forced.map((r) => {
      const st = SETTINGS[r];
      return st ? `${f.name} needs ${st.label}: ${st.why}. To have it, ${st.give}.`
                : `${f.name} needs ${r}, which is off. To have it, switch ${r} on.`;
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
    ov.setAttribute('aria-label', 'Switch to ' + HTTP_LABEL[id]);
    const card = el('div', 'card');
    const list = el('ul', 'cp-lost');
    for (const f of lost) {
      const li = el('li');
      li.append(el('span', 'mono', f.name), el('span', '', ' - ' + f.description));
      const why = (f.requires || []).filter((r) => SETTINGS[r]).map((r) => SETTINGS[r].why);
      if (why.length) li.append(el('div', 'why', 'Not built: ' + why.join('; ') + '.'));
      list.append(li);
    }
    const yes = el('button', 'btn primary', 'Switch to ' + HTTP_LABEL[id]);
    const no = el('button', 'btn', 'Keep ' + HTTP_LABEL[this.choice.httpServer]);
    yes.type = no.type = 'button';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    yes.addEventListener('click', () => { close(); apply(); });
    no.addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    const actions = el('div', 'actions');
    actions.append(yes, no);
    card.append(el('h3', '', 'Switch to ' + HTTP_LABEL[id] + '?'),
                el('p', '', `With ${HTTP_LABEL[id]}, ${lost.length === 1 ? 'this switch is' : 'these switches are'} not built:`),
                list,
                el('p', '', 'Switching back to ' + HTTP_LABEL[this.choice.httpServer] + ' turns ' + (lost.length === 1 ? 'it' : 'them') + ' on again.'),
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
    const on = this.bridges.filter((br) => br.available && this.isBridgeOn(br)).map((br) => br.name);
    const def = this.bridges.filter((br) => br.default).map((br) => br.name);
    return (on.join(',') === def.join(',')) ? undefined : on;
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
  // pill - a segmented choice, its size and its '?' beside it
  //
  pill(b, section) {
    const size = docSize(section && section.text);
    if (size) b.append(el('span', 'psz', ' ' + size));
    const q = helpButton(section, true);
    if (!q) return b;
    const w = el('span', 'cp-segitem');
    w.append(b, q);
    return w;
  }

  docAt(title) {
    return this.doc.has(title) ? { title, text: this.doc.get(title) } : null;
  }

  render() {
    const cc = (this.caps && this.caps.compile) || {};

    //
    // Target and HTTP server: not in coraine-build yet - the host's own shown, greyed
    //
    const seg = (id, labels, current) => {
      const box = $(id);
      box.replaceChildren(...labels.map((label) => {
        const b = el('button', '', label);
        b.type = 'button';
        b.disabled = true;
        b.setAttribute('aria-pressed', String(label === current));
        return b;
      }));
    };
    const arch = (this.caps && this.caps.arch) || '';
    seg('cp-arch', ['amd64', 'arm64'], arch === 'x86_64' ? 'amd64' : arch === 'aarch64' ? 'arm64' : '');
    seg('cp-dist', ['this machine'], 'this machine');
    seg('cp-output', ['Binary', 'Docker image', 'Debian package'], 'Binary');

    //
    // HTTP server: libmicrohttpd or corHttp - corHttp not with a training build (coraine-build refuses)
    //
    const isTraining = (m) => (m === 'pgo' || m === 'tune');
    const http = $('cp-http');
    http.replaceChildren(...HTTP_SERVERS.map(([id, label, desc]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.choice.httpServer === id));
      const blocked = (id === 'builtin') && isTraining(this.choice.mode);
      if (blocked) b.setAttribute('aria-disabled', 'true');
      b.title = blocked ? `Not with ${MODE_LABEL[this.choice.mode]} yet: coraine-build trains with libmicrohttpd only. Choose Release or Debug for corHttp.` : desc;
      b.addEventListener('click', () => { if (!blocked) this.httpServerSet(id); });
      return this.pill(b, this.docAt(HTTP_DOC[id]));
    }));
    const lostNow = this.features.filter((f) => (f.requires || []).some((r) => SETTINGS[r]) && this.forcedBy(f).length > 0).map((f) => f.name);
    $('cp-http-note').textContent = (this.choice.httpServer === 'builtin')
      ? 'No external library.' + (lostNow.length ? ' Not built with it: ' + lostNow.join(', ') + '.' : '')
      : '';

    //
    // Stores: corDB is always built; mongoc is the MONGOC switch
    //
    const mongoc = this.isOn('MONGOC');
    const store = $('cp-store');
    store.replaceChildren(...[['corDB only', false], ['corDB + mongoc', true]].map(([label, value]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(mongoc === value));
      b.addEventListener('click', () => { this.choice.features.MONGOC = value; this.changed(); });
      return this.pill(b, this.docAt(STORE_DOC[value]));
    }));
    const sn = $('cp-store-note');
    sn.textContent = (!cc.mongoc && mongoc) ? 'The mongo-c driver v2 is not installed here: this build would stop. corDB only, or install it.' : (!cc.mongoc ? 'mongoc needs the mongo-c driver v2 (not installed here).' : '');
    sn.className = 'cp-note' + ((!cc.mongoc && mongoc) ? ' warn' : '');

    //
    // Features
    //
    const list = $('cp-features');
    const shown = this.features.filter((f) => f.name !== 'MONGOC');
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
      if (size) txt.append(el('span', 'fsz', (size === 'no effect yet') ? 'compiled out: no effect yet' : (f.default ? 'off: ' : 'on: ') + size));
      const needs = (f.requires || []).map((r) => this.reqLabel(r));
      if (forced.length) txt.append(el('span', 'fr', 'Off: needs ' + needs.join(' and ') + ' - ' + forced.map((r) => this.reqLabel(r)).join(' and ') + (forced.length > 1 ? ' are' : ' is') + ' off'));
      else if (needs.length) txt.append(el('span', 'fq', 'Needs ' + needs.join(' and ')));
      txt.append(el('span', 'fdef', 'default ' + (f.default ? 'on' : 'off') + ((this.isOn(f.name) !== !!f.default) ? ' · changed' : '')));
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
      head.append(el('span', 'chev', open ? '▾' : '▸'), el('span', 'gname', name),
                  el('span', 'gcount', `${gOn} of ${items.length} on`));
      if (changed) head.append(el('span', 'gchanged', changed + ' changed'));
      head.addEventListener('click', () => {
        if (this.openGroups.has(name)) this.openGroups.delete(name); else this.openGroups.add(name);
        openGroupsSave(this.openGroups);
        this.render();
      });

      const body = el('div', 'cp-features');
      body.setAttribute('role', 'group');
      body.setAttribute('aria-label', name);
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
      const isOn = br.available && this.isBridgeOn(br);
      const changed = this.isBridgeOn(br) !== !!br.default;
      const b = el('button', 'cp-feature' + (changed ? ' changed' : ''));
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(isOn));
      if (!br.available) b.setAttribute('aria-disabled', 'true');
      b.title = br.available ? br.description : 'Not here: ' + br.why;
      const txt = el('span', 'txt');
      txt.append(el('span', 'fn', br.name), el('span', 'fd', br.description));
      const section = this.docAt('Bridge: ' + (BRIDGE_DOC[br.name] || br.name));
      const size = docSize(section && section.text);
      if (size) txt.append(el('span', 'fsz', 'on: ' + size));
      if (!br.available) txt.append(el('span', 'fr', 'Not here: ' + br.why));
      txt.append(el('span', 'fdef', 'default ' + (br.default ? 'on' : 'off') + (changed ? ' · changed' : '')));
      b.append(el('span', 'cp-fbox'), txt);
      b.addEventListener('click', () => { if (!br.available) return; this.choice.bridges[br.name] = !this.isBridgeOn(br); this.changed(); });
      return { b: withHelp(b, section, 'cp-fwrap'), isOn };
    };
    if (this.bridges.length) {
      const items = this.bridges.map(bridgeButton);
      sections.push(groupSection('Bridges', items, this.bridges.filter((br) => this.isBridgeOn(br) !== !!br.default).length));
      groups.push({ name: 'Bridges', features: [] });
    }

    list.replaceChildren(...sections);

    const all = $('cp-fexpand');
    const allOpen = groups.length > 0 && groups.every((g) => this.openGroups.has(g.name));
    all.hidden = groups.length === 0;
    all.textContent = allOpen ? 'Collapse all' : 'Expand all';
    all.onclick = () => {
      if (allOpen) this.openGroups.clear(); else groups.forEach((g) => this.openGroups.add(g.name));
      openGroupsSave(this.openGroups);
      this.render();
    };
    $('cp-fcount').textContent = shown.length ? `${on} of ${shown.length} compiled in · a feature switched off is not in the binary at all` : '';
    $('cp-fnote').textContent = this.featureError ? 'The feature list could not be read: ' + this.featureError
      : (!cc.available ? 'The switches come from the source coraine-dev installs.' : '');

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
      const byServer = trains && !b.disabled && (this.choice.httpServer === 'builtin');
      b.append(el('span', 'ol', label), el('span', 'od', desc));
      if (b.disabled) b.append(el('span', 'ow', cc.pgoWhy || 'not available here'));
      if (byServer) {
        b.setAttribute('aria-disabled', 'true');
        b.title = 'Not with corHttp yet: coraine-build trains with libmicrohttpd only. Choose libmicrohttpd under HTTP server for this.';
        b.append(el('span', 'ow', 'not with corHttp yet'));
      }
      b.addEventListener('click', () => { if (byServer) return; this.choice.mode = id; this.changed(); });
      return withHelp(b, this.docAt(MODE_DOC[id]), 'cp-owrap');
    }));
    $('cp-workload').hidden = this.choice.mode !== 'tune';
    if ($('cp-workload-path').value !== this.choice.workload) $('cp-workload-path').value = this.choice.workload;

    //
    // This build
    //
    const off = shown.filter((f) => !(this.isOn(f.name) && this.forcedBy(f).length === 0)).map((f) => f.name);
    $('cp-sum-target').textContent = (arch || 'this machine') + ' · ' + ((this.caps && this.caps.distribution) || 'this distribution') + ' · binary';
    $('cp-sum-server').textContent = HTTP_LABEL[this.choice.httpServer] + (this.choice.httpServer === 'mhd' ? ' (coraine-build\'s default)' : '');
    $('cp-sum-stores').textContent = (mongoc ? 'corDB + mongoc' : 'corDB only') + '; history none, corDB, timescale';
    $('cp-sum-opt').textContent = MODE_LABEL[this.choice.mode] + (this.choice.mode === 'tune' && this.choice.workload ? ' - ' + this.choice.workload : '');
    $('cp-sum-features').textContent = shown.length ? (off.length ? off.length + ' off: ' + off.join(', ') : 'all ' + shown.length + ' on') : '-';
    const brOn = this.bridges.filter((br) => br.available && this.isBridgeOn(br)).map((br) => br.name);
    $('cp-sum-bridges').textContent = this.bridges.length ? (brOn.length ? brOn.join(', ') : 'none') : '-';
    $('cp-sum-source').textContent = cc.version ? 'coraine ' + cc.version : (cc.source || '-');

    this.commandSoon();
  }

  //
  // changed - a choice was made: drawn again, and kept (c3.json, "compile": {"choice"})
  //
  changed() {
    this.render();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      api.compileChoice({ mode: this.choice.mode, httpServer: this.choice.httpServer, features: this.choice.features, bridges: this.choice.bridges, workload: this.choice.workload }).catch(() => {});
    }, 400);
  }

  body() {
    const b = { mode: this.choice.mode, features: this.changedFeatures() };
    const bridges = this.bridgesArg();
    if (bridges) b.bridges = bridges;
    if (this.choice.httpServer !== 'mhd') b.httpServer = this.choice.httpServer;
    const name = $('cp-name').value.trim();
    if (name) b.name = name;
    if (this.choice.mode === 'tune') b.workload = this.choice.workload;
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
      $('cp-build').disabled = !(this.caps && this.caps.compile.available) || (this.run && this.run.state === 'running');
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
      this.open(build);
      this.loadBuilds();
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
    this.run = build;
    this.runLines = build.lines || 0;
    $('cp-run').hidden = false;
    $('cp-log').replaceChildren();
    $('cp-log-note').textContent = '';
    $('cp-result').hidden = true;
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
    });
    es.addEventListener('skipped', (e) => {
      $('cp-log-note').textContent = 'The first ' + mib(Number(e.data)) + ' of the log are not shown here - the whole log: ' + this.run.log;
    });
    es.addEventListener('busy', (e) => { $('cp-log-note').textContent = e.data; });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) $('cp-log-note').textContent = 'The log stream closed.';
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
    else { this.loadBuilds(); this.commandSoon(); }
  }

  //
  // append - lines of output, kept to the last 20 000 in the page (the log file has them all)
  //
  append(text) {
    const pre = $('cp-log');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
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
  }

  renderRun() {
    const b = this.run;
    if (!b) return;
    $('cp-run-name').textContent = b.name;
    const st = $('cp-run-state');
    st.textContent = b.state;
    st.className = 'badge ' + b.state;
    $('cp-cancel').hidden = b.state !== 'running';
    $('cp-cancel').disabled = false;
    this.renderElapsed();

    const names = PHASES[b.mode] || PHASES.release;
    const reached = new Set(['unpack', ...b.phases.map((p) => p.name)]);
    $('cp-phases').replaceChildren(...names.filter((n) => n !== 'done').map((n) => {
      const cls = (n === b.phase && b.state === 'running') ? 'now' : (reached.has(n) ? 'done' : '');
      return el('span', 'cp-phase ' + cls, n);
    }));
    this.renderProgress();

    if (b.state === 'running') {
      $('cp-result').hidden = true;
      return;
    }
    this.renderResult(b);
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

    const names = PHASES[b.mode] || PHASES.release;
    const prev = this.builds.find((x) => x.state === 'succeeded' && x.mode === b.mode && x.name !== b.name && x.phases && x.phases.length);
    const at = (build, n) => {             // [line, time] at which phase n started in 'build'
      if (n === 'unpack') return [2, new Date(build.started).getTime() / 1000];
      const p = build.phases.find((x) => x.name === n);
      return p ? [p.line, new Date(p.at).getTime() / 1000] : null;
    };
    const weight = {};
    const lines = {};
    names.forEach((n, i) => {
      weight[n] = WEIGHTS[n] || 1;
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
    if (start && lines[names[cur]]) frac = Math.min(0.97, Math.max(0, (this.runLines - start[0]) / lines[names[cur]]));
    else if (start) frac = Math.min(0.9, (Date.now() / 1000 - start[1]) / (weight[names[cur]] * 1.5 || 1));
    const pct = Math.min(99, Math.round(100 * (done + weight[names[cur]] * frac) / total));
    $('cp-bar-fill').style.width = pct + '%';
    $('cp-bar').title = pct + '%';
  }

  renderResult(b) {
    const dl = $('cp-result');
    const row = (k, v) => { dl.append(el('dt', '', k)); const dd = el('dd'); if (typeof v === 'string') dd.textContent = v; else dd.append(v); dl.append(dd); };
    dl.replaceChildren();

    if (b.state === 'succeeded') {
      row('Size', mib(b.installBytes) + ' on disk (install/), the broker ' + mib(b.binaryBytes));
    } else {
      row('Result', b.error || b.state);
    }
    row('Built as', MODE_LABEL[b.mode] + ' · ' + duration(b.seconds || 0) + ' · ' + when(b.started));

    if (b.builtFeatures) {
      const chips = el('div', 'cp-chips');
      for (const [name, on] of Object.entries(b.builtFeatures)) chips.append(el('span', 'cp-chip' + (on ? '' : ' off'), name));
      row('Features', chips);
    } else {
      const asked = Object.entries(b.features || {}).map(([n, v]) => n + '=' + (v ? 'ON' : 'OFF')).join(', ');
      row('Features', asked || 'the defaults');
    }
    if (b.version) row('--version', el('pre', 'cp-ver', b.version.trim()));

    const dir = el('span', 'cp-chips');
    const path = el('span', 'mono', b.state === 'succeeded' ? b.install : b.dir);
    const copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(path.textContent));
    dir.append(path, copy);
    row('Directory', dir);

    const log = el('a', '', 'the whole log');
    log.href = '/api/builds/' + encodeURIComponent(b.name) + '/log';
    log.target = '_blank';
    row('Log', log);

    const runIt = el('button', 'btn primary', 'Run it');
    runIt.type = 'button';
    runIt.title = 'Run: this build in the form, natively';
    runIt.addEventListener('click', () => window.dispatchEvent(new CustomEvent('c3:run', { detail: { build: b.name } })));
    const ri = el('span', 'cp-chips');
    ri.append(runIt, el('span', 'cp-note', 'opens Run with this build - by hand: . ' + b.install + '/env; coraine -fg --database corDB'));
    if (b.state === 'succeeded') row('', ri);

    dl.hidden = false;
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
      box.replaceChildren(el('span', 'cp-note', 'None yet.'));
      return;
    }
    box.replaceChildren(...this.builds.map((b) => {
      const item = el('div', 'cp-bitem' + (this.run && this.run.name === b.name ? ' sel' : ''));
      const open = el('button', 'bopen');
      open.type = 'button';
      const meta = [MODE_LABEL[b.mode] || b.mode, when(b.started)];
      if (b.installBytes) meta.push(mib(b.installBytes));
      const off = Object.entries(b.features || {}).filter(([, v]) => !v).map(([n]) => n);
      if (off.length) meta.push(off.join(', ') + ' off');
      open.append(el('span', 'bn', b.name), el('span', 'bm', meta.join(' · ')));
      open.addEventListener('click', () => this.open(b));
      const badge = el('span', 'badge ' + b.state, b.state);
      item.append(open, badge);
      if (b.state !== 'running') {
        const del = el('button', 'btn bdel' + (this.armed === b.name ? ' armed' : ''), this.armed === b.name ? 'Sure?' : 'Delete');
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
      const o = el('option', '', p.name + ' - ' + (MODE_LABEL[p.mode] || p.mode || 'release'));
      o.value = p.name;
      return o;
    }) : [el('option', '', 'no presets yet')]));
    if (cur && this.presets.find((p) => p.name === cur)) sel.value = cur;
    $('cp-preset-load').disabled = $('cp-preset-del').disabled = !this.presets.length;
  }

  presetSave() {
    const name = $('cp-preset-name').value.trim();
    if (!name) { $('cp-preset-name').focus(); return; }
    const p = { name, mode: this.choice.mode, features: this.changedFeatures(), bridges: { ...this.choice.bridges } };
    if (this.choice.httpServer !== 'mhd') p.httpServer = this.choice.httpServer;
    if (this.choice.mode === 'tune' && this.choice.workload) p.workload = this.choice.workload;
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
    this.choice = { mode: p.mode || 'release', httpServer: p.httpServer || 'mhd', features: { ...(p.features || {}) }, bridges: { ...(p.bridges || {}) }, workload: p.workload || '' };
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
