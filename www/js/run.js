//
// run.js - the Run page: brokers started and stopped on this machine, natively or in a container, and the
// services they use
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The backend does the work (GET /api/run, POST /api/run/brokers, ...): the page shows its state, asked again
// every 1.5 s while the page is shown, and the form that makes a broker's options. A log is followed as
// server-sent events (GET /api/run/brokers/<name>/log), as Compile follows a build.
//
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, cls, onClick) {
  const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const mib = (b) => (b / (1024 * 1024)).toFixed(0) + ' MiB';
const ago = (s) => (s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min' : s + ' s');

//
// featuresOf - "features: A=1 B=0" of a --version, as {A: true, B: false}; null: not known (an image)
//
function featuresOf(version) {
  const m = /features: ([^\n]*)/.exec(version || '');
  if (!m) return null;
  const out = {};
  for (const kv of m[1].trim().split(/\s+/)) {
    const [k, v] = kv.split('=');
    if (k) out[k] = v === '1';
  }
  return out;
}

const PLUGINS = [
  ['ws',      'WebSocket transport', 'TRANSPORTS', '--transports ws'],
  ['admin',   'admin API',           'ADMIN_API',  '--apiPlugins admin'],
  ['verbose', 'verbose log',         null,         '-v'],
];

export class Run {
  constructor({ onConnect } = {}) {
    this.onConnect = onConnect || (() => {});
    this.caps = null;                 // GET /api/capabilities: "run"
    this.state = null;                // GET /api/run
    this.stateText = '';
    this.sources = null;              // GET /api/run/sources
    this.images = null;               // GET /api/run/images
    this.f = this.defaults();
    this.nameTouched = false;
    this.editing = null;              // the kept broker the form was loaded from
    this.poll = null;
    this.cmdTimer = null;
    this.sel = null;                  // the log shown: {kind: 'broker'|'service', name}
    this.es = null;
    this.armed = null;                // a button pressed once: 'forget:<name>', 'vol:<volume>'
    this.armTimer = null;
    this.shown = false;

    $('rn-start').addEventListener('click', () => this.start());
    $('rn-name').addEventListener('input', () => { this.nameTouched = $('rn-name').value.trim() !== ''; this.f.name = $('rn-name').value.trim(); this.commandSoon(); });
    $('rn-build').addEventListener('change', () => { this.f.build = $('rn-build').value; this.changed(); });
    $('rn-tag').addEventListener('input', () => { this.f.tag = $('rn-tag').value.trim(); this.changed(false); });
    $('rn-dbdir').addEventListener('change', () => { this.f.dbDir = $('rn-dbdir').checked; this.changed(); });
    $('rn-port').addEventListener('input', () => { this.f.port = parseInt($('rn-port').value, 10) || 0; this.changed(false); });
    $('rn-hport').addEventListener('input', () => { this.f.healthPort = parseInt($('rn-hport').value, 10) || 0; this.changed(false); });
    $('rn-grace').addEventListener('input', () => { this.f.grace = parseInt($('rn-grace').value, 10) || 0; this.changed(false); });
    $('rn-bconf').addEventListener('input', () => { this.f.bridgeConfig = $('rn-bconf').value.trim(); this.changed(false); });
    $('rn-args').addEventListener('input', () => { this.f.args = $('rn-args').value; this.changed(false); });
  }

  defaults() {
    return {
      name: '', set: 'cordb', from: 'installed', build: '', tag: '', where: 'native',
      store: 'corDB', dbDir: true, history: 'corDB', port: 1026, healthPort: 1027, grace: 30,
      ws: true, admin: true, verbose: true, bridges: [], bridgeConfig: '', args: '',
    };
  }

  // ------------------------------------------------------------------ shown / hidden

  async refresh() {
    this.shown = true;
    try {
      const caps = await api.capabilities();
      this.caps = caps.run || null;
      this.compileCaps = caps.compile || null;
    } catch (e) {
      this.caps = null;
    }
    try { this.sources = await api.runSources(); } catch (e) { this.sources = null; }
    await this.load();
    if (!this.portsChosen) this.choosePorts();
    this.renderForm();
    clearInterval(this.poll);
    this.poll = setInterval(() => this.load(), 1500);
    if (!this.sel && this.state && this.state.brokers.length) this.select('broker', this.state.brokers[0].name);
  }

  hide() {
    this.shown = false;
    clearInterval(this.poll);
    this.poll = null;
    this.follow(null);
  }

  //
  // preselectBuild - Compile's "Run it": the form for that build
  //
  preselectBuild(name) {
    this.editing = null;
    this.f.from = 'build';
    this.f.build = name;
    this.f.where = 'native';
    this.nameTouched = false;
    this.renderForm();
    setTimeout(() => { $('rn-form').scrollIntoView({ block: 'start' }); $('rn-start').focus(); }, 50);
  }

  async load() {
    try {
      const s = await api.run();
      const text = JSON.stringify(s);
      this.state = s;
      if (text !== this.stateText) {
        this.stateText = text;
        this.renderLists();
        this.renderEngine();
        this.renderStartButton();
      }
    } catch (e) {
      $('rn-brokers').replaceChildren(el('span', 'rn-empty', 'The backend does not answer: ' + e.message));
    }
  }

  containers() { return !!(this.caps && this.caps.containers); }

  renderEngine() {
    const e = (this.state && this.state.engine) || {};
    $('rn-engine').textContent = e.name ? e.name + ' ' + (e.version || '') : 'no containers';
    $('rn-nocont').hidden = !!e.name;
    $('rn-nocont-why').textContent = e.why ? e.why.charAt(0).toUpperCase() + e.why.slice(1) + '.' : '';
    $('page-run').classList.toggle('rn-nocontainers', !e.name);
  }

  // ------------------------------------------------------------------ the lists

  kept(name) { return this.state && this.state.brokers.find((b) => b.name === name); }

  sourceLabel(d) {
    if (d.from === 'build') return 'build ' + d.build;
    if (d.from === 'image') return d.image;
    return 'installed coraine';
  }

  renderLists() {
    const s = this.state;
    const box = $('rn-brokers');
    $('rn-bcount').textContent = s.brokers.length ? String(s.brokers.length) : '';
    if (!s.brokers.length) {
      box.replaceChildren(el('span', 'rn-empty', 'None yet - choose a set and Start, on the right.'));
    } else {
      box.replaceChildren(...s.brokers.map((b) => this.brokerItem(b)));
    }

    const sv = $('rn-services');
    if (!s.services.length) sv.replaceChildren(el('span', 'rn-empty', 'None - the sets with mongoc, timescale or MQTT start them.'));
    else sv.replaceChildren(...s.services.map((x) => this.serviceItem(x)));
  }

  brokerItem(b) {
    const d = b.def;
    const item = el('div', 'rn-item' + (this.sel && this.sel.kind === 'broker' && this.sel.name === b.name ? ' sel' : ''));
    const runs = b.state === 'running';
    let dot = '';
    if (runs && (b.ready === 'ready' || b.ready === 'answers')) dot = 'ok';
    else if (runs || b.state === 'starting' || b.state === 'stopping') dot = 'busy';
    else if (b.state === 'failed') dot = 'bad';
    item.append(el('span', 'rdot ' + dot));

    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', b.name));
    const badge = el('span', 'badge ' + (runs && b.ready ? (b.ready === 'ready' || b.ready === 'answers' ? 'ready' : 'starting') : b.state), runs && b.ready ? b.ready : b.state);
    title.append(badge);
    if (runs || b.state === 'stopping') {
      const a = el('a', 'rurl', b.url);
      a.href = '#connect';
      a.title = 'Open it in Connect';
      a.addEventListener('click', (e) => { e.preventDefault(); this.onConnect(b.url); });
      title.append(a);
    } else title.append(el('span', 'rurl', b.url));
    main.append(title);

    const meta = [this.sourceLabel(d), d.where === 'container' ? 'in a container' : 'natively',
      d.store + (d.store === 'corDB' ? (d.dbDir ? ' on disk' : ' in RAM') : ''), 'history ' + d.history];
    if (d.bridges && d.bridges.length) meta.push('bridges ' + d.bridges.join(', '));
    meta.push('port ' + d.port + (d.healthPort ? ', health ' + d.healthPort : ''));
    if (b.pid) meta.push('pid ' + b.pid + (b.attached ? ' (attached)' : ''));
    if (b.container && runs) meta.push(b.container);
    main.append(el('div', 'rmeta', meta.join(' · ')));

    if (runs && b.health) main.append(this.healthPills(b));

    if (b.state === 'stopping' && b.stop) {
      const left = Math.max(0, b.stop.grace - Math.round((Date.now() - new Date(b.stop.asked).getTime()) / 1000));
      main.append(el('div', 'rwhy warn', b.stop.killed ? 'SIGKILL sent - the grace period is over' : 'SIGTERM sent - SIGKILL in ' + left + ' s if it has not stopped (grace ' + b.stop.grace + ' s)'));
    } else if (b.state === 'starting') {
      main.append(el('div', 'rwhy warn', b.services.length ? 'starting its services, then the broker - the log follows it' : 'starting'));
    } else if (b.why) {
      main.append(el('div', 'rwhy' + (b.state === 'failed' ? ' bad' : ''), b.why));
    }
    if (b.services.length) main.append(el('div', 'rmeta', 'uses ' + b.services.join(', ')));
    const where = b.dataDir ? 'data in ' + b.dataDir : b.volume ? 'data in the volume ' + b.volume : 'data in RAM only';
    main.append(el('div', 'rmeta mono', where));
    item.append(main);

    const acts = el('div', 'racts');
    if (runs) {
      acts.append(button('Stop', '', () => this.stop(b)));
      acts.append(button('Connect', '', () => this.onConnect(b.url)));
    } else if (b.state !== 'starting' && b.state !== 'stopping') {
      const st = button('Start', 'primary', () => this.startKept(b));
      st.disabled = b.busy;
      acts.append(st);
      acts.append(button('Options', '', () => this.edit(b)));
    }
    acts.append(button('Log', '', () => this.select('broker', b.name)));
    if (!runs && b.state !== 'starting' && b.state !== 'stopping') {
      if (this.armed === 'forget:' + b.name) {
        acts.append(button('Forget, keep data', 'armed', () => this.forget(b, false)));
        if (b.dataDir || b.volume) acts.append(button('Forget and delete data', 'armed', () => this.forget(b, true)));
        acts.append(button('Cancel', '', () => this.disarm()));
      } else acts.append(button('Forget', '', () => this.arm('forget:' + b.name)));
    }
    item.append(acts);
    return item;
  }

  healthPills(b) {
    const h = b.health;
    const box = el('div', 'rhealth');
    const pill = (text, cls, title) => { const p = el('span', 'rn-pill' + (cls ? ' ' + cls : ''), text); if (title) p.title = title; box.append(p); };
    if (h.product) {                                // /version: no health port
      pill(h.product + ' ' + (h.version || ''), 'ok', 'GET /version - no health port');
      return box;
    }
    if (typeof h.uptime === 'number') pill('up ' + ago(h.uptime));
    if (h.store) pill('store ' + h.store.plugin + (h.store.loaded === false ? ' loading' : '') + (h.store.reachable === false ? ' unreachable' : ''), h.store.reachable === false || h.store.loaded === false ? 'bad' : 'ok');
    if (h.troe) pill('history ' + h.troe.plugin + (h.troe.reachable === false ? ' unreachable' : ''), h.troe.reachable === false ? 'bad' : 'ok');
    if (h.memory) pill(mib(h.memory.resident || h.memory.used || 0) + (h.memory.budget ? ' of ' + mib(h.memory.budget) : ''), h.memory.level && h.memory.level !== 'ok' ? 'warn' : '', 'resident memory');
    if (h.requests) pill(h.requests.total + ' requests' + (h.requests.inFlight ? ', ' + h.requests.inFlight + ' in flight' : ''));
    if (h.status && h.status !== 'ok') pill(h.status, 'warn');
    return box;
  }

  serviceItem(s) {
    const item = el('div', 'rn-item' + (this.sel && this.sel.kind === 'service' && this.sel.name === s.container ? ' sel' : ''));
    const runs = s.state === 'running';
    item.append(el('span', 'rdot ' + (runs ? 'ok' : (s.state === 'starting' || s.state === 'stopping') ? 'busy' : s.state === 'exited' ? 'bad' : '')));

    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', s.container), el('span', 'badge ' + s.state, s.state));
    if (s.port && runs) title.append(el('span', 'rurl', '127.0.0.1:' + s.port));
    main.append(title);
    main.append(el('div', 'rmeta', [s.label, s.image, s.status || ''].filter(Boolean).join(' · ')));
    const used = s.usedBy.length ? 'used by ' + s.usedBy.join(', ') : 'used by no broker that runs';
    main.append(el('div', 'rmeta', used + (s.neededBy.length ? ' · needed by ' + s.neededBy.join(', ') : '')));
    main.append(el('div', 'rmeta mono', s.volumeExists ? 'data in the volume ' + s.volume : 'no data yet (the volume ' + s.volume + ' is made at its first start)'));
    item.append(main);

    const acts = el('div', 'racts');
    if (runs && !s.usedBy.length) acts.append(button('Stop', '', () => this.stopService(s)));
    acts.append(button('Log', '', () => this.select('service', s.container)));
    if (s.volumeExists && !runs && s.state !== 'starting' && s.state !== 'stopping') {
      const armed = this.armed === 'vol:' + s.volume;
      acts.append(button(armed ? 'Delete ' + s.volume + '? Sure' : 'Delete data', armed ? 'armed' : '', () => this.deleteVolume(s.volume)));
    }
    item.append(acts);
    return item;
  }

  arm(key) {
    this.armed = key;
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.disarm(), 6000);
    this.renderLists();
  }

  disarm() {
    this.armed = null;
    clearTimeout(this.armTimer);
    if (this.state) this.renderLists();
  }

  // ------------------------------------------------------------------ actions

  async act(fn) {
    try { await fn(); } catch (e) { this.note(e.message); }
    this.stateText = '';
    await this.load();
  }

  note(text) { $('rn-log-note').textContent = text; }

  stop(b) { this.select('broker', b.name); return this.act(() => api.runStop(b.name)); }
  startKept(b) { this.select('broker', b.name); return this.act(() => api.runStartKept(b.name)); }
  stopService(s) { return this.act(() => api.runServiceStop(s.container)); }

  forget(b, data) {
    this.disarm();
    if (this.sel && this.sel.name === b.name) this.follow(null);
    return this.act(() => api.runForget(b.name, data));
  }

  deleteVolume(volume) {
    if (this.armed !== 'vol:' + volume) { this.arm('vol:' + volume); return; }
    this.disarm();
    return this.act(() => api.runVolumeDelete(volume));
  }

  //
  // edit - a kept broker's options into the form (Start then replaces them)
  //
  edit(b) {
    const d = b.def;
    const tag = d.image && d.image.startsWith(this.repo() + ':') ? d.image.slice(this.repo().length + 1) : (d.image || '');
    this.f = {
      name: d.name, set: d.set, from: d.from, build: d.build || '', tag, where: d.where,
      store: d.store, dbDir: d.dbDir, history: d.history, port: d.port, healthPort: d.healthPort, grace: d.grace,
      ws: (d.transports || []).includes('ws'), admin: d.admin, verbose: d.verbose, bridges: [...(d.bridges || [])],
      bridgeConfig: d.bridgeConfig || '', args: d.args || '',
    };
    this.nameTouched = true;
    this.editing = d.name;
    this.portsChosen = true;
    this.renderForm();
    $('rn-form').scrollIntoView({ block: 'start' });
  }

  // ------------------------------------------------------------------ the log

  select(kind, name) {
    this.sel = { kind, name };
    if (this.state) this.renderLists();
    $('rn-log-name').textContent = name;
    const base = '/api/run/' + (kind === 'broker' ? 'brokers' : 'services') + '/' + encodeURIComponent(name) + '/log';
    const a = $('rn-log-file');
    a.href = base;
    a.hidden = false;
    this.follow(base);
  }

  follow(url) {
    if (this.es) { this.es.close(); this.es = null; }
    clearTimeout(this.logPoll);
    $('rn-log').replaceChildren();
    this.note('');
    if (!url) { $('rn-log-name').textContent = '-'; $('rn-log-file').hidden = true; return; }

    const caps = this.compileCaps;
    if (caps && caps.liveLog === false) { this.pollLog(url, 0); return; }

    const es = new EventSource(url);
    this.es = es;
    es.onmessage = (e) => this.append(e.data);
    es.addEventListener('reset', () => { $('rn-log').replaceChildren(); });
    es.addEventListener('skipped', (e) => this.note('The first ' + (Number(e.data) / 1048576).toFixed(1) + ' MiB of the log are not shown here - the whole file has them.'));
    es.addEventListener('busy', (e) => this.note(e.data));
  }

  //
  // pollLog - a backend without streamed responses: the file by Range, every second
  //
  async pollLog(url, from) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=' + from + '-' } });
      if (r.status === 206 || r.status === 200) {
        const text = await r.text();
        const cut = text.lastIndexOf('\n') + 1;
        if (cut > 0) { this.append(text.slice(0, cut - 1)); from += new TextEncoder().encode(text.slice(0, cut)).length; }
      } else if (r.status === 416) from = 0;
    } catch (e) { /* the next round */ }
    if (this.shown) this.logPoll = setTimeout(() => this.pollLog(url, from), 1000);
  }

  append(text) {
    const pre = $('rn-log');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      let cls = '';
      if (line.startsWith('c3: ')) cls = 'c3';
      else if (line.startsWith('E: ') || line.startsWith('X: ')) cls = 'er';
      else if (line.startsWith('W: ')) cls = 'wa';
      frag.append(cls ? el('span', cls, line + '\n') : document.createTextNode(line + '\n'));
    }
    pre.append(frag);
    while (pre.childNodes.length > 20000) pre.firstChild.remove();
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }

  // ------------------------------------------------------------------ the form

  repo() { return (this.sources && this.sources.repository) || 'quay.io/seamware/coraine'; }

  builds() { return (this.sources && this.sources.builds) || []; }

  //
  // source - what the form's broker is started from: its --version (features) and its bridges
  //
  source() {
    const f = this.f;
    if (f.from === 'installed') return this.sources && this.sources.installed;
    if (f.from === 'build') return this.builds().find((b) => b.name === f.build) || null;
    return { version: null, bridges: ['dds', 'loopback', 'modbus', 'mqtt'] };
  }

  features() {
    const s = this.source();
    return s ? featuresOf(s.version) : null;
  }

  has(feature) {
    const fs = this.features();
    return !fs || !(feature in fs) || fs[feature];
  }

  //
  // choosePorts - the first port from 1026 on that no kept broker uses, the health port after it
  //
  choosePorts() {
    const used = new Set();
    for (const b of (this.state && this.state.brokers) || []) { used.add(b.def.port); if (b.def.healthPort) used.add(b.def.healthPort); }
    let p = 1026;
    while (used.has(p) || used.has(p + 1)) p += 2;
    this.f.port = p;
    this.f.healthPort = p + 1;
    this.portsChosen = true;
  }

  changed(render = true) {
    if (render) this.renderForm();
    else { this.renderName(); this.commandSoon(); }
  }

  applySet(id) {
    const s = ((this.state && this.state.sets) || []).find((x) => x.id === id);
    if (!s) return;
    this.f.set = id;
    this.f.store = s.store;
    this.f.dbDir = s.dbDir;
    this.f.history = s.history;
    this.f.bridges = [...s.bridges];
    this.changed();
  }

  renderName() {
    if (!this.nameTouched) {
      const base = this.f.from === 'build' && this.f.build ? this.f.build : 'coraine';
      this.f.name = (base + '-' + (this.f.port || '')).slice(0, 64);
      $('rn-name').value = '';
      $('rn-name').placeholder = this.f.name;
    }
    const k = this.kept(this.f.name);
    $('rn-form-sub').textContent = k ? 'replaces the options of ' + k.name : '';
  }

  seg(id, options, current, onPick) {
    $(id).replaceChildren(...options.map(([value, label, why]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(value === current));
      b.disabled = !!why;
      if (why) b.title = why;
      b.addEventListener('click', () => onPick(value));
      return b;
    }));
  }

  renderForm() {
    const f = this.f;
    const cont = this.containers();
    const noCont = (this.caps && this.caps.containersWhy) || 'install docker or podman';
    const sets = (this.state && this.state.sets) || [];

    //
    // The sets
    //
    $('rn-sets').replaceChildren(...sets.map((s) => {
      const b = el('button', 'rn-set');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(f.set === s.id));
      b.append(el('span', 'sl', s.label), el('span', 'sd', s.description));
      if (s.services.length) b.append(el('span', 'sd mono', s.services.map((x) => x.image).join(', ')));
      if (s.services.length && !cont) { b.disabled = true; b.append(el('span', 'sw', noCont)); }
      else if (s.store === 'mongoc' && !this.has('MONGOC')) { b.disabled = true; b.append(el('span', 'sw', 'this broker is built without mongoc')); }
      b.addEventListener('click', () => this.applySet(s.id));
      return b;
    }));

    //
    // From: the installed broker, a build, an image
    //
    const inst = this.sources && this.sources.installed;
    const builds = this.builds();
    this.seg('rn-from', [
      ['installed', 'Installed coraine', inst ? '' : 'no coraine in $PATH'],
      ['build', 'A build', builds.length ? '' : 'no build yet - Compile makes one'],
      ['image', 'An image', cont ? '' : noCont],
    ], f.from, (v) => {
      f.from = v;
      f.where = v === 'image' ? 'container' : 'native';
      if (v === 'build' && !f.build && builds.length) f.build = builds[0].name;
      if (v === 'image') this.loadImages();
      this.changed();
    });

    $('rn-build').hidden = f.from !== 'build';
    if (f.from === 'build') {
      $('rn-build').replaceChildren(...builds.map((b) => { const o = el('option', '', b.name); o.value = b.name; return o; }));
      if (f.build) $('rn-build').value = f.build;
    }
    $('rn-image').hidden = f.from !== 'image';
    $('rn-repo').textContent = this.repo() + ':';
    if ($('rn-tag').value !== f.tag) $('rn-tag').value = f.tag;

    const src = this.source();
    let fromNote = '';
    if (f.from === 'installed' && inst) fromNote = inst.path + ' · ' + (inst.version || '').split('\n')[0];
    else if (f.from === 'build' && src) fromNote = (src.version || '').split('\n')[0] + ' · built by Compile';
    else if (f.from === 'image') fromNote = this.imagesNote || 'the tags published on quay.io, and those already here';
    $('rn-from-note').textContent = fromNote;

    //
    // Runs: natively or in a container - which one follows from the source
    //
    this.seg('rn-where', [
      ['native', 'Natively', f.from === 'image' ? 'an image runs in a container' : ''],
      ['container', 'In a container', f.from === 'image' ? '' : f.from === 'build' ? 'Compile makes no image yet' : 'the installed broker runs natively - a published image runs in a container'],
    ], f.where, (v) => { f.where = v; this.changed(); });

    //
    // Store and history
    //
    const mongoWhy = !this.has('MONGOC') ? 'this broker is built without mongoc' : !cont ? noCont : '';
    this.seg('rn-store', [['corDB', 'corDB', ''], ['mongoc', 'mongoc', mongoWhy]], f.store, (v) => { f.store = v; if (v === 'corDB' && f.set === 'mongoc-timescale') f.dbDir = true; this.changed(); });
    $('rn-dbdir').checked = f.store === 'corDB' && f.dbDir;
    $('rn-dbdir').disabled = f.store !== 'corDB';
    $('rn-dbdir').parentElement.classList.toggle('off', f.store !== 'corDB');

    this.seg('rn-history', [['none', 'none', ''], ['corDB', 'corDB', ''], ['timescale', 'timescale', cont ? '' : noCont]], f.history, (v) => { f.history = v; this.changed(); });

    //
    // Ports
    //
    if (document.activeElement !== $('rn-port')) $('rn-port').value = f.port || '';
    if (document.activeElement !== $('rn-hport')) $('rn-hport').value = f.healthPort || '';
    if (document.activeElement !== $('rn-grace')) $('rn-grace').value = f.grace || '';
    $('rn-hport').disabled = !this.has('HEALTH');
    if (!this.has('HEALTH')) { f.healthPort = 0; $('rn-hport').value = ''; $('rn-hport').placeholder = 'built without HEALTH'; }
    else $('rn-hport').placeholder = 'none';

    //
    // Plugins: what the broker has compiled in
    //
    $('rn-plugins').replaceChildren(...PLUGINS.map(([key, label, feature, flag]) => {
      const off = feature && !this.has(feature);
      const l = el('label', 'rn-check' + (off ? ' off' : ''));
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !off && !!f[key];
      c.disabled = !!off;
      c.addEventListener('change', () => { f[key] = c.checked; this.changed(false); });
      l.append(c, document.createTextNode(label + ' '), el('span', 'mono cp-note', flag));
      if (off) { l.title = 'built without ' + feature; f[key] = false; }
      return l;
    }));

    const fs = this.features();
    $('rn-tenants').textContent = !fs ? 'Tenants: as the image is built (NGSILD-Tenant); no switch at start.'
      : (fs.TENANTS === false ? 'Tenants: built without them (TENANTS=OFF) - one store, NGSILD-Tenant refused.' : 'Tenants: compiled in - a request names one with NGSILD-Tenant; no switch at start.');

    //
    // Bridges: those the source has
    //
    const have = (src && src.bridges) || [];
    $('rn-bridges').replaceChildren(...(have.length ? have.map((name) => {
      const l = el('label', 'rn-check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = f.bridges.includes(name);
      c.addEventListener('change', () => {
        f.bridges = c.checked ? [...f.bridges, name] : f.bridges.filter((x) => x !== name);
        this.changed();
      });
      l.append(c, document.createTextNode(name));
      if (name === 'mqtt' && !cont && !f.bridgeConfig) { l.append(el('span', 'why', ' its Mosquitto needs containers')); }
      return l;
    }) : [el('span', 'cp-note', 'this broker has no bridge plugins')]));
    if ($('rn-bconf').value !== f.bridgeConfig) $('rn-bconf').value = f.bridgeConfig;
    if ($('rn-args').value !== f.args) $('rn-args').value = f.args;

    this.renderName();
    this.commandSoon();
  }

  def() {
    const f = this.f;
    const d = {
      name: f.name, set: f.set, from: f.from, where: f.where, store: f.store, dbDir: f.store === 'corDB' && f.dbDir,
      history: f.history, port: f.port, healthPort: f.healthPort || 0, grace: f.grace || 30,
      transports: f.ws ? ['ws'] : [], admin: !!f.admin, verbose: !!f.verbose, bridges: f.bridges,
      args: f.args,
    };
    if (f.bridgeConfig) d.bridgeConfig = f.bridgeConfig;
    if (f.from === 'build') d.build = f.build;
    if (f.from === 'image') d.image = f.tag.includes('/') ? f.tag : this.repo() + ':' + f.tag;
    return d;
  }

  commandSoon() {
    clearTimeout(this.cmdTimer);
    this.cmdTimer = setTimeout(() => this.command(), 150);
  }

  //
  // command - what Start would run, from the backend: one option a line, the services it starts first
  //
  async command() {
    const box = $('rn-cmd');
    const need = $('rn-need');
    try {
      const c = await api.runCommand(this.def());
      this.plan = c;
      need.replaceChildren(...c.services.map((s) => {
        const row = el('div');
        row.append(document.createTextNode('first: '), el('span', 'mono', s.container), document.createTextNode(' - ' + s.label + ', ' + s.image + ', on 127.0.0.1:' + s.port));
        return row;
      }));
      if (c.argv.length) {
        const lines = [];
        let cur = '';
        for (const a of c.argv.map((x) => (x !== '' && /^[A-Za-z0-9_./=,:@+%-]+$/.test(x)) ? x : "'" + x.replace(/'/g, "'\\''") + "'")) {
          if (a.startsWith('-') && cur) { lines.push(cur); cur = a; } else cur = cur ? cur + ' ' + a : a;
        }
        if (cur) lines.push(cur);
        box.textContent = lines.join(' \\\n  ');
        box.classList.remove('err');
      } else {
        box.textContent = c.problem || '';
        box.classList.add('err');
      }
      $('rn-problem').textContent = c.argv.length && c.problem ? c.problem : '';
      this.problem = c.problem;
    } catch (e) {
      this.plan = null;
      this.problem = e.message;
      need.replaceChildren();
      box.textContent = e.message;
      box.classList.add('err');
      $('rn-problem').textContent = '';
    }
    this.renderStartButton();
  }

  renderStartButton() {
    const k = this.kept(this.f.name);
    const runs = k && ['running', 'starting', 'stopping'].includes(k.state);
    const b = $('rn-start');
    b.disabled = !!this.problem || !!runs || (this.f.from === 'image' && !this.f.tag);
    b.title = runs ? k.name + ' runs - stop it first' : (this.problem || '');
    b.textContent = runs ? this.f.name + ' runs' : 'Start';
  }

  async start() {
    const d = this.def();
    $('rn-start').disabled = true;
    try {
      const b = await api.runStart(d);
      this.editing = null;
      this.select('broker', b.name);
      this.nameTouched = false;
      this.portsChosen = false;
      this.stateText = '';
      await this.load();
      this.choosePorts();
      this.renderForm();
    } catch (e) {
      $('rn-problem').textContent = e.message;
      setTimeout(() => this.renderStartButton(), 3000);
    }
  }

  //
  // loadImages - the coraine images here and on quay.io, for the tag's list
  //
  async loadImages() {
    if (this.images) return;
    this.imagesNote = 'asking quay.io for the published tags ...';
    try {
      const r = await api.runImages();
      this.images = r;
      const local = new Set(r.local.map((x) => x.tag));
      const opts = [];
      for (const t of r.local) { const o = el('option', '', 'here · ' + t.created.slice(0, 16)); o.value = t.tag; opts.push(o); }
      for (const t of r.published) {
        if (local.has(t.tag)) continue;
        const o = el('option', '', 'quay.io · ' + (t.modified || '').slice(5, 22));
        o.value = t.tag;
        opts.push(o);
      }
      $('rn-tags').replaceChildren(...opts);
      this.imagesNote = r.local.length + ' here, ' + r.published.length + ' published' + (r.publishedError ? ' (' + r.publishedError + ')' : '') + ' - a tag not here is pulled at the start';
      if (!this.f.tag && r.published.length) { this.f.tag = r.published[0].tag; }
    } catch (e) {
      this.imagesNote = 'the tags could not be read: ' + e.message;
    }
    this.renderForm();
  }
}
