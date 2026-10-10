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
function shellQuote(a) {
  if (a !== '' && /^[A-Za-z0-9_./=,:@+%-]+$/.test(a)) return a;
  return "'" + a.replace(/'/g, "'\\''") + "'";
}

export class Compile {
  constructor() {
    this.caps = null;             // GET /api/capabilities
    this.features = [];           // [{name, default, description, requires}]
    this.featureError = '';
    this.choice = { mode: 'release', features: {}, workload: '' };
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
        features: { ...(c.choice.features || {}) },
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
    return (f.requires || []).filter((r) => !this.isOn(r));
  }

  //
  // changedFeatures - only the switches that differ from their defaults: the command says what is different
  //
  changedFeatures() {
    const out = {};
    for (const [name, on] of Object.entries(this.choice.features)) {
      if (this.features.length && !this.features.find((f) => f.name === name)) continue;     // not in this source
      if (on !== this.isDefault(name)) out[name] = on;
    }
    return out;
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
    seg('cp-http', ['libmicrohttpd', 'corHttp (built in)'], 'libmicrohttpd');

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
      return b;
    }));
    const sn = $('cp-store-note');
    sn.textContent = (!cc.mongoc && mongoc) ? 'The mongo-c driver v2 is not installed here: this build would stop. corDB only, or install it.' : (!cc.mongoc ? 'mongoc needs the mongo-c driver v2 (not installed here).' : '');
    sn.className = 'cp-note' + ((!cc.mongoc && mongoc) ? ' warn' : '');

    //
    // Features
    //
    const grid = $('cp-features');
    const shown = this.features.filter((f) => f.name !== 'MONGOC');
    let on = 0;
    grid.replaceChildren(...shown.map((f) => {
      const forced = this.forcedBy(f);
      const isOn = this.isOn(f.name) && forced.length === 0;
      if (isOn) on++;

      const b = el('button', 'cp-feature' + ((this.isOn(f.name) !== !!f.default) ? ' changed' : ''));
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(isOn));
      b.disabled = forced.length > 0;
      b.title = f.description;
      const txt = el('span', 'txt');
      txt.append(el('span', 'fn', f.name), el('span', 'fd', f.description));
      if (forced.length) txt.append(el('span', 'fr', 'Off: needs ' + f.requires.join(' and ') + ' - ' + forced.join(' and ') + (forced.length > 1 ? ' are' : ' is') + ' off'));
      txt.append(el('span', 'fdef', 'default ' + (f.default ? 'on' : 'off') + ((this.isOn(f.name) !== !!f.default) ? ' · changed' : '')));
      b.append(el('span', 'cp-fbox'), txt);
      b.addEventListener('click', () => { this.choice.features[f.name] = !this.isOn(f.name); this.changed(); });
      return b;
    }));
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
      b.append(el('span', 'ol', label), el('span', 'od', desc));
      if (b.disabled) b.append(el('span', 'ow', cc.pgoWhy || 'not available here'));
      b.addEventListener('click', () => { this.choice.mode = id; this.changed(); });
      return b;
    }));
    $('cp-workload').hidden = this.choice.mode !== 'tune';
    if ($('cp-workload-path').value !== this.choice.workload) $('cp-workload-path').value = this.choice.workload;

    //
    // This build
    //
    const off = shown.filter((f) => !(this.isOn(f.name) && this.forcedBy(f).length === 0)).map((f) => f.name);
    $('cp-sum-target').textContent = (arch || 'this machine') + ' · ' + ((this.caps && this.caps.distribution) || 'this distribution') + ' · binary';
    $('cp-sum-server').textContent = 'libmicrohttpd (coraine-build\'s default)';
    $('cp-sum-stores').textContent = (mongoc ? 'corDB + mongoc' : 'corDB only') + '; history none, corDB, timescale';
    $('cp-sum-opt').textContent = MODE_LABEL[this.choice.mode] + (this.choice.mode === 'tune' && this.choice.workload ? ' - ' + this.choice.workload : '');
    $('cp-sum-features').textContent = shown.length ? (off.length ? off.length + ' off: ' + off.join(', ') : 'all ' + shown.length + ' on') : '-';
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
      api.compileChoice({ mode: this.choice.mode, features: this.choice.features, workload: this.choice.workload }).catch(() => {});
    }, 400);
  }

  body() {
    const b = { mode: this.choice.mode, features: this.changedFeatures() };
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
    const p = { name, mode: this.choice.mode, features: this.changedFeatures() };
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
    this.choice = { mode: p.mode || 'release', features: { ...(p.features || {}) }, workload: p.workload || '' };
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
