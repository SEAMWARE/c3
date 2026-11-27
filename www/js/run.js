//
// run.js - the Operate page: brokers started and stopped on this machine, natively or in a container, and the
// services they use
//
// Four views, one shown at a time: Set up and start a broker, Brokers and Containers; a broker's card (or a service's)
// with its log; Set up a broker step 1, what runs (a build, the installed coraine, an image, or the settings of
// a broker started earlier); step 2, how it runs - the form, the command and the services it brings up
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The backend does the work (GET /api/run, POST /api/run/brokers, ...): the page shows its state, asked again
// every 1.5 s while the page is shown, and the form that makes a broker's options. A log is followed as
// server-sent events (GET /api/run/brokers/<name>/log), as Compile follows a build.
//
import * as api from './api.js';
import { Metrics } from './metrics.js';
import { DdsMapper } from './ddsmap.js';
import { OpcuaMapper } from './opcuamap.js';
import { AasForm } from './aasform.js';
import { attrCamel } from './ngsild.js';
import { closeX } from './ui.js';
import { logLine } from './logline.js';
import { t, tk, plural } from './i18n.js';
import { helpShow } from './compile.js';
import { pickDir } from './source.js';

//
// The states of a broker or a service as the backend and Docker/Podman name them (also CSS classes), shown translated
//
const STATE_NAMES = {
  running: tk('running'), starting: tk('starting'), stopping: tk('stopping'), stopped: tk('stopped'), failed: tk('failed'),
  ready: tk('ready'), answers: tk('answers'), created: tk('created'), exited: tk('exited'), paused: tk('paused'),
  restarting: tk('restarting'), dead: tk('dead'), removing: tk('removing'), 'not ready': tk('not ready'), 'no answer': tk('no answer'),
};

//
// answers - a broker of c³'s that answers its probe (src/run.c, every 2 s: /ready on the health port, else
// /version): only then does Explore open it
//
const answers = (b) => b.state === 'running' && (b.ready === 'ready' || b.ready === 'answers');

//
// exploreButton - Explore, live while the broker answers
//
function exploreButton(b, onConnect) {
  const x = button(t('Explore'), '', () => onConnect(b.url));
  x.disabled = !answers(b);
  if (x.disabled) x.title = t('{name} does not answer yet', { name: b.name });
  return x;
}
const stateName = (v) => (STATE_NAMES[v] ? t(STATE_NAMES[v]) : v);


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

//
// parseLevels - "1-2,5,200-210" as a Set of numbers; rangesOf - a list of numbers back as "1-2,5,200-210"
//
function parseLevels(s) {
  const out = new Set();
  for (const part of String(s).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : a;
    for (let l = a; l <= b && l - a < 1000; l++) out.add(l);
  }
  return out;
}

function rangesOf(levels) {
  const v = [...new Set(levels)].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j > i ? v[i] + '-' + v[j] : String(v[i]));
    i = j;
  }
  return out.join(',');
}

const mib = (b) => t('{n} MiB', { n: (b / (1024 * 1024)).toFixed(0) });
const ago = (s) => (s >= 3600 ? t('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) }) : s >= 60 ? t('{m} min', { m: Math.floor(s / 60) }) : t('{s} s', { s }));

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

//
// BRIDGES - every bridge c³ knows (a broker's own may add others): the form lists them all, those it lacks greyed
//
const BRIDGES = ['aas', 'cep', 'ckan', 'dds', 'modbus', 'mqtt', 'opcua'];

//
// OPTS_FORM - the broker's options the form has a field of its own for, and those c³ keeps (the process and its log
// are c³'s); OPTS_BOUND - options of the list that are fields of the broker's definition
//
const OPTS_FORM = new Set(['--port', '--healthPort', '--database', '--troe', '--dbDir', '--apiPlugins', '--bridges', '--transports',
  '--distributed', '--verbose', '--usage', '--Usage', '--version', '--daemon', '--logTo', '--logDir']);
const OPTS_BOUND = { '--bridgeConfig': 'bridgeConfig', '--defaultUserContext': 'userContext' };

//
// usageOf - a broker's -u and -U as its options: [{ name, short, bool, help, values, dflt, section }] - the sections are
// the plugins' ("Database (corDB) plugin options"), '' for the broker's own
//
function usageOf(u, U) {
  const ext = {};
  for (const line of (U || '').split('\n')) {
    const m = /^\s*(--\S+)\s+\((-[^)]*)\)\s+(?:\S+\s+)?(?:Optional|Required)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (m) ext[m[1]] = { type: m[3], dflt: m[4] === '-' ? '' : m[4] };
  }
  const out = [];
  let section = '';
  for (const line of (u || '').split('\n')) {
    const h = /^\s*(.+ plugin options):\s*$/.exec(line);
    if (h) { section = h[1]; continue; }
    const m = /^\s*(?:Usage: \S+\s+)?\[(--[^/\s]+)\/(-\S+) ([(<])(.*)[)>]\]\s*$/.exec(line);
    if (!m) continue;
    const e = ext[m[1]] || {};
    const bool = m[3] === '(' || e.type === 'Bool';
    const v = /^([\w.]+(?:\|[\w.]+)+)(?:\s|$)/.exec(m[4]);
    out.push({ name: m[1], short: m[2], bool, help: m[4], values: v ? v[1].split('|') : null, dflt: e.dflt || '', type: e.type || '', section });
  }
  return out;
}

const optQuote = (v) => (/^[^\s'"]+$/.test(v) ? v : v.includes('"') ? "'" + v + "'" : '"' + v + '"');

//
// FORM_HELP - the '?' of each field of the form (data-help on its label): what it is, for one who does not know yet
//
const FORM_HELP = {
  from: [tk('From'), tk('The broker that runs: the coraine installed on this machine, a build made in Compile, or a Docker image. **Change** goes back to the choice. What the broker has - its databases, bridges, switches - decides what the form offers; what it lacks is greyed, with the reason.')],
  name: [tk('Name'), tk('c³\'s name for this broker: its directory, its log, its row in the list. Empty: the build\'s name and the port. Starting again with a name c³ keeps replaces that broker\'s options.')],
  runs: [tk('Runs'), tk('**Native**: the broker is a process on this machine. **Container**: it runs in Docker or Podman - an image always runs in a container.')],
  store: [tk('Current state DB'), tk('Where the broker keeps the entities as they are now - the answer to a query or a GET of an entity.\n\n- **corDB**: coraine\'s own database, files in a directory (`--dbDir`) - they survive a restart.\n- **ramDB**: in memory only - fast, and gone when the broker stops. For tests and demos.\n- **mongoc**: MongoDB, in a container c³ starts beside the broker.')],
  history: [tk('History DB'), tk('Where the broker keeps every value an attribute has had - the temporal API (TRoE, `/temporal/entities`). **none**: no history.\n\n- **corDB**: coraine\'s own, beside the current state.\n- **timescale**: PostgreSQL with TimescaleDB, in a container c³ starts beside the broker.')],
  port: [tk('Port'), tk('The broker\'s HTTP port: where the NGSI-LD API answers (`--port`). 1026 is NGSI-LD\'s usual one.')],
  healthPort: [tk('Health port'), tk('A second port with only the health report (`--healthPort`): c³ reads it every few seconds for the broker\'s state, memory and requests. Empty: none - c³ then knows less about the broker.')],
  grace: [tk('Grace (s)'), tk('On **Stop**, the seconds the broker has to finish what it is doing after SIGTERM, before c³ kills it (SIGKILL).')],
  switches: [tk('Switches'), tk('- **WebSocket transport**: subscriptions and notifications over WebSocket too (`--transports ws`).\n- **admin API**: the broker\'s configuration, metrics and trace levels - the broker\'s card shows them (`--apiPlugins admin`).\n- **distributed operations**: queries and updates forwarded to the Context Sources registered (`--distributed`).\n- **verbose log**: more in the broker\'s log (`-v`).')],
  bridges: [tk('Bridges'), tk('A bridge connects the broker to another world: MQTT topics, DDS (ROS 2), Modbus devices, OPC UA servers, CKAN open data, AAS servers - their data become entities, and changes go back. Only the bridges this broker has are offered. Without a configuration file of your own, c³ writes one from what this form says.')],
  ckan: [tk('CKAN data'), tk('Open-data datasets from CKAN portals, read through the ckan bridge when the broker starts: one entity per row.')],
  opcua: [tk('OPC UA'), tk('An OPC UA server (machines, PLCs): its model roots become entities, and each channel ties one of its nodes to an entity\'s attribute. **Map an OPC UA server** picks them on the server\'s tree.')],
  aas: [tk('AAS'), tk('An Asset Administration Shell server: its shells and submodels become entities, and each AssetChannel ties a value to an attribute.')],
  options: [tk('Options'), tk('Every option of this broker that the form above does not set - its own usage (`coraine -u`), with the options of the databases chosen. Empty: the broker\'s default, greyed in the field. **?** says what each one does, in coraine\'s words. Those c³ sets itself show what it sets.')],
  args: [tk('More options'), tk('Any other coraine option, as typed - added at the end of the command (quotes keep words together). `coraine --help` lists them.')],
};

//
// pluginsOf - the "plugins: db=corDB,mongoc troe=... api=... auth=... bridges=... transports=..." line of a
// --version (coraine#631) as { db: ['corDB', 'mongoc'], ... }; null: no such line (an older coraine)
//
function pluginsOf(version) {
  const m = /(?:^|\n)plugins: ([^\n]*)/.exec(version || '');
  if (!m) return null;
  const out = {};
  for (const kv of m[1].trim().split(/\s+/)) {
    const [k, v] = kv.split('=');
    if (k) out[k] = v ? v.split(',').filter(Boolean) : [];
  }
  return out;
}

//
// The switches: the option, its label, the feature it needs compiled in, the plugin it needs found ([kind, name])
//
const PLUGINS = [
  ['ws',      tk('WebSocket transport'), 'TRANSPORTS', '--transports ws', ['transports', 'ws']],
  ['admin',   tk('admin API'),           'ADMIN_API',  '--apiPlugins admin', ['api', 'admin']],
  ['distributed', tk('distributed operations'), 'REGISTRATIONS', '--distributed', null],
  ['verbose', tk('verbose log'),         null,         '-v', null],
];

export class Run {
  constructor({ onConnect } = {}) {
    this.onConnect = onConnect || (() => {});
    this.explored = null;             // {url, tenant, demo}: the broker Explore is connected to - the active one
    window.addEventListener('c3-explore-broker', (e) => {
      this.explored = e.detail;
      this.remoteAsked = 0;                              // Explore's list may have a new one: read again
      if (this.state) this.renderLists();
      if (this.shown) this.probeRemote();
    });
    this.configBrokers = null;        // the configuration's brokers - those Explore connected to (probeRemote)
    this.remoteAnswers = new Map();   // url -> it answered the last ask (probeRemote)
    this.remoteAdmin = new Map();     // url -> it has the admin API (remoteCard)
    this.logRaw = [];                 // the log's lines as written (append) - shown again when the view changes
    this.logView = 'text';            // 'text' or 'json' (logViewSet)
    try { if (localStorage.getItem('c3.log.view') === 'json') this.logView = 'json'; } catch { /* text */ }
    for (const b of $('rn-log-view').querySelectorAll('button')) b.addEventListener('click', () => this.logViewSet(b.dataset.v));
    this.logTime = 'clock';           // 'clock' or 'uptime' (logTimeSet)
    this.logStart = null;             // the broker's start, ms (logStartAsk), null: not known
    try { if (localStorage.getItem('c3.log.time') === 'uptime') this.logTime = 'uptime'; } catch { /* clock */ }
    for (const b of $('rn-log-time').querySelectorAll('button')) b.addEventListener('click', () => this.logTimeSet(b.dataset.v));
    this.logTimeSet(this.logTime);    // and the view (logViewSet)
    this.remoteAsked = 0;
    this.ctrBusy = new Map();         // container -> its state when Start or Stop was asked: busy until it changes
    this.ctrWhy = new Map();          // container -> why its last Start or Stop failed
    this.ctrAll = false;              // Containers: all of them, not only the 10 newest
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
    this.metrics = new Metrics();

    this.mode = 'list';               // the view shown: 'list', 'item' (a broker's or a service's card), 'pick', 'form'
    this.back = null;                 // the card a service's card goes back to: {kind, name}

    $('rn-start').addEventListener('click', () => this.start());
    $('rn-new').addEventListener('click', () => this.startNew());
    $('rn-card-back').addEventListener('click', () => (this.back ? this.select(this.back.kind, this.back.name) : this.showView('list')));
    $('rn-pick-back').addEventListener('click', () => this.showView('list'));
    $('rn-form-back').addEventListener('click', () => {
      if (this.editing && this.editingFrom === 'card' && this.editBack) this.select(this.editBack.kind, this.editBack.name);
      else this.showView('pick');
    });
    $('rn-change').addEventListener('click', () => this.showView('pick'));
    $('rn-tag').addEventListener('input', () => { $('rn-tag-use').disabled = !$('rn-tag').value.trim(); });
    $('rn-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('rn-tag').value.trim()) this.pick({ from: 'image', tag: $('rn-tag').value.trim() }); });
    $('rn-img-all').addEventListener('click', () => { this.imagesAll = !this.imagesAll; this.renderImages(); });
    $('rn-tag-use').addEventListener('click', () => this.pick({ from: 'image', tag: $('rn-tag').value.trim() }));
    $('rn-name').addEventListener('input', () => { this.nameTouched = $('rn-name').value.trim() !== ''; this.f.name = $('rn-name').value.trim(); this.commandSoon(); });
    $('rn-dbpath').addEventListener('input', () => { this.f.dbPath = $('rn-dbpath').value.trim(); this.changed(); });   // the note under it too
    $('rn-dbpath-pick').addEventListener('click', () => pickDir(this.f.dbPath || (this.state && this.state.dir) || '',
      (d) => { this.f.dbPath = d; $('rn-dbpath').value = d; this.changed(); }, { title: t('corDB\'s directory'), clones: false }));
    for (const label of document.querySelectorAll('#rn-form .cp-label[data-help]')) {
      const [title, text] = FORM_HELP[label.dataset.help];
      const q = el('button', 'cp-q inline rn-q', '?');
      q.type = 'button';
      q.title = t('What is {what}?', { what: t(title) });
      q.setAttribute('aria-label', q.title);
      q.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); helpShow(t(title), t(text)); });
      const row = el('span', 'rn-lab');                // the label and its '?' on one line
      label.before(row);
      row.append(label, q);
    }
    $('rn-port').addEventListener('input', () => { this.f.port = parseInt($('rn-port').value, 10) || 0; this.changed(false); });
    $('rn-hport').addEventListener('input', () => { this.f.healthPort = parseInt($('rn-hport').value, 10) || 0; this.changed(false); });
    $('rn-grace').addEventListener('input', () => { this.f.grace = parseInt($('rn-grace').value, 10) || 0; this.changed(false); });
    $('rn-args').addEventListener('input', () => { this.f.args = $('rn-args').value; this.changed(false); });

    //
    // OPC UA - the opcua bridge's server, in the bridge configuration c3 writes
    //
    const ou = (id, key, ev, get) => $(id).addEventListener(ev, () => { this.f.opcua[key] = get($(id)); this.renderOpcua(); this.changed(false); });
    ou('rn-ou-url',      'url',            'input',  (e) => e.value.trim());
    ou('rn-ou-roots',    'roots',          'input',  (e) => e.value);
    ou('rn-ou-mode',     'mode',           'change', (e) => e.value);
    ou('rn-ou-policy',   'policy',         'change', (e) => e.value);
    ou('rn-ou-cert',     'certificate',    'input',  (e) => e.value.trim());
    ou('rn-ou-key',      'privateKey',     'input',  (e) => e.value.trim());
    ou('rn-ou-appuri',   'applicationUri', 'input',  (e) => e.value.trim());
    ou('rn-ou-trust',    'trustList',      'input',  (e) => e.value);
    ou('rn-ou-trustany', 'trustAny',       'change', (e) => e.checked);
    ou('rn-ou-user',     'username',       'input',  (e) => e.value.trim());
    $('rn-ou-pw').addEventListener('input', () => { this.f.opcua.password = $('rn-ou-pw').value; this.renderOpcua(); });
    $('rn-ou-addch').addEventListener('click', () => this.channelAdd({ node: '', entityId: '', entityType: '', attribute: '' }));
    $('rn-ou-browse').addEventListener('click', () => this.browseToggle());

    //
    // DDS - the mapper (ddsmap.js) makes the DDS configuration, a broker starts with it: its bridge configuration
    // and its default user @context, the two files
    //
    this.ddsMap = new DdsMapper(this);
    $('rn-dds-map').addEventListener('click', () => this.ddsMap.open());
    this.ddsMap.load().then(() => this.renderDds());
    this.aas = new AasForm(this);                       // AAS - the aas bridge's server and its AssetChannels (aasform.js)
    this.opcuaMap = new OpcuaMapper(this);
    $('rn-opcua-map').addEventListener('click', () => this.opcuaMap.open());
    $('rn-aas-map').addEventListener('click', () => this.aasMapFromCompile());
    this.opcuaMap.load().then(() => this.renderOpcuaMap());
  }

  //
  // channelAdd - a Channel to the form: a Variable's value one attribute of an entity
  //
  channelAdd(ch) {
    const o = this.f.opcua;
    if (ch.node && o.channels.some((c) => c.node === ch.node)) return;       // a Variable is one Channel
    o.channels.push(ch);
    this.renderOpcua();
    this.changed(false);
  }

  //
  // renderChannels - the Channels, each one editable: the NodeId, the entity's id and type, the attribute
  //
  renderChannels() {
    const box = $('rn-ou-chans');
    const o = this.f.opcua;
    const cont = !this.bridgeOk('opcua');
    box.replaceChildren();
    o.channels.forEach((c, ix) => {
      const card = el('div', 'rn-ouch');
      for (const [key, label, ph] of [['node', t('Variable (NodeId)'), 'ns=2;s=Tank1.Level'], ['entityId', t('entity id'), 'urn:ngsi-ld:Tank:T1'],
                                      ['entityType', t('entity type'), 'Tank'], ['attribute', t('attribute'), 'level']]) {
        const f = el('label', 'rn-ouf rn-ouf-' + key);
        const inp = el('input', 'cp-input');
        inp.value = c[key];
        inp.placeholder = ph;
        inp.spellcheck = false;
        inp.disabled = cont;
        inp.addEventListener('input', () => { c[key] = inp.value.trim(); this.renderOpcuaSum(); this.changed(false); });
        f.append(el('span', '', label), inp);
        card.append(f);
      }
      const del = button('×', 'rn-oudel', () => { o.channels.splice(ix, 1); this.renderOpcua(); this.changed(false); });
      del.title = t('remove this Channel');
      del.setAttribute('aria-label', t('remove Channel {n}', { n: ix + 1 }));
      del.disabled = cont;
      card.append(del);
      box.append(card);
    });
  }

  //
  // browseBroker - the running broker the form is, with the opcua bridge: its URL; null and why not
  //
  browseBroker() {
    const k = this.kept(this.f.name);
    if (!this.bridgeOk('opcua')) return { url: null, why: '' };
    if (!this.f.opcua.url) return { url: null, why: t('Browsing asks a running broker: give the server, start the broker, then browse.') };
    if (!k || k.state !== 'running') return { url: null, why: t('Browsing asks the running broker\'s bridge: start {name}, then browse - and stop and start it again for what you pick.', { name: this.f.name || t('the broker') }) };
    if (!k.def.admin) return { url: null, why: t('Browsing needs the admin API in the broker (Switches).') };
    return { url: 'http://localhost:' + k.def.port, why: t('The server as {name}\'s bridge sees it. What you pick takes effect when the broker is started again.', { name: k.name }) };
  }

  async browseToggle() {
    const tree = $('rn-ou-tree');
    if (!tree.hidden) { tree.hidden = true; $('rn-ou-browse').textContent = t('Browse the server'); return; }
    const b = this.browseBroker();
    if (!b.url) return;
    tree.hidden = false;
    $('rn-ou-browse').textContent = t('Close the browser');
    tree.replaceChildren(el('div', 'cp-note', t('asking the server ...')));
    const top = await this.inventory(b.url, null);
    tree.replaceChildren();
    if (top.error) { tree.append(el('div', 'cp-note err', top.error)); return; }
    tree.append(this.browseNode(b.url, top.node, [], true));
  }

  //
  // inventory - GET /admin/bridges/opcua/inventory, one level below 'from' (null: the Objects folder)
  //
  async inventory(broker, from) {
    const q = from ? '?from=' + encodeURIComponent(from) + '&depth=1' : '?depth=1';
    const r = await api.brokerGet(broker, '/admin/bridges/opcua/inventory' + q);
    if (r.ok && r.body) return { node: r.body };
    const why = (r.body && (r.body.detail || r.body.title)) || ('HTTP ' + r.status);
    return { error: r.status === 404 && !from ? t('the broker has no opcua bridge loaded - {why}', { why }) : why };
  }

  //
  // browseNode - a node of the server, and what it contains: an Object can be a model root, a Variable a
  // Channel; a node with more below it opens on a click (asked for then, one level at a time)
  //
  browseNode(broker, n, path, top = false) {
    const box = el('div', 'rn-ounode' + (top ? ' top' : ''));
    const row = el('div', 'rn-ourow');
    const kids = el('div', '');
    const more = n.hasChildren || (n.children && n.children.length);
    const tog = el('button', 'rn-outog', more ? (n.children ? '▾' : '▸') : '');
    tog.type = 'button';
    tog.disabled = !more;
    row.append(tog, el('span', 'rn-oukind', n.node), el('b', '', n.name || n.id), el('span', 'rn-ouid', n.id || ''));
    const here = [...path, n];
    if (n.node === 'variable') {
      const info = [n.dataType, n.writable ? t('writable') : t('read-only'), n.unit].filter(Boolean).join(', ');
      row.append(el('span', 'rn-ouval', JSON.stringify(n.value)), el('span', 'rn-oukind', info));
      const added = this.f.opcua.channels.some((c) => c.node === n.id);
      const b = button(added ? t('a Channel') : t('+ Channel'), '', () => { this.channelAdd(this.channelFor(here)); b.textContent = t('a Channel'); b.disabled = true; });
      b.disabled = added || !n.id;
      row.append(b);
    } else if (n.node === 'object' && n.id && n.id !== 'i=85') {
      const roots = () => this.f.opcua.roots.split('\n').map((x) => x.trim()).filter(Boolean);
      const b = button(roots().includes(n.id) ? t('a model root') : t('+ model root'), '', () => {
        if (!roots().includes(n.id)) this.f.opcua.roots = [...roots(), n.id].join('\n');
        b.textContent = t('a model root'); b.disabled = true;
        this.renderOpcua(); this.changed(false);
      });
      b.disabled = roots().includes(n.id);
      b.title = t('the Object and everything in it as entities (an AssetChannel)');
      row.append(b);
    }
    if (n.children) for (const c of n.children) kids.append(this.browseNode(broker, c, here));
    let open = !!n.children;
    tog.addEventListener('click', async () => {
      if (open) { kids.hidden = !kids.hidden; tog.textContent = kids.hidden ? '▸' : '▾'; return; }
      tog.textContent = '…';
      const r = await this.inventory(broker, n.id);
      if (r.error) { kids.replaceChildren(el('div', 'cp-note err', r.error)); tog.textContent = '▸'; return; }
      kids.replaceChildren(...(r.node.children || []).map((c) => this.browseNode(broker, c, here)));
      open = true;
      tog.textContent = '▾';
    });
    box.append(row, kids);
    return box;
  }

  //
  // channelFor - a Variable's Channel, named as an AssetChannel on its Object names it (coraine's
  // asset-channels.md), so that both write the same entity: the nearest Object above the Variable, its type the
  // Object's typeName (else "Object"), its id urn:ngsi-ld:<type>:<name> - a byte outside [A-Za-z0-9._-] as
  // %XX; the attribute the names from the Object down, the first one lower-case as the broker does it (attrCamel), only [A-Za-z0-9_] kept
  //
  channelFor(path) {
    const v = path[path.length - 1];
    let ix = path.length - 2;
    while (ix >= 0 && path[ix].node !== 'object') ix--;
    const obj = ix >= 0 && path[ix].id !== 'i=85' ? path[ix] : null;
    const clean = (t) => String(t || '').replace(/[^A-Za-z0-9_]/g, '');
    const pct = (t) => [...new TextEncoder().encode(String(t))].map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) && b < 128
      ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
    const type = obj ? (clean(obj.typeName) || 'Object') : 'Object';
    const idPart = (obj ? obj.name : v.name) || 'object';
    const names = path.slice(obj ? ix + 1 : path.length - 1).map((p) => clean(p.name)).filter(Boolean);
    const attribute = attrCamel(names) || 'value';
    return { node: v.id, entityId: 'urn:ngsi-ld:' + type + ':' + pct(idPart), entityType: type, attribute };
  }

  // aasDefaults - before the AasForm exists (the form's first defaults) as after
  aasDefaults() {
    return { url: '', caFile: '', insecure: false, authorization: '', authorizationSet: false, channels: [] };
  }

  opcuaDefaults() {
    return { url: '', roots: '', mode: 'None', policy: '', certificate: '', privateKey: '', applicationUri: '',
             trustList: '', trustAny: false, username: '', password: '', passwordSet: false, channels: [] };
  }

  // ------------------------------------------------------------------ DDS: the mapping

  ddsDefaults() {
    return { domain: 0, transport: '', interfaces: [], vocabulary: '', rows: [] };
  }

  //
  // renderDds - the mapper's button, live when the dds bridge is ticked; under it, the DDS configuration made
  //
  //
  // ddsMapFromCompile - Compile's way in to the mapper: the dds bridge ticked, the mapper open with its way back
  //
  ddsMapFromCompile() {
    if (this.mode !== 'form') this.showView('form');
    if (!this.f.bridges.includes('dds')) {
      this.f.bridges = [...this.f.bridges, 'dds'];
      this.renderForm();
      this.changed(false);
    }
    this.renderDds();
    this.ddsMap.open('compile');
  }

  renderDds() {
    const on = this.f.bridges.includes('dds');
    $('rn-dds-map').disabled = !on;
    $('rn-dds-map').title = on ? '' : t('tick the dds bridge first');
    $('rn-dds-note').textContent = this.ddsMap.note(on);
  }

  //
  // opcuaMapFromCompile - Compile's way in to the OPC UA mapper: the opcua bridge ticked, the mapper open with
  // its way back
  //
  opcuaMapFromCompile() {
    if (this.mode !== 'form') this.showView('form');
    if (!this.f.bridges.includes('opcua')) {
      this.f.bridges = [...this.f.bridges, 'opcua'];
      this.renderForm();
      this.changed(false);
    }
    this.renderOpcuaMap();
    this.opcuaMap.open('compile');
  }

  //
  // aasMapFromCompile - Compile's way in to the AAS mapping: the aas bridge ticked, the form's AAS part open and
  // shown, the cursor in the server's URL (Discover the server is beside it)
  //
  aasMapFromCompile() {
    if (this.mode !== 'form') this.showView('form');
    if (!this.f.bridges.includes('aas')) {
      this.f.bridges = [...this.f.bridges, 'aas'];
      this.renderForm();
      this.changed(false);
    }
    const drop = $('rn-aas-drop');
    drop.open = true;
    let box = drop.parentElement;                          // the form's own scroller only: the page stays where it is
    while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
    if (box) box.scrollTop += drop.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    $('rn-aas-url').focus({ preventScroll: true });
  }

  // renderOpcuaMap - the OPC UA mapper's button, live when the opcua bridge is ticked; under it, the configuration made
  renderOpcuaMap() {
    const on = this.f.bridges.includes('opcua');
    $('rn-opcua-map').disabled = !on;
    $('rn-opcua-map').title = on ? '' : t('tick the opcua bridge first');
    $('rn-opcua-note').textContent = this.opcuaMap.note(on);
  }

  defaults() {
    return {
      name: '', set: 'cordb', from: 'installed', build: '', tag: '', where: 'native',
      store: 'corDB', dbDir: true, dbPath: '', history: 'corDB', opts: {}, port: 1026, healthPort: 1027, grace: 30,
      ws: true, admin: true, distributed: true, verbose: true, bridges: [], bridgeConfig: '', userContext: '', ckan: [], args: '',
      opcua: this.opcuaDefaults(), dds: this.ddsDefaults(), aas: this.aasDefaults(),
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
    if (this.mode === 'item' && this.sel) this.select(this.sel.kind, this.sel.name, this.back);   // its log followed again
    else this.showView(this.mode);
  }

  //
  // showView - one of the four views; a mapper open (ddsmap.js, opcuamap.js) keeps them hidden and restores, on
  // close, what is set here meanwhile
  //
  showView(mode) {
    this.mode = mode;
    const views = { list: 'rn-view-list', item: 'rn-view-item', pick: 'rn-view-pick', form: 'rn-view-form' };
    for (const [m, id] of Object.entries(views)) {
      const v = $(id);
      if ('dmHidden' in v.dataset) v.dataset.dmHidden = m === mode ? '' : '1';
      else v.hidden = m !== mode;
    }
    if (mode !== 'item') { this.follow(null); this.sel = null; this.back = null; this.configShow(); this.levelsShow(); this.metricsShow(); }
    if (mode === 'pick') { this.renderPicks(); if (this.containers()) this.loadImages(); }
    if (mode === 'form') this.renderForm();
    if (mode === 'list' && this.state) this.renderLists();
    const page = $('page-run');
    if (page) page.scrollTop = 0;
  }

  //
  // startNew - Set up a broker: a fresh form, its ports the first free ones, and step 1 - what runs
  //
  startNew() {
    this.f = this.defaults();
    this.editing = null;
    this.nameTouched = false;
    this.choosePorts();
    this.showView('pick');
  }

  //
  // pick - step 1's choice: what runs; then step 2, the form. An image runs in a container, the rest natively
  // (step 2 can put a build with an image in a container)
  //
  pick(src) {
    const f = this.f;
    f.picked = true;                                   // step 1 marks the choice once there is one
    f.from = src.from;
    if (src.from === 'build') f.build = src.build;
    if (src.from === 'image') f.tag = src.tag;
    f.where = src.from === 'image' ? 'container' : 'native';
    this.showView('form');
    if (src.from === 'image') this.loadImageCaps();
  }

  hide() {
    this.shown = false;
    clearInterval(this.poll);
    this.poll = null;
    this.metrics.stop();
    this.follow(null);
  }

  //
  // preselectBuild - Compile's "Run it": the form for that build
  //
  preselectBuild(name) {
    this.f = this.defaults();
    this.editing = null;
    this.nameTouched = false;
    this.choosePorts();
    this.pick({ from: 'build', build: name });
    setTimeout(() => $('rn-start').focus(), 50);
  }

  //
  // preselectImage - Compile's "Start it" for a build that made an image: the form for that image, in a container
  //
  preselectImage(ref) {
    this.f = this.defaults();
    this.editing = null;
    this.nameTouched = false;
    this.choosePorts();
    this.pick({ from: 'image', tag: ref });
    setTimeout(() => $('rn-start').focus(), 50);
  }

  async load() {
    if (Date.now() - this.remoteAsked > 10000) this.probeRemote();
    try {
      const s = await api.run();
      const text = JSON.stringify(s);
      this.state = s;
      if (text !== this.stateText) {
        this.stateText = text;
        this.renderLists();
        this.renderCard();
        if (this.mode === 'pick') this.renderEarlier();
        if (this.mode === 'form') this.renderNeed();
        this.renderEngine();
        this.renderStartButton();
        this.renderBrowse();
        this.configShow(false);
        this.levelsShow(false);
        this.metricsShow();
      }
    } catch (e) {
      $('rn-brokers').replaceChildren(el('span', 'rn-empty', t('The backend does not answer: {why}', { why: e.message })));
    }
  }

  containers() { return !!(this.caps && this.caps.containers); }

  renderEngine() {
    const e = (this.state && this.state.engine) || {};
    $('rn-engine').textContent = e.name ? e.name + ' ' + (e.version || '') : t('no containers');
    $('rn-nocont-why').hidden = !!e.name;
    $('rn-nocont-why').textContent = (e.why ? e.why.charAt(0).toUpperCase() + e.why.slice(1) + '. ' : '')
      + t('Images, and MongoDB, PostgreSQL/TimescaleDB and Mosquitto, need a container engine; brokers still run natively with corDB.');
  }

  // ------------------------------------------------------------------ the lists

  kept(name) { return this.state && this.state.brokers.find((b) => b.name === name); }

  sourceLabel(d) {
    if (d.from === 'build') return t('build {build}', { build: d.build });
    if (d.from === 'image') return d.image;
    return t('installed coraine');
  }

  //
  // active - is this URL the broker Explore is connected to (the same host and port: localhost and 127.0.0.1
  // are the same broker here)
  //
  active(url) {
    if (!this.explored || !url) return false;
    const key = (u) => { try { const x = new URL(u); return x.protocol + '//' + x.hostname.replace(/^127\.0\.0\.1$/, 'localhost') + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80')); } catch { return u; } };
    return key(url) === key(this.explored.url);
  }

  //
  // listed - a broker in the list: one that runs, or is on its way up or down, or failed (its card says why);
  // one stopped by hand is not - its settings are under Set up and start a broker, Earlier settings
  //
  listed(b) { return ['running', 'starting', 'stopping', 'failed'].includes(b.state); }

  renderLists() {
    this.renderBrokers();
    this.renderContainers();
  }

  //
  // renderBrokers - Brokers: c³'s that run here (No broker runs on this machine, when none), then the brokers
  // Explore connected to that c³ does not run - on other machines, or here but started elsewhere - each with
  // whether it answers (probeRemote). The one Explore is connected to first
  //
  renderBrokers() {
    const s = this.state;
    const shown = s.brokers.filter((b) => this.listed(b));
    const ours = shown.find((b) => this.active(b.url));
    const items = shown.map((b) => this.brokerRow(b));
    if (ours) items.unshift(items.splice(shown.indexOf(ours), 1)[0]);
    const remote = this.remoteBrokers();
    const on = remote.find((r) => this.active(r.url));
    if (on) remote.unshift(remote.splice(remote.indexOf(on), 1)[0]);
    const rows = remote.map((r) => this.remoteRow(r));
    if (on && !ours) items.unshift(...rows); else items.push(...rows);
    $('rn-bcount').textContent = items.length ? String(items.length) : '';
    $('rn-brokers').replaceChildren(...items);
    $('rn-brokers').hidden = !items.length;
    $('rn-none').hidden = !!items.length;              // not one broker, c³'s or another: said so
  }

  //
  // remoteBrokers - the brokers Explore connected to (the configuration's, the last one first), less c³'s own:
  // one that runs is listed as c³'s, one stopped is under Set up and start a broker, Earlier settings
  //
  remoteBrokers() {
    const kept = this.state.brokers || [];
    return (this.configBrokers || []).filter((r) => r && r.url && !kept.some((b) => this.same(b.url, r.url)));
  }

  //
  // local - a URL of this machine
  //
  local(u) {
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; }
  }

  //
  // same - two URLs the same broker: the same host and port (localhost and 127.0.0.1 alike)
  //
  same(u1, u2) {
    const key = (u) => { try { const x = new URL(u); return x.protocol + '//' + x.hostname.replace(/^127\.0\.0\.1$/, 'localhost') + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80')); } catch { return u; } };
    return key(u1) === key(u2);
  }

  //
  // remoteRow - a broker c³ does not run: its name and URL, whether it answers, Explore
  //
  remoteRow(r, inCard = false) {
    const on = this.active(r.url);
    const ok = this.remoteAnswers.get(r.url);          // true, false, or not asked yet
    const item = el('div', 'rn-item' + (inCard ? '' : ' rn-row-link') + (on ? ' active' : ''));
    if (!inCard) {                                     // the row opens its card: configuration, metrics, levels
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.title = t('Open {name}', { name: r.name || r.url });
      const open = () => this.select('remote', r.url);
      item.addEventListener('click', (e) => { if (!e.target.closest('a, button')) open(); });
      item.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); open(); } });
    }
    item.append(el('span', 'rdot ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'busy')));
    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    const name = r.name && r.name !== r.url.replace(/^https?:\/\//, '') ? r.name : '';
    title.append(el('span', 'rname', name || r.url));
    if (on) title.append(el('span', 'badge active', t('in Explore')));
    title.append(el('span', 'badge ' + (ok === true ? 'ready' : 'stopped'), ok === true ? t('answers') : ok === false ? t('does not answer') : t('asking')));
    if (name) title.append(el('span', 'rurl', r.url));
    main.append(title, el('div', 'rmeta', this.local(r.url) ? t('on this machine, started outside c³ - connected to in Explore') : t('on another machine - connected to in Explore')));
    item.append(main);
    const acts = el('div', 'racts');
    const x = button(t('Explore'), '', () => this.onConnect(r.url));
    x.disabled = ok === false;
    if (x.disabled) x.title = t('{name} does not answer', { name: name || r.url });
    acts.append(x);
    item.append(acts);
    return item;
  }

  //
  // probeRemote - the configuration's brokers (Explore's), read again, and each one c³ does not run asked GET
  // /version through the proxy (any HTTP answer below 500 counts); every 10 s while Operate is shown
  //
  async probeRemote() {
    if (this.probingRemote) return;
    this.probingRemote = true;
    this.remoteAsked = Date.now();
    try { this.configBrokers = (await api.config()).brokers || []; } catch (e) { /* the list as it was */ }
    const ask = async (url) => {
      if (api.answeredWithin(url, 10000)) return true;           // it answered the page anyway (metrics, log lines, Explore)
      try {
        const r = await Promise.race([api.brokerGet(url, '/version', ''), new Promise((done) => setTimeout(() => done(null), 3000))]);
        return !!(r && r.reached && r.status > 0 && r.status < 500);
      } catch (e) { return false; }
    };
    const list = this.state ? this.remoteBrokers() : (this.configBrokers || []);
    const got = await Promise.all(list.map((r) => ask(r.url)));
    list.forEach((r, ix) => this.remoteAnswers.set(r.url, got[ix]));
    this.probingRemote = false;
    if (this.state) this.renderBrokers();
  }

  //
  // renderContainers - Containers: every container on this machine (GET /api/run "containers"), the 10 newest
  // (Show all for the rest), in a box that scrolls; each one Start or Stop and its Log (while it runs)
  //
  renderContainers() {
    const list = [...(this.state.containers || [])].sort((a, b) => String(b.created).localeCompare(String(a.created)));
    $('rn-ccount').textContent = list.length ? String(list.length) : '';
    const shown = this.ctrAll ? list : list.slice(0, 10);   // the 10 newest; the rest on asking
    $('rn-ctrs').replaceChildren(...shown.map((c) => this.containerRow(c)));
    $('rn-cmore').hidden = list.length <= 10;
    $('rn-cmore').replaceChildren(...(list.length > 10 ? [button(this.ctrAll ? t('Show the 10 newest') : t('Show all {n}', { n: list.length }), '',
      () => { this.ctrAll = !this.ctrAll; this.renderContainers(); if (!this.ctrAll) $('rn-ctrs').scrollTop = 0; })] : []));
    $('rn-ctrs').hidden = !list.length;
    $('rn-cnone').hidden = !!list.length || !this.state.engine || !this.state.engine.name;
    for (const n of [...this.ctrBusy.keys()]) {          // asked to start or stop: until its state changed
      const c = list.find((x) => x.name === n);
      if (!c || c.state !== this.ctrBusy.get(n)) this.ctrBusy.delete(n);
    }
  }

  //
  // containerRow - a container: its name, state and docker's words for it, what it is (a broker's or a service of
  // c³'s, else its image), its ports; Start / Stop (one button) and Log. c³'s broker containers start and stop
  // as the broker; a service a running broker of c³'s uses is stopped with that broker, not here
  //
  containerRow(c) {
    const runs = c.state === 'running';
    const busy = this.ctrBusy.has(c.name);
    const item = el('div', 'rn-item');
    item.append(el('span', 'rdot ' + (busy ? 'busy' : runs ? 'ok' : c.state === 'exited' && !/\(0\)/.test(c.status) ? 'bad' : '')));
    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', c.name), el('span', 'badge ' + (runs ? 'running' : 'exited'), stateName(c.state)));
    if (c.c3) title.append(el('span', 'badge', 'c³'));
    main.append(title);
    const svc = c.c3 && (this.state.services || []).find((x) => x.container === c.name);
    const what = c.kind === 'broker' ? t('broker {name}', { name: c.broker }) : svc ? svc.label : c.image;
    const ports = (c.ports || '').split(', ').filter((p) => p.includes('->')).map((p) => p.replace(/^0\.0\.0\.0:|^\[::\]:/, '')).filter((p, ix, all) => all.indexOf(p) === ix);
    main.append(el('div', 'rmeta', [what, c.status, ...ports].filter(Boolean).join(' · ')));
    if (this.ctrWhy.has(c.name)) main.append(el('div', 'rwhy bad', this.ctrWhy.get(c.name)));
    item.append(main);

    const acts = el('div', 'racts');
    const broker = c.kind === 'broker' && this.kept(c.broker);
    const users = svc ? svc.usedBy : [];
    const tog = button(busy ? (runs ? t('Stopping') : t('Starting')) : runs ? t('Stop') : t('Start'), '', () => this.containerToggle(c, broker));
    tog.disabled = busy || (runs && users.length > 0);
    if (runs && users.length) tog.title = t('{names} uses it - stop the broker', { names: users.join(', ') });
    const log = button(t('Log'), '', () => this.select('container', c.name));
    log.disabled = !runs;
    if (!runs) log.title = t('{name} does not run', { name: c.name });
    acts.append(tog, log);
    item.append(acts);
    return item;
  }

  async containerToggle(c, broker) {
    const runs = c.state === 'running';
    this.ctrBusy.set(c.name, c.state);
    this.renderContainers();
    this.renderCard();
    try {
      if (broker) await (runs ? api.runStop(broker.name) : api.runStartKept(broker.name));
      else await api.runContainer(c.name, runs ? 'stop' : 'start');
      this.ctrWhy.delete(c.name);
    } catch (e) {
      this.ctrBusy.delete(c.name);
      this.ctrWhy.set(c.name, e.message);
      this.renderContainers();
      this.renderCard();
    }
  }

  //
  // containerLog - a container's log on its card: its last 500 lines, read again every 3 s while the card shows
  //
  async containerLog(name) {
    clearTimeout(this.logPoll);
    if (this.mode !== 'item' || !this.sel || this.sel.kind !== 'container' || this.sel.name !== name) return;
    try {
      const r = await api.runContainerLog(name);
      const pre = $('rn-log');
      const end = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      if (this.containerText !== r.log) {
        this.containerText = r.log;
        this.logReset();
        this.append(r.log.replace(/\n$/, ''));
        if (end) pre.scrollTop = pre.scrollHeight;
      }
      this.note('');
    } catch (e) { this.note(e.message); }
    if (this.sel && this.sel.kind === 'container' && this.sel.name === name) this.logPoll = setTimeout(() => this.containerLog(name), 3000);
  }

  //
  // brokerRow - a broker in the list: a click opens its card
  //
  brokerRow(b) {
    const d = b.def;
    const on = this.active(b.url);
    const item = el('div', 'rn-item rn-row-link' + (on ? ' active' : ''));
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.title = t('Open {name}', { name: b.name });
    const open = () => this.select('broker', b.name);
    item.addEventListener('click', (e) => { if (!e.target.closest('a, button')) open(); });
    item.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); open(); } });
    item.append(el('span', 'rdot ' + this.dotOf(b)));

    const main = el('div', 'rmain');
    main.append(this.titleOf(b, on));
    main.append(el('div', 'rmeta', [this.sourceLabel(d), d.where === 'container' ? t('in a container') : t('natively'), t('port {port}', { port: d.port })].join(' · ')));
    if (b.state === 'running' && b.health) main.append(this.healthPills(b));
    else if (b.state === 'failed' && b.why) main.append(el('div', 'rwhy bad', b.why));
    item.append(main);

    const acts = el('div', 'racts');
    if (b.state === 'running') acts.append(button(t('Stop'), '', () => this.stopInList(b)), exploreButton(b, this.onConnect));
    item.append(acts);
    return item;
  }

  dotOf(b) {
    const runs = b.state === 'running';
    if (runs && (b.ready === 'ready' || b.ready === 'answers')) return 'ok';
    if (runs || b.state === 'starting' || b.state === 'stopping') return 'busy';
    return b.state === 'failed' ? 'bad' : '';
  }

  //
  // titleOf - a broker's name, its state, its URL (a link to Explore while it answers)
  //
  titleOf(b, on) {
    const runs = b.state === 'running';
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', b.name));
    if (on) title.append(el('span', 'badge active', t('in Explore')));
    title.append(el('span', 'badge ' + (runs && b.ready ? (answers(b) ? 'ready' : 'starting') : b.state), stateName(runs && b.ready ? b.ready : b.state)));
    if (answers(b)) {
      const a = el('a', 'rurl', b.url);
      a.href = '#connect';
      a.title = t('Open it in Explore');
      a.addEventListener('click', (e) => { e.preventDefault(); this.onConnect(b.url); });
      title.append(a);
    } else title.append(el('span', 'rurl', b.url));
    return title;
  }

  //
  // renderCard - the card of the broker or service selected: what it is, its actions, the services a broker
  // uses; one forgotten meanwhile (shown on the card before): back to the list. One just started is not in the
  // state yet: its card waits for it
  //
  renderCard() {
    if (this.mode !== 'item' || !this.sel || !this.state) return;
    const s = this.sel;
    const box = $('rn-card-item');
    if (s.kind === 'broker') {
      const b = this.kept(s.name);
      if (!b) {
        if (this.cardSeen) this.showView('list');
        else box.replaceChildren(el('span', 'rn-empty', s.name));
        return;
      }
      this.cardSeen = true;
      box.replaceChildren(this.brokerItem(b));
      const used = this.state.services.filter((x) => x.usedBy.includes(b.name) || b.services.includes(x.container) || x.neededBy.includes(b.name));
      $('rn-uses-box').hidden = !used.length;
      $('rn-services').replaceChildren(...used.map((x) => this.serviceItem(x, b.name)));
    } else if (s.kind === 'remote') {
      const r = this.remoteBrokers().find((v) => v.url === s.name);
      if (!r) { if (this.cardSeen) this.showView('list'); else box.replaceChildren(el('span', 'rn-empty', s.name)); return; }
      this.cardSeen = true;
      box.replaceChildren(this.remoteRow(r, true));
      $('rn-uses-box').hidden = true;
      $('rn-services').replaceChildren();
    } else if (s.kind === 'container') {
      const c = (this.state.containers || []).find((v) => v.name === s.name);
      if (!c) { if (this.cardSeen) this.showView('list'); return; }
      this.cardSeen = true;
      box.replaceChildren(this.containerRow(c));
      $('rn-uses-box').hidden = true;
      $('rn-services').replaceChildren();
    } else {
      const x = this.state.services.find((v) => v.container === s.name);
      if (!x) { if (this.cardSeen) this.showView('list'); return; }
      this.cardSeen = true;
      box.replaceChildren(this.serviceItem(x));
      $('rn-uses-box').hidden = true;
      $('rn-services').replaceChildren();
    }
  }

  //
  // brokerItem - the broker on its card: what it runs, where its data is, its health; Stop, Explore, its options
  //
  brokerItem(b) {
    const d = b.def;
    const on = this.active(b.url);
    const item = el('div', 'rn-item' + (on ? ' active' : ''));
    const runs = b.state === 'running';
    item.append(el('span', 'rdot ' + this.dotOf(b)));

    const main = el('div', 'rmain');
    main.append(this.titleOf(b, on));

    const meta = [this.sourceLabel(d), d.where === 'container' ? t('in a container') : t('natively'),
      d.store === 'corDB' ? (d.dbDir ? t('{store} on disk', { store: d.store }) : t('{store} in RAM', { store: d.store })) : d.store,
      t('history {name}', { name: d.history })];
    if (d.bridges && d.bridges.length) meta.push(t('bridges {list}', { list: d.bridges.join(', ') }));
    if (d.ckan && d.ckan.length) meta.push('CKAN ' + d.ckan.join(', '));
    meta.push(t('port {port}', { port: d.port }) + (d.healthPort ? ', ' + t('health {port}', { port: d.healthPort }) : ''));
    if (b.pid) meta.push(b.attached ? t('pid {pid} (attached)', { pid: b.pid }) : t('pid {pid}', { pid: b.pid }));
    if (b.container && runs) meta.push(b.container);
    main.append(el('div', 'rmeta', meta.join(' · ')));

    if (runs && b.health) main.append(this.healthPills(b));

    if (b.state === 'stopping' && b.stop) {
      const left = Math.max(0, b.stop.grace - Math.round((Date.now() - new Date(b.stop.asked).getTime()) / 1000));
      main.append(el('div', 'rwhy warn', b.stop.killed ? t('SIGKILL sent - the grace period is over') : t('SIGTERM sent - SIGKILL in {left} s if it has not stopped (grace {grace} s)', { left, grace: b.stop.grace })));
    } else if (b.state === 'starting') {
      main.append(el('div', 'rwhy warn', b.services.length ? t('starting its services, then the broker - the log follows it') : t('starting')));
    } else if (b.why) {
      main.append(el('div', 'rwhy' + (b.state === 'failed' ? ' bad' : ''), b.why));
    }
    const where = b.dataDir ? t('data in {dir}', { dir: b.dataDir }) : b.volume ? t('data in the volume {volume}', { volume: b.volume }) : t('data in RAM only');
    main.append(el('div', 'rmeta mono', where));
    item.append(main);

    const acts = el('div', 'racts');
    if (runs) {
      acts.append(button(t('Stop'), '', () => this.stop(b)));
      acts.append(exploreButton(b, this.onConnect));
      acts.append(button(t('Options'), '', () => this.edit(b, 'card')));  // to see them - and browse its OPC UA server
    } else if (b.state !== 'starting' && b.state !== 'stopping') {
      const st = button(t('Start'), 'primary', () => this.startKept(b));
      st.disabled = b.busy;
      acts.append(st);
      acts.append(button(t('Options'), '', () => this.edit(b, 'card')));
    }
    if (!runs && b.state !== 'starting' && b.state !== 'stopping') {
      if (this.armed === 'forget:' + b.name) {
        acts.append(button(t('Forget, keep data'), 'armed', () => this.forget(b, false)));
        if ((b.dataDir && b.dataOwn !== false) || b.volume) acts.append(button(t('Forget and delete data'), 'armed', () => this.forget(b, true)));
        acts.append(closeX(t('Cancel - forget nothing'), () => this.disarm()));
      } else acts.append(button(t('Forget'), '', () => this.arm('forget:' + b.name)));
    }
    item.append(acts);
    return item;
  }

  healthPills(b) {
    const h = b.health;
    const box = el('div', 'rhealth');
    const pill = (text, cls, title) => { const p = el('span', 'rn-pill' + (cls ? ' ' + cls : ''), text); if (title) p.title = title; box.append(p); };
    if (h.product) {                                // /version: no health port
      pill(h.product + ' ' + (h.version || ''), 'ok', t('GET /version - no health port'));
      return box;
    }
    if (typeof h.uptime === 'number') pill(t('up {time}', { time: ago(h.uptime) }));
    if (h.store) pill(t('store {plugin}', { plugin: h.store.plugin }) + (h.store.loaded === false ? ' ' + t('loading') : '') + (h.store.reachable === false ? ' ' + t('unreachable') : ''), h.store.reachable === false || h.store.loaded === false ? 'bad' : 'ok');
    if (h.troe) pill(t('history {name}', { name: h.troe.plugin }) + (h.troe.reachable === false ? ' ' + t('unreachable') : ''), h.troe.reachable === false ? 'bad' : 'ok');
    if (h.memory) pill(h.memory.budget ? t('{used} of {total}', { used: mib(h.memory.resident || h.memory.used || 0), total: mib(h.memory.budget) }) : mib(h.memory.resident || h.memory.used || 0), h.memory.level && h.memory.level !== 'ok' ? 'warn' : '', t('resident memory'));
    if (h.requests) pill(plural(h.requests.total, '{n} request', '{n} requests') + (h.requests.inFlight ? ', ' + t('{n} in flight', { n: h.requests.inFlight }) : ''));
    if (h.status && h.status !== 'ok') pill(h.status, 'warn');
    return box;
  }

  //
  // serviceItem - a service on a card: on a broker's (from), its Log opens the service's own card
  //
  serviceItem(s, from) {
    const item = el('div', 'rn-item');
    const runs = s.state === 'running';
    item.append(el('span', 'rdot ' + (runs ? 'ok' : (s.state === 'starting' || s.state === 'stopping') ? 'busy' : s.state === 'exited' ? 'bad' : '')));

    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', s.container), el('span', 'badge ' + s.state, stateName(s.state)));
    if (s.port && runs) title.append(el('span', 'rurl', '127.0.0.1:' + s.port));
    main.append(title);
    main.append(el('div', 'rmeta', [s.label, s.image, s.status || ''].filter(Boolean).join(' · ')));
    const used = s.usedBy.length ? t('used by {list}', { list: s.usedBy.join(', ') }) : t('used by no broker that runs');
    main.append(el('div', 'rmeta', used + (s.neededBy.length ? ' · ' + t('needed by {list}', { list: s.neededBy.join(', ') }) : '')));
    main.append(el('div', 'rmeta mono', s.volumeExists ? t('data in the volume {volume}', { volume: s.volume }) : t('no data yet (the volume {volume} is made at its first start)', { volume: s.volume })));
    item.append(main);

    const acts = el('div', 'racts');
    if (runs && !s.usedBy.length) acts.append(button(t('Stop'), '', () => this.stopService(s)));
    if (from) acts.append(button(t('Log'), '', () => this.select('service', s.container, { kind: 'broker', name: from })));
    if (s.volumeExists && !runs && s.state !== 'starting' && s.state !== 'stopping') {
      const armed = this.armed === 'vol:' + s.volume;
      acts.append(button(armed ? t('Delete {volume}? Sure', { volume: s.volume }) : t('Delete data'), armed ? 'armed' : '', () => this.deleteVolume(s.volume)));
    }
    item.append(acts);
    return item;
  }

  arm(key) {
    this.armed = key;
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.disarm(), 6000);
    this.rerender();
  }

  disarm() {
    this.armed = null;
    clearTimeout(this.armTimer);
    this.rerender();
  }

  rerender() {
    if (!this.state) return;
    this.renderLists();
    this.renderCard();
    if (this.mode === 'pick') this.renderEarlier();
    if (this.mode === 'form') this.renderNeed();
  }

  // ------------------------------------------------------------------ actions

  async act(fn) {
    try { await fn(); } catch (e) { this.note(e.message); }
    this.stateText = '';
    await this.load();
  }

  note(text) { $('rn-log-note').textContent = text; }

  stop(b) { this.select('broker', b.name); return this.act(() => api.runStop(b.name)); }

  //
  // stopInList - Stop on a broker's row: the list stays, the row goes "stopping" and then leaves; a stop that
  // fails opens the broker's card, where it says why
  //
  stopInList(b) { return this.act(() => api.runStop(b.name).catch((e) => { this.select('broker', b.name); throw e; })); }
  startKept(b) { this.select('broker', b.name); return this.act(() => api.runStartKept(b.name)); }
  stopService(s) { return this.act(() => api.runServiceStop(s.container)); }

  forget(b, data) {
    this.disarm();
    if (this.mode === 'item' && this.sel && this.sel.name === b.name) this.showView('list');
    return this.act(() => api.runForget(b.name, data));
  }

  deleteVolume(volume) {
    if (this.armed !== 'vol:' + volume) { this.arm('vol:' + volume); return; }
    this.disarm();
    return this.act(() => api.runVolumeDelete(volume));
  }

  //
  // edit - a kept broker's options into the form, step 2 (Start then replaces them); from: 'card' (its card's
  // Options - back goes there) or 'pick' (Earlier settings)
  //
  edit(b, from) {
    this.editingFrom = from;
    if (from === 'card') this.editBack = { ...this.sel };
    const d = b.def;
    const tag = d.image && d.image.startsWith(this.repo() + ':') ? d.image.slice(this.repo().length + 1) : (d.image || '');
    this.f = {
      name: d.name, set: d.set, from: d.from, build: d.build || '', tag, where: d.where,
      store: d.store, dbDir: d.dbDir, dbPath: d.dbPath || '', history: d.history, opts: {}, optsRaw: d.options || '', port: d.port, healthPort: d.healthPort, grace: d.grace,
      ws: (d.transports || []).includes('ws'), admin: d.admin, distributed: d.distributed !== false, verbose: d.verbose, bridges: [...(d.bridges || [])],
      bridgeConfig: d.bridgeConfig || '', userContext: d.userContext || '', ckan: [...(d.ckan || [])], args: d.args || '',
      opcua: this.opcuaDefaults(), dds: this.ddsDefaults(), aas: this.aasDefaults(),
    };
    if (d.dds) {
      const row = (kind, key) => (x) => ({ ...x, kind, name: x[key] });
      Object.assign(this.f.dds, {
        domain: d.dds.domain || 0, transport: d.dds.transport || '', interfaces: [...(d.dds.interfaces || [])], vocabulary: d.dds.vocabulary || '',
        rows: [...(d.dds.topics || []).map(row('topic', 'topic')), ...(d.dds.services || []).map(row('service', 'service')),
               ...(d.dds.actions || []).map(row('action', 'action'))],
      });
    }
    if (d.opcua) {
      const o = d.opcua, sec = o.security || {}, u = o.user || {};
      Object.assign(this.f.opcua, {
        url: o.url || '', roots: (o.roots || []).join('\n'), mode: sec.mode || 'None', policy: sec.policy || '',
        channels: (o.channels || []).map((c) => ({ node: c.node || '', entityId: c.entityId || '', entityType: c.entityType || '', attribute: c.attribute || '' })),
        certificate: sec.certificate || '', privateKey: sec.privateKey || '', applicationUri: sec.applicationUri || '',
        trustList: (sec.trustList || []).join('\n'), trustAny: !!sec.trustAny, username: u.username || '',
        passwordSet: !!u.passwordSet,
      });
    }
    this.f.aas = this.aas.fromDef(d.aas);
    this.f.picked = true;
    this.nameTouched = true;
    this.editing = d.name;
    this.portsChosen = true;
    this.showView('form');
  }

  // ------------------------------------------------------------------ log and trace levels

  //
  // levelsBroker - the selected broker, when it runs with the admin API: its URL; null otherwise
  //
  levelsBroker() {
    const s = this.sel;
    if (s && s.kind === 'remote') return this.remoteAdmin.get(s.name) === true ? s.name : null;   // remoteCard
    const k = s && s.kind === 'broker' ? this.kept(s.name) : null;
    return k && k.state === 'running' && k.def.admin ? 'http://localhost:' + k.def.port : null;
  }

  //
  // levelsShow - the Levels panel for the selected broker: shown for a running one with the admin API, read
  // when opened and when a broker is selected (reload) - not on every state poll, which would redraw it under
  // a click
  //
  //
  // configShow - the Configuration panel of the selected broker: shown as Levels is, read when opened
  //
  configShow(reload = true) {
    const d = $('rn-config');
    const url = this.levelsBroker();
    d.hidden = !url;
    if (!url) { d.open = false; return; }
    if (!this.configWired) {
      this.configWired = true;
      d.addEventListener('toggle', () => { if (d.open) this.configLoad(); });
    }
    if (d.open && reload) this.configLoad();
  }

  //
  // configLoad - GET /build (what the broker is built with) and /admin/config (the options it runs with)
  //
  async configLoad() {
    const url = this.levelsBroker();
    if (!url) return;
    const [b, c] = await Promise.all([api.brokerGet(url, '/build'), api.brokerGet(url, '/admin/config')]);
    const body = $('rn-config-body');
    body.replaceChildren();
    const why = (r) => (r.body && (r.body.detail || r.body.title)) || 'HTTP ' + r.status;

    if (b.ok && b.body) {
      const bd = b.body.build || {};
      body.append(el('div', 'rn-lvnote', [b.body.version, bd.type, bd.httpServer && t('HTTP server {name}', { name: bd.httpServer }),
        bd.gitSha && 'git ' + String(bd.gitSha).slice(0, 8), bd.builtAt && t('built {when}', { when: bd.builtAt })].filter(Boolean).join(' - ')));
      const feats = el('div', 'rn-cfgfeat');
      for (const [k, v] of Object.entries(b.body.features || {})) {
        const s = el('span', v ? 'on' : 'off', k);
        s.title = v ? t('compiled in') : t('compiled out - only another build brings it');
        feats.append(s);
      }
      body.append(feats);
      const loaded = (b.body.plugins && b.body.plugins.loaded) || {};
      const names = Object.entries(loaded).flatMap(([kind, v]) => (Array.isArray(v) ? v : [v]).filter(Boolean)
        .map((p) => kind + ' ' + (p.alias || p.name || '')));
      if (names.length) body.append(el('div', 'rn-lvnote', t('Plugins loaded: {list}', { list: names.join(', ') })));
    } else {
      body.append(el('div', 'rn-lvnote warn', 'GET /build: ' + why(b)));
    }

    if (!c.ok || !c.body) {
      body.append(el('div', 'rn-lvnote warn', 'GET /admin/config: ' + why(c) + (c.status === 404 ? ' - ' + t('a coraine older than /admin/config') : '')));
      $('rn-config-sum').textContent = t('Configuration and build');
      return;
    }
    const opts = c.body.options || [];
    const set = opts.filter((o) => o.from !== 'default');
    const tab = el('table', 'rn-cfgtab');
    const head = el('tr');
    for (const h of [t('option'), t('value'), t('from'), t('default')]) head.append(el('th', '', h));
    tab.append(head);
    let section = null;
    for (const o of opts) {
      const sec = o.section || 'coraine';
      if (sec !== section) {
        section = sec;
        const tr = el('tr', 'sec');
        const td = el('td', '', sec.replace(/:$/, ''));
        td.colSpan = 4;
        tr.append(td);
        tab.append(tr);
      }
      const tr = el('tr', o.from !== 'default' ? 'set' : '');
      const show = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
      const n = el('td', 'n', o.name);
      n.title = (o.description || '') + (o.env ? '\n' + t('environment: {env}', { env: o.env }) : '') + (o.short ? '\n' + t('short: {option}', { option: o.short }) : '');
      const v = el('td', 'v', show(o.value));
      if (o.secret) v.title = t('a secret - never shown');
      const resolved = o.from === 'default' && !o.secret && show(o.value) !== show(o.default);   // 0 = "the broker decides"
      const fromText = resolved ? t('default, resolved by the broker')
        : { default: '', env: t('environment'), longOption: t('command line'), shortOption: t('command line'), configFile: t('config file') }[o.from] || o.from;
      tr.append(n, v, el('td', '', fromText), el('td', 'd', show(o.default)));
      tab.append(tr);
    }
    const wrap = el('div', 'rn-cfgwrap');
    wrap.append(tab);
    body.append(el('div', 'rn-lvnote', t('Read-only: {n} options, {set} not at their default (bold). Hover an option for what it does.', { n: opts.length, set: set.length })), wrap);
    $('rn-config-sum').textContent = plural(set.length, 'Configuration and build - {n} option set', 'Configuration and build - {n} options set');
  }

  // ------------------------------------------------------------------ metrics

  //
  // metricsShow - the Metrics panel of the selected broker: shown as Levels is; while it is open (and the
  // page shown), every running broker with the admin API is read every 5 s (metrics.js), so a broker selected
  // later has its last minutes too
  //
  metricsShow() {
    const d = $('rn-metrics');
    const url = this.levelsBroker();
    d.hidden = !url;
    if (!this.metricsWired) {
      this.metricsWired = true;
      d.addEventListener('toggle', () => this.metricsShow());
    }
    if (!url || !d.open || !this.shown) {
      this.metrics.stop();
      if (!url) $('rn-metrics-sum').textContent = t('Metrics');
      return;
    }
    const urls = () => ((this.state && this.state.brokers) || []).filter((b) => b.state === 'running' && b.def.admin)
      .map((b) => 'http://localhost:' + b.def.port).concat(this.sel && this.sel.kind === 'remote' && this.levelsBroker() ? [this.sel.name] : []);
    this.metrics.start(urls, () => this.metricsRender());
    this.metricsRender();
  }

  metricsRender() {
    const url = this.levelsBroker();
    if (!url || !$('rn-metrics').open) return;
    //
    // Drawn again with each read: the row stays scrolled where the user left it, the chart with the focus keeps it
    //
    const body = $('rn-metrics-body');
    const old = body.querySelector('.mx-grid');
    const left = old && this.metricsUrl === url ? old.scrollLeft : 0;
    const charts = old ? [...old.children] : [];
    const focused = charts.indexOf(document.activeElement);
    body.replaceChildren(this.metrics.render(url));
    this.metricsUrl = url;
    const grid = body.querySelector('.mx-grid');
    if (grid) {
      grid.scrollLeft = left;
      if (focused >= 0 && grid.children[focused]) grid.children[focused].focus({ preventScroll: true });
    }
    const sum = this.metrics.summary(url);
    $('rn-metrics-sum').textContent = t('Metrics') + (sum ? ' - ' + sum : '');
  }

  levelsShow(reload = true) {
    const d = $('rn-levels');
    const url = this.levelsBroker();
    d.hidden = !url;
    if (!url) { d.open = false; return; }
    if (!this.levelsWired) {
      this.levelsWired = true;
      d.addEventListener('toggle', () => { if (d.open) this.levelsLoad(); });
    }
    if (d.open && reload) this.levelsLoad();
  }

  async levelsLoad() {
    const url = this.levelsBroker();
    if (!url) return;
    if (!this.traceLevels) {
      try { this.traceLevels = await (await fetch('data/traceLevels.json')).json(); } catch (e) { this.traceLevels = []; }
    }
    const r = await api.brokerGet(url, '/admin/log');
    this.levelsRender(url, r);
  }

  //
  // levelsRender - verbose and info, and a tick box per trace level by library, its tooltip what it
  // traces; a change is PUT at once (the whole set: PUT replaces), and the broker's answer shown
  //
  levelsRender(url, r) {
    const body = $('rn-levels-body');
    body.replaceChildren();
    if (!r.ok || !r.body) {
      body.append(el('div', 'rn-lvnote warn', 'GET /admin/log: ' + ((r.body && (r.body.detail || r.body.title)) || 'HTTP ' + r.status)));
      return;
    }
    const cur = r.body;
    const on = parseLevels(cur.traceLevels || '');
    const known = new Set(this.traceLevels.map((t) => t.level));
    const traces = cur.traces;                               // coraine with "traces": compiled in or not

    const apply = async () => {
      const q = new URLSearchParams();
      for (const f of ['verbose', 'info']) q.set(f, body.querySelector('[data-flag="' + f + '"]').checked ? 'on' : 'off');
      const set = [...body.querySelectorAll('[data-level]')].filter((c) => c.checked).map((c) => Number(c.dataset.level));
      for (const l of on) if (!known.has(l)) set.push(l);                         // levels c3 does not know stay
      q.set('traceLevels', rangesOf(set));
      const w = await api.brokerWrite(url, 'PUT', '/admin/log?' + q.toString());
      this.levelsRender(url, w.ok ? w : r);
      if (w.ok) {                                      // the broker has it - said, for a moment
        const ok = el('span', 'rn-lvsent', '✓ ' + t('sent to the broker'));
        $('rn-levels-body').querySelector('.rn-lvhow').append(ok);
        setTimeout(() => ok.remove(), 2500);
      }
      if (!w.ok) $('rn-levels-body').prepend(el('div', 'rn-lvnote warn', 'PUT /admin/log: ' + ((w.body && (w.body.detail || w.body.title)) || 'HTTP ' + w.status)));
    };

    body.append(el('div', 'rn-lvnote rn-lvhow', t('A tick takes effect at once: it is sent to the broker (PUT /admin/log) as you click.') + ' '));
    const flags = el('div', 'rn-lvflags');
    for (const [f, label, why] of [['verbose', 'verbose', t('the -v lines: what the broker does, request by request')],
                                   ['info', 'info', t('info lines')]]) {
      const l = el('label', 'rn-check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !!cur[f];
      c.dataset.flag = f;
      c.addEventListener('change', apply);
      l.title = why;
      l.append(c, document.createTextNode(' ' + label));
      flags.append(l);
    }
    body.append(flags);

    if (traces === false) body.append(el('div', 'rn-lvnote warn', t('A release build: traces are compiled out - trace levels are kept and trace nothing. A debug build (Compile, mode Debug) traces.')));
    else if (traces === undefined) body.append(el('div', 'rn-lvnote', t('This broker does not say whether it has traces compiled in - only debug builds do.')));

    const libs = [];
    for (const t of this.traceLevels) {
      let g = libs.find((x) => x.name === t.library);
      if (!g) libs.push(g = { name: t.library, levels: [] });
      g.levels.push(t);
    }
    for (const g of libs) {
      const fs = el('fieldset', 'rn-lvlib');
      fs.append(el('legend', '', g.name + ' ' + g.levels[0].level + '-' + g.levels[g.levels.length - 1].level));
      const grid = el('div', 'rn-lvgrid');
      for (const t of g.levels) {
        const l = el('label', 'rn-lv');
        const c = el('input');
        c.type = 'checkbox';
        c.checked = on.has(t.level);
        c.disabled = traces === false;
        c.dataset.level = t.level;
        c.addEventListener('change', apply);
        l.title = t.level + ' ' + t.name + ': ' + t.traces;
        l.append(c, el('span', 'n', String(t.level)), el('span', 't', t.traces));
        grid.append(l);
      }
      fs.append(grid);
      body.append(fs);
    }

    const other = [...on].filter((l) => !known.has(l));
    if (other.length) body.append(el('div', 'rn-lvnote', t('Also set, levels c3 has no name for: {levels}', { levels: rangesOf(other) })));
    const n = on.size;
    const what = ['verbose', 'info'].filter((f) => cur[f]).concat(n ? [plural(n, '{n} trace level', '{n} trace levels')] : []).join(', ');
    $('rn-levels-sum').textContent = t('Log and trace levels - {what}', { what: what || t('nothing extra') });
  }

  // ------------------------------------------------------------------ the log

  //
  // select - the card of a broker (or a service) and its log; back: the card the arrow returns to (a service's
  // card opened from its broker's)
  //
  select(kind, name, back = null) {
    if (this.mode !== 'item') this.showView('item');
    this.sel = { kind, name };
    this.back = back;
    this.cardSeen = false;
    $('rn-card-back').textContent = '← ' + (back ? back.name : t('Operate'));
    this.renderCard();
    this.configShow();
    this.levelsShow();
    this.metricsShow();
    if (kind === 'remote') {                           // its log is not c³'s: where it goes said (remoteCard)
      this.follow(null);
      $('rn-log-name').textContent = name;
      this.logStart = null;
      this.remoteCard(name);
      return;
    }
    if (kind === 'container') {                        // its last lines from the engine, read again (containerLog)
      this.follow(null);
      this.logStart = null;
      $('rn-log-name').textContent = name;
      this.containerLog(name);
      return;
    }
    $('rn-log-name').textContent = name;
    const base = '/api/run/' + (kind === 'broker' ? 'brokers' : 'services') + '/' + encodeURIComponent(name) + '/log';
    const a = $('rn-log-file');
    a.href = base;
    a.hidden = false;
    this.follow(base);
    this.logStart = null;                              // a service's: not known
    if (kind === 'broker') {                           // its start: c3's 'started', then the broker's own (logStartAsk)
      const k = this.kept(name);
      this.logStart = k && k.started ? Date.parse(k.started) : null;
      this.logStartAsk(this.levelsBroker());
    }
  }

  //
  // remoteCard - a broker c³ does not run: GET /admin/config says whether it has the admin API (Configuration,
  // Metrics and Levels shown then) and where its log goes (--logTo, --logDir) - c³ cannot show that log
  //
  async remoteCard(url) {
    const r = await api.brokerGet(url, '/admin/config');
    if (!this.sel || this.sel.kind !== 'remote' || this.sel.name !== url) return;
    const opts = r.ok && r.body && Array.isArray(r.body.options) ? r.body.options : null;
    this.remoteAdmin.set(url, !!opts);
    this.configShow();
    this.levelsShow();
    this.metricsShow();
    const opt = (n) => { const o = opts && opts.find((x) => x.name === n); return o ? o.value : null; };
    const to = opt('--logTo');
    if (opts && (to === 'file' || to === 'both') && this.local(url)) {   // c3 reads it: externalLog
      const base = '/api/run/external/log?port=' + (new URL(url).port || '80');
      const a = $('rn-log-file');
      a.href = base;
      a.hidden = false;
      this.logGen++;                                   // one reading loop, also when the card is shown again
      clearTimeout(this.logPoll);
      this.logReset();
      this.pollLog(base, -65536);
      this.logStartAsk(url);                           // after the log's own start: its generation
      return;
    }
    if (!opts) {
      this.noLog(r.reached === false ? t('No log: {url} does not answer.', { url }) : t('No log, configuration, metrics or levels: this broker has no admin API (GET /admin/config: HTTP {status}).', { status: r.status }));
      return;
    }
    this.logGen++;
    clearTimeout(this.logPoll);
    this.logReset();
    this.ringLog(url, null, new Set(), this.logGen);
    this.logStartAsk(url);
  }

  //
  // ringLog - the recent log a coraine keeps in memory (GET /admin/log/lines, --logLines), whatever --logTo is:
  // its last 500 lines, then what is new every 2 s ('since' the last line's time - that time's lines come again,
  // the ones shown dropped). None (an older coraine, --logLines 0): no Log section, why said
  //
  async ringLog(url, since, seen, gen) {
    const r = await api.brokerGet(url, '/admin/log/lines?lines=' + (since ? 2000 : 500) + (since ? '&since=' + encodeURIComponent(since) : ''));
    if (this.logGen !== gen) return;
    if (r.ok && r.body && Array.isArray(r.body.lines)) {
      const fresh = r.body.lines.filter((l) => !seen.has(l));
      if (fresh.length) {
        const last = fresh[fresh.length - 1].slice(0, 24);
        if (last !== since) seen.clear();
        for (const l of fresh) if (l.startsWith(last)) seen.add(l);
        since = last;
        this.append(fresh.join('\n'));
      }
    } else if (!since) {
      this.noLog(r.status === 409 ? t('No log: this broker keeps none in memory (--logLines 0) and c³ cannot read where it writes it.')
        : r.status === 404 ? t('No log: this coraine is older than GET /admin/log/lines, and c³ cannot read where it writes its log.')
        : t('No log: GET /admin/log/lines: {why}', { why: (r.body && (r.body.detail || r.body.title)) || 'HTTP ' + r.status }));
      return;
    }
    if (this.shown) this.logPoll = setTimeout(() => this.ringLog(url, since, seen, gen), 2000);
  }

  //
  // noLog - no log to show: the Log section hidden, one line saying why (null: the Log section back)
  //
  noLog(why) {
    $('rn-logcard').hidden = !!why;
    $('rn-nolog').hidden = !why;
    $('rn-nolog').textContent = why || '';
  }

  follow(url) {
    if (this.es) { this.es.close(); this.es = null; }
    clearTimeout(this.logPoll);
    this.logGen = (this.logGen || 0) + 1;              // pollLog: a read of an earlier follow drops its answer
    this.noLog(null);
    this.logReset();
    this.note('');
    if (!url) { $('rn-log-name').textContent = '-'; $('rn-log-file').hidden = true; return; }

    const caps = this.compileCaps;
    if (caps && caps.liveLog === false) { this.pollLog(url, 0); return; }

    const es = new EventSource(url);
    this.es = es;
    es.onmessage = (e) => this.append(e.data);
    es.addEventListener('reset', () => this.logReset());
    es.addEventListener('skipped', (e) => this.note(t('The first {n} MiB of the log are not shown here - the whole file has them.', { n: (Number(e.data) / 1048576).toFixed(1) })));
    es.addEventListener('busy', (e) => this.note(e.data));
  }

  //
  // pollLog - a backend without streamed responses: the file by Range, every second
  //
  async pollLog(url, from, gen = this.logGen) {
    try {
      const r = await fetch(url, { headers: { Range: from < 0 ? 'bytes=' + from : 'bytes=' + from + '-' } });   // < 0: its last -from bytes
      if (this.logGen !== gen) return;
      if (r.status === 206 || r.status === 200) {
        let text = await r.text();
        if (from < 0) {                                  // the tail: from its first whole line, the next read after it
          const m = /bytes (\d+)-\d+\/(\d+)/.exec(r.headers.get('Content-Range') || '');
          const start = m ? Number(m[1]) : 0;
          from = start;
          if (start > 0) { const nl = text.indexOf('\n') + 1; from += new TextEncoder().encode(text.slice(0, nl)).length; text = text.slice(nl); }
        }
        const cut = text.lastIndexOf('\n') + 1;
        if (cut > 0) { this.append(text.slice(0, cut - 1)); from += new TextEncoder().encode(text.slice(0, cut)).length; }
      } else if (r.status === 416) {                     // nothing new - or the file is shorter now (a new start): from its top
        const m = /bytes \*\/(\d+)/.exec(r.headers.get('Content-Range') || '');
        if (from < 0 || (m && Number(m[1]) < from)) from = 0;
      }
    } catch (e) { /* the next round */ }
    if (this.shown && this.logGen === gen) this.logPoll = setTimeout(() => this.pollLog(url, from, gen), 1000);
  }

  append(text) {
    const pre = $('rn-log');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    let frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      //
      // A start begins the broker's log again: only the latest attempt is shown - the earlier ones are
      // in the whole file (the link). Without this, every attempt added its lines under the last.
      //
      if (/^c3: \S+ start '/.test(line)) {
        this.logReset();
        this.logStart = Date.now();                    // until the broker says (logStartAsk, once it answers)
        const url = this.levelsBroker(), gen = this.logGen;
        if (url) setTimeout(() => this.logStartAsk(url, gen), 5000);
        frag = document.createDocumentFragment();
      }
      this.logRaw.push(line);
      frag.append(this.logRow(line));
    }
    pre.append(frag);
    while (pre.childNodes.length > 20000) { pre.firstChild.remove(); this.logRaw.shift(); }
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }

  //
  // logReset - an empty log: its lines and what is shown of them
  //
  logReset() {
    $('rn-log').replaceChildren();
    this.logRaw = [];
    this.containerText = null;
  }

  //
  // logRow - a line as the log shows it: Text - the line as written, errors and warnings coloured; JSON - a corLog
  // line as its type and message, its object (logLine) opened by a click; a line of another kind as it is
  //
  logRow(line) {
    const cls = line.startsWith('c3: ') ? 'c3' : /^(\S+Z )?[EX]: /.test(line) ? 'er' : /^(\S+Z )?W: /.test(line) ? 'wa' : '';
    const o = this.logView === 'json' ? logLine(line) : null;
    if (!o) return cls ? el('span', cls, line + '\n') : document.createTextNode(line + '\n');
    const d = el('details', 'lj' + (cls ? ' ' + cls : ''));
    d.append(el('summary', '', o.type + ': ' + o.message));
    d.addEventListener('toggle', () => {                            // its object, made when first opened
      if (d.open && d.children.length === 1) d.append(el('pre', 'ljo', JSON.stringify(this.logShown(o), null, 2)));
    });
    return d;
  }

  //
  // logShown - a line's object with the time chosen (Clock / Uptime): 'time' - when it was written, UTC (its own
  // time, or the broker's start plus its uptime) - or 'uptime', seconds since the broker started; uptime when the
  // start is not known
  //
  logShown(o) {
    const { time, uptime, ...rest } = o;
    const at = time || (this.logStart !== null ? new Date(this.logStart + Math.round(uptime * 1000)).toISOString() : null);
    return this.logTime === 'clock' && at ? { time: at, ...rest } : { uptime, ...rest };
  }

  //
  // logStartAsk - the broker's start, exactly: one line of what it keeps in memory has both its UTC time and its
  // uptime (GET /admin/log/lines?lines=1); a broker without it keeps what c3 knows (its 'started', or nothing)
  //
  async logStartAsk(url, gen = this.logGen) {
    if (!url) return;
    const r = await api.brokerGet(url, '/admin/log/lines?lines=1');
    const o = r.ok && r.body && Array.isArray(r.body.lines) && r.body.lines.length ? logLine(r.body.lines[0]) : null;
    if (this.logGen !== gen || !o || !o.time) return;
    this.logStart = Date.parse(o.time) - Math.round(o.uptime * 1000);
  }

  //
  // logTimeSet - Clock or Uptime in the JSON view's objects: kept in the browser; the log shown again
  //
  logTimeSet(v) {
    this.logTime = v === 'uptime' ? 'uptime' : 'clock';
    try { localStorage.setItem('c3.log.time', this.logTime); } catch { /* not kept */ }
    for (const b of $('rn-log-time').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === this.logTime));
    this.logViewSet(this.logView);
  }

  //
  // logViewSet - Text or JSON: the switch pressed, every line kept shown again that way, the choice kept
  //
  logViewSet(view) {
    this.logView = view === 'json' ? 'json' : 'text';
    try { localStorage.setItem('c3.log.view', this.logView); } catch { /* not kept */ }
    for (const b of $('rn-log-view').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === this.logView));
    const pre = $('rn-log');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of this.logRaw) frag.append(this.logRow(line));
    pre.replaceChildren(frag);
    pre.classList.toggle('json', this.logView === 'json');
    $('rn-log-time').hidden = this.logView !== 'json';
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
    const known = (this.imageCaps || {})[this.imageRef()];
    return { version: known ? known.version : null, bridges: ['dds', 'loopback', 'modbus', 'mqtt'] };   // the published image's, until it says
  }

  imageRef() { return this.f.tag.includes('/') ? this.f.tag : this.repo() + ':' + this.f.tag; }

  //
  // plugins - what the source's plugin directory has (its --version's plugins line); null: not known
  //
  plugins() {
    const s = this.source();
    return s ? pluginsOf(s.version) : null;
  }

  //
  // can - the source has this plugin ('db', 'mongoc'); not known (no plugins line): yes - the features decide
  //
  can(kind, name) {
    const p = this.plugins();
    return !p || !p[kind] || p[kind].includes(name);
  }

  //
  // bridges - the bridges the form offers: the plugins line's, else the bridge/*.so of the source's plugin
  // directory - loopback, the reference and test bridge, never
  //
  bridges() {
    const p = this.plugins();
    const s = this.source();
    return ((p && p.bridges) || (s && s.bridges) || []).filter((b) => b !== 'loopback');
  }

  bridgeOk(name) { return this.bridges().includes(name); }

  //
  // loadImageCaps - what an image's broker has (GET /api/run/image: its --version, read once per image); an
  // image not here is known only after its start pulls it
  //
  async loadImageCaps() {
    const ref = this.imageRef();
    this.imageCaps = this.imageCaps || {};
    if (!this.f.tag || this.imageCaps[ref]) return;
    this.imageCaps[ref] = { asking: true, version: null };
    this.renderForm();
    try {
      const r = await api.runImage(ref);
      this.imageCaps[ref] = { here: r.here, version: r.version };
    } catch (e) {
      this.imageCaps[ref] = { here: false, version: null, why: e.message };
    }
    if (this.f.from === 'image' && this.imageRef() === ref) this.renderForm();
  }

  //
  // The broker's options (GET /api/run/options: its -u and -U with the store and history chosen), read once per
  // source, store and history
  //
  optsKey() {
    const f = this.f;
    const src = f.from === 'build' ? f.build : f.from === 'image' ? this.imageRef() : '';
    return [f.from, src, f.store, f.history].join('|');
  }

  async loadOptions(key) {
    this.usageCache = this.usageCache || {};
    if (this.usageCache[key]) return;
    this.usageCache[key] = { asking: true };
    const [from, src, database, troe] = key.split('|');
    try {
      const r = await api.runOptions(from, src, database, troe);
      this.usageCache[key] = r.usage ? { list: usageOf(r.usage, r.extended) } : { why: r.why || t('the broker did not say') };
    } catch (e) {
      this.usageCache[key] = { why: e.message };
    }
    if (this.mode === 'form' && this.optsKey() === key) { this.renderOptions(); this.commandSoon(); }
  }

  usage() {
    const u = (this.usageCache || {})[this.optsKey()];
    return u && u.list ? u.list : null;
  }

  //
  // optionsArg - the options set in the list, as def.options (quoted as More options); before the list is read, those
  // of the definition edited
  //
  optionsArg() {
    const f = this.f;
    const list = this.usage();
    if (!list) return f.optsRaw || '';
    const out = [];
    for (const o of list) {
      const v = f.opts[o.name];
      if (OPTS_FORM.has(o.name) || OPTS_BOUND[o.name] || v === undefined || v === '' || v === false) continue;
      out.push(o.bool ? o.name : o.name + ' ' + optQuote(String(v)));
    }
    return out.join(' ');
  }

  //
  // renderOptions - every option of the broker's usage the form has no field for: a tick, a choice or a value, the
  // default greyed; those c³ sets itself (the command's) shown with what it sets; '?' - coraine's own words
  //
  renderOptions() {
    const f = this.f;
    const box = $('rn-opts');
    if (box.contains(document.activeElement)) return;                   // typing in one: not rebuilt under the cursor
    const key = this.optsKey();
    const k = f.from === 'image' ? (this.imageCaps || {})[this.imageRef()] : null;
    if (k && !k.asking && !k.version) { box.replaceChildren(el('span', 'cp-note', t('known after the start pulls the image'))); return; }
    const u = (this.usageCache || {})[key];
    if (!u || u.asking) { box.replaceChildren(el('span', 'cp-note', t('reading the broker\'s options ...'))); this.loadOptions(key); return; }
    if (u.why) { box.replaceChildren(el('span', 'cp-note', u.why)); return; }

    if (f.optsRaw) {                                   // a kept broker's options: by the usage, its ticks and values
      const toks = f.optsRaw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
      for (let i = 0; i < toks.length; i++) {
        const o = u.list.find((x) => x.name === toks[i]);
        if (!o) continue;
        if (o.bool) f.opts[o.name] = true;
        else if (i + 1 < toks.length) f.opts[o.name] = toks[++i].replace(/^(["'])(.*)\1$/, '$2');
      }
      f.optsRaw = '';
    }

    //
    // What c³ sets itself: the command's options that are not the user's
    //
    const argv = (this.plan && this.plan.argv) || [];
    const c3 = {};
    for (let i = 0; i < argv.length; i++) {
      const o = u.list.find((x) => x.name === argv[i] || x.short === argv[i]);
      if (!o || OPTS_FORM.has(o.name) || f.opts[o.name] !== undefined || (f.args || '').includes(o.name)) continue;
      c3[o.name] = o.bool ? true : argv[i + 1];
    }

    const groups = [];
    for (const o of u.list) {
      if (OPTS_FORM.has(o.name)) continue;
      let g = groups.find((x) => x.section === o.section);
      if (!g) groups.push(g = { section: o.section, rows: [] });
      g.rows.push(this.optRow(o, c3[o.name]));
    }
    box.replaceChildren(...groups.flatMap((g) => {
      const grid = el('div', 'rn-optgrid');
      grid.append(...g.rows);
      return [el('div', 'rn-optsec', g.section || t('The broker')), grid];
    }));
  }

  optRow(o, c3) {
    const f = this.f;
    const bound = OPTS_BOUND[o.name];
    const get = () => (bound ? f[bound] : f.opts[o.name]);
    const put = (v) => { if (bound) f[bound] = v; else if (v === '' || v === false) delete f.opts[o.name]; else f.opts[o.name] = v; this.commandSoon(); };
    const row = el('div', 'rn-opt');
    const name = el('span', 'mono rn-optname', o.name);
    let input;
    if (o.bool) {
      input = el('input');
      input.type = 'checkbox';
      input.checked = c3 !== undefined ? true : !!get();
      input.addEventListener('change', () => put(input.checked));
      const l = el('label', 'rn-optbool');
      l.append(input, name);
      row.append(l);
    } else {
      if (o.values) {
        input = el('select', 'rn-select');
        const d = el('option', '', o.dflt ? t('default ({value})', { value: o.dflt }) : t('default'));
        d.value = '';
        input.append(d, ...o.values.map((v) => { const x = el('option', '', v); x.value = v; return x; }));
        input.value = c3 !== undefined ? c3 : get() || '';
        input.addEventListener('change', () => put(input.value));
      } else {
        input = el('input', 'cp-input');
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = o.dflt;
        input.value = c3 !== undefined ? c3 : get() || '';
        input.addEventListener('input', () => put(input.value.trim()));
      }
      input.setAttribute('aria-label', o.name);
      row.append(name, input);
    }
    if (c3 !== undefined) { input.disabled = true; row.title = t('c³ sets it'); row.classList.add('c3'); }
    const q = el('button', 'cp-q inline rn-q', '?');
    q.type = 'button';
    q.title = t('What is {what}?', { what: o.name });
    q.setAttribute('aria-label', q.title);
    const dflt = o.dflt ? '\n\n' + t('Default: {value}', { value: '`' + o.dflt + '`' }) : '';
    q.addEventListener('click', (e) => { e.preventDefault(); helpShow(o.name + ' (' + o.short + ')', o.help.charAt(0).toUpperCase() + o.help.slice(1) + dflt + (c3 !== undefined ? '\n\n' + t('c³ sets it') : '')); });
    row.append(q);
    return row;
  }

  //
  // fit - the form after its source changed: what the broker cannot do is not asked of it - a store, a
  // history, a bridge, a switch it lacks
  //
  fit() {
    const f = this.f;
    if (!this.source()) return;                        // not known yet (the sources not read): nothing dropped
    if (!this.can('db', f.store)) f.store = ['corDB', 'ramDB', 'mongoc'].find((x) => this.can('db', x)) || f.store;
    if (!this.can('troe', f.history)) f.history = 'none';
    f.bridges = f.bridges.filter((b) => this.bridgeOk(b));
    if (!this.bridgeOk('ckan')) f.ckan = [];
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

  renderName() {
    if (!this.nameTouched) {
      const base = this.f.from === 'build' && this.f.build ? this.f.build : 'coraine';
      this.f.name = (base + '-' + (this.f.port || '')).slice(0, 64);
      $('rn-name').value = '';
      $('rn-name').placeholder = this.f.name;
    } else if (document.activeElement !== $('rn-name') && $('rn-name').value !== this.f.name) {
      $('rn-name').value = this.f.name;                // a kept broker's options (edit): its name
    }
    const k = this.kept(this.f.name);
    $('rn-form-sub').textContent = k ? t('replaces the options of {name}', { name: k.name }) : '';
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
    this.fit();
    const cont = this.containers();
    const noCont = (this.caps && this.caps.containersWhy) || t('install docker or podman');

    //
    // From: what step 1 chose - Change goes back to it
    //
    const inst = this.sources && this.sources.installed;
    const src = this.source();
    $('rn-chosen').textContent = f.from === 'build' ? t('build {build}', { build: f.build })
      : f.from === 'image' ? (f.tag.includes('/') ? f.tag : this.repo() + ':' + f.tag) : t('installed coraine');
    let fromNote = '';
    if (f.from === 'installed') fromNote = inst ? inst.path + ' · ' + (inst.version || '').split('\n')[0] : t('no coraine in $PATH');
    else if (f.from === 'build') fromNote = src ? (src.version || '').split('\n')[0] + ' · ' + t('built by Compile') : t('this build is no longer there');
    else if (f.from === 'image') {
      const k = (this.imageCaps || {})[this.imageRef()];
      fromNote = !k || k.asking ? t('reading what the image has ...')
        : k.version ? k.version.split('\n')[0] + ' · ' + t('here')
        : t('not here: pulled at the start - what it has is known then');
    }
    $('rn-from-note').textContent = fromNote;

    //
    // Runs: natively or in a container - which one follows from the source
    //
    this.seg('rn-where', [
      ['native', t('Natively'), f.from === 'image' ? t('an image runs in a container') : ''],
      ['container', t('In a container'), f.from === 'image' ? '' : f.from === 'build' ? (src && src.image ? (cont ? '' : noCont) : t('this build has no image - build it with Output: Binary and Docker image'))
        : t('the installed broker runs natively - a published image runs in a container')],
    ], f.where, (v) => { f.where = v; this.changed(); });

    //
    // Store and history
    //
    const noPlugin = (kind, name) => (this.can(kind, name) ? '' : t('this broker has no {kind} plugin {name}', { kind, name }));
    const mongoWhy = !this.has('MONGOC') ? t('this broker is built without mongoc') : noPlugin('db', 'mongoc') || (!cont ? noCont : '');
    const ramWhy = !this.plugins() ? t('this broker does not list its plugins (an older coraine): ramDB not known') : noPlugin('db', 'ramDB');
    this.seg('rn-store', [['corDB', 'corDB', noPlugin('db', 'corDB')], ['ramDB', 'ramDB', ramWhy], ['mongoc', 'mongoc', mongoWhy]], f.store,
      (v) => { f.store = v; f.dbDir = v === 'corDB'; this.changed(); });

    //
    // corDB's directory: native - the one chosen, else c³'s own <run>/<name>/data; a container - its volume
    //
    const cordb = f.store === 'corDB';
    const native = f.where !== 'container';
    $('rn-dbpath-row').hidden = !cordb || !native;
    $('rn-dbpath').placeholder = ((this.state && this.state.dir) || '~/.local/share/c3/run') + '/' + (f.name || 'coraine') + '/data';
    if (document.activeElement !== $('rn-dbpath')) $('rn-dbpath').value = f.dbPath || '';
    $('rn-dbpath-note').textContent = !cordb ? (f.store === 'ramDB' ? t('in memory only: gone when the broker stops') : '')
      : !native ? t('in the volume {volume}', { volume: 'c3-broker-' + (f.name || 'coraine') })
      : f.dbPath ? t('a directory of your own: Forget never deletes it') : t('empty: c³\'s own directory, the one greyed in the field');

    this.seg('rn-history', [['none', t('none'), ''], ['corDB', 'corDB', noPlugin('troe', 'corDB')],
      ['timescale', 'timescale', noPlugin('troe', 'timescale') || (cont ? '' : noCont)]], f.history, (v) => { f.history = v; this.changed(); });

    //
    // Ports
    //
    if (document.activeElement !== $('rn-port')) $('rn-port').value = f.port || '';
    if (document.activeElement !== $('rn-hport')) $('rn-hport').value = f.healthPort || '';
    if (document.activeElement !== $('rn-grace')) $('rn-grace').value = f.grace || '';
    $('rn-hport').disabled = !this.has('HEALTH');
    if (!this.has('HEALTH')) { f.healthPort = 0; $('rn-hport').value = ''; $('rn-hport').placeholder = t('built without {feature}', { feature: 'HEALTH' }); }
    else $('rn-hport').placeholder = t('none');

    //
    // Switches: what the broker has compiled in
    //
    $('rn-plugins').replaceChildren(...PLUGINS.map(([key, label, feature, flag, plugin]) => {
      const lacks = plugin && !this.can(plugin[0], plugin[1]);
      const off = (feature && !this.has(feature)) || lacks;
      const l = el('label', 'rn-check' + (off ? ' off' : ''));
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !off && !!f[key];
      c.disabled = !!off;
      c.addEventListener('change', () => { f[key] = c.checked; this.changed(false); });
      l.append(c, document.createTextNode(t(label) + ' '), el('span', 'mono cp-note', flag));
      if (off) { l.title = lacks ? t('this broker has no {kind} plugin {name}', { kind: plugin[0], name: plugin[1] }) : t('built without {feature}', { feature }); f[key] = false; }
      return l;
    }));

    //
    // Bridges: every bridge c³ knows - those the source lacks greyed, with the reason
    //
    const have = this.bridges();
    const all = [...new Set([...BRIDGES, ...have])].sort();
    $('rn-bridges').replaceChildren(...all.map((name) => {
      const l = el('label', 'rn-check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = f.bridges.includes(name);
      if (!have.includes(name)) { c.disabled = true; l.classList.add('off'); l.title = t('this broker has no {name} bridge', { name }); }
      c.addEventListener('change', () => {
        f.bridges = c.checked ? [...f.bridges, name] : f.bridges.filter((x) => x !== name);
        this.changed();
      });
      l.append(c, document.createTextNode(name));
      if (name === 'mqtt' && !cont && !f.bridgeConfig) { l.append(el('span', 'why', ' ' + t('its Mosquitto needs containers'))); }
      return l;
    }));

    //
    // CKAN, OPC UA, AAS and the mappers: shown only with their bridge ticked
    //
    const ticked = (b) => f.bridges.includes(b);
    $('rn-ckan-drop').parentElement.hidden = !ticked('ckan');
    $('rn-opcua-drop').parentElement.hidden = !ticked('opcua');
    $('rn-aas-drop').parentElement.hidden = !ticked('aas');
    for (const id of ['rn-dds-map', 'rn-dds-note']) $(id).hidden = !ticked('dds');
    for (const id of ['rn-opcua-map', 'rn-opcua-note']) $(id).hidden = !ticked('opcua');
    $('rn-aas-map').hidden = !ticked('aas');
    this.renderOptions();
    this.renderCkan(cont);
    this.renderOpcua();
    this.aas.render();
    this.renderDds();
    this.renderOpcuaMap();
    if ($('rn-args').value !== f.args) $('rn-args').value = f.args;

    this.renderName();
    this.commandSoon();
  }

  //
  // renderCkan - the CKAN datasets c3 knows (data/ckan.json), ticked into the broker's bridge configuration
  //
  renderCkan(cont) {
    const f = this.f;
    if (this.ckanSets === undefined) {
      this.ckanSets = null;
      fetch('data/ckan.json').then((r) => r.json()).then((j) => { this.ckanSets = j.datasets || []; this.renderCkan(cont); })
        .catch(() => { this.ckanSets = []; this.renderCkan(cont); });
    }
    const sets = this.ckanSets || [];
    const why = !this.bridgeOk('ckan') ? t('this broker has no {name} bridge', { name: 'ckan' })
      : (f.bridgeConfig ? t('not with a bridge configuration file of one\'s own') : '');
    $('rn-ckan').replaceChildren(...sets.map((ds) => {
      const l = el('label', 'rn-check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = f.ckan.includes(ds.id);
      c.disabled = !!why;
      c.addEventListener('change', () => {
        f.ckan = c.checked ? [...f.ckan, ds.id] : f.ckan.filter((x) => x !== ds.id);
        this.changed();
      });
      l.title = t('{portal} - resource {resource}', { portal: ds.portal, resource: ds.resource });
      l.append(c, document.createTextNode(ds.label + (ds.rows ? ' (' + ds.rows + ')' : '')));
      return l;
    }));
    const n = f.ckan.length;
    $('rn-ckan-sum').textContent = why ? why : (n ? plural(n, '{n} dataset: {list}', '{n} datasets: {list}', {
      list: f.ckan.map((id) => (sets.find((d) => d.id === id) || { label: id }).label.replace(/^.* - /, '')).join(', ') }) : t('none'));
  }

  //
  // renderOpcua - the OPC UA server's fields, and the line that sums them up
  //
  renderOpcua() {
    const o = this.f.opcua;
    const cont = !this.bridgeOk('opcua');                  // a broker without the opcua bridge
    const set = (id, v) => { if ($(id).value !== v) $(id).value = v; };
    set('rn-ou-url', o.url); set('rn-ou-roots', o.roots); set('rn-ou-mode', o.mode); set('rn-ou-policy', o.policy);
    set('rn-ou-cert', o.certificate); set('rn-ou-key', o.privateKey); set('rn-ou-appuri', o.applicationUri);
    set('rn-ou-trust', o.trustList); set('rn-ou-user', o.username);
    $('rn-ou-trustany').checked = o.trustAny;
    if (!o.password) $('rn-ou-pw').value = '';
    $('rn-ou-pw').placeholder = o.passwordSet ? t('password - kept by c3; empty keeps it') : t('password');
    const secure = o.mode !== 'None';
    $('rn-ou-secure').hidden = !secure;
    $('rn-ou-policy').disabled = !secure;
    for (const id of ['rn-ou-url', 'rn-ou-roots', 'rn-ou-mode', 'rn-ou-user', 'rn-ou-pw', 'rn-ou-addch']) $(id).disabled = cont;
    this.renderChannels();
    this.renderBrowse();
    this.renderOpcuaSum();
  }

  // renderBrowse - the browse button: on for a running broker of the form's, with the bridge and the admin API
  renderBrowse() {
    const b = this.browseBroker();
    $('rn-ou-browse').disabled = !b.url && $('rn-ou-tree').hidden;
    $('rn-ou-browsewhy').textContent = b.why;
  }

  renderOpcuaSum() {
    const o = this.f.opcua;
    const cont = !this.bridgeOk('opcua');
    const secure = o.mode !== 'None';
    const roots = o.roots.split('\n').map((x) => x.trim()).filter(Boolean).length;
    const chans = o.channels.length;
    $('rn-opcua-sum').textContent = cont ? t('this broker has no {name} bridge', { name: 'opcua' })
      : (!o.url ? t('none') : o.url + ' - ' + (secure ? o.mode + ' ' + (o.policy || 'Basic256Sha256') : t('no security'))
        + ', ' + (o.username ? t('user {name}', { name: o.username }) : t('anonymous')) + ', ' + plural(roots, '{n} model', '{n} models')
        + ', ' + plural(chans, '{n} Channel', '{n} Channels'));
  }

  def(withSecret = false) {
    const f = this.f;
    const d = {
      name: f.name, set: f.set, from: f.from, where: f.where, store: f.store, dbDir: f.store === 'corDB',
      dbPath: f.store === 'corDB' && f.where !== 'container' ? f.dbPath : '',
      history: f.history, port: f.port, healthPort: f.healthPort || 0, grace: f.grace || 30,
      transports: f.ws ? ['ws'] : [], admin: !!f.admin, distributed: !!f.distributed, verbose: !!f.verbose, bridges: f.bridges,
      args: f.args, options: this.optionsArg(),
    };
    if (f.bridgeConfig) d.bridgeConfig = f.bridgeConfig;
    if (f.userContext) d.userContext = f.userContext;
    if (f.ckan.length) d.ckan = f.ckan;
    if (f.opcua.url) {
      const o = f.opcua;
      const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
      d.opcua = { url: o.url, roots: lines(o.roots), security: { mode: o.mode } };
      const chans = o.channels.filter((c) => c.node || c.entityId || c.entityType || c.attribute);
      if (chans.length) d.opcua.channels = chans.map((c) => ({ node: c.node, entityId: c.entityId, entityType: c.entityType, attribute: c.attribute }));
      if (o.mode !== 'None') {
        Object.assign(d.opcua.security, { certificate: o.certificate, privateKey: o.privateKey,
          applicationUri: o.applicationUri, trustList: lines(o.trustList), trustAny: o.trustAny });
        if (o.policy) d.opcua.security.policy = o.policy;
      }
      if (o.username) {
        d.opcua.user = { username: o.username };
        if (withSecret && o.password) d.opcua.user.password = o.password;      // on Start only - never in the command preview
      }
    }
    const aas = this.aas ? this.aas.toDef(withSecret) : undefined;        // the Authorization on Start only - never in the command preview
    if (aas) d.aas = aas;
    if (f.bridges.includes('dds') && !f.bridgeConfig) {
      const rows = f.dds.rows.filter((r) => r.name || r.entityId || r.entityType || r.attribute);
      const pick = (kind, key, extra) => rows.filter((r) => r.kind === kind).map((r) => {
        const o = { [key]: r.name, entityId: r.entityId, entityType: r.entityType, attribute: r.attribute };
        for (const k of extra) o[k] = r[k];
        return o;
      });
      d.dds = { domain: f.dds.domain || 0, topics: pick('topic', 'topic', []), services: pick('service', 'service', ['requestType', 'replyType']),
                actions: pick('action', 'action', ['type']) };
      if (f.dds.transport) d.dds.transport = f.dds.transport;
      if (f.dds.interfaces.length) d.dds.interfaces = [...f.dds.interfaces];
      if (f.dds.vocabulary) d.dds.vocabulary = f.dds.vocabulary;
    }
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
      this.renderNeed();
      this.renderOptions();
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

  //
  // renderNeed - the services the start brings up (POST /api/run/command); one whose volume is there and that
  // does not run: its data, and Delete data (press twice)
  //
  renderNeed() {
    const need = $('rn-need');
    const svcs = (this.plan && this.plan.services) || [];
    if (!svcs.length) { need.replaceChildren(el('div', '', t('none'))); return; }
    need.replaceChildren(...svcs.map((s) => {
      const row = el('div', 'rn-needrow');
      const line = el('div');
      line.append(document.createTextNode(t('first:') + ' '), el('span', 'mono', s.container), document.createTextNode(' - ' + t('{label}, {image}, on {address}', { label: s.label, image: s.image, address: '127.0.0.1:' + s.port })));
      row.append(line);
      const st = ((this.state && this.state.services) || []).find((x) => x.container === s.container);
      if (st && st.volumeExists) {
        const data = el('div', 'rn-needdata');
        data.append(el('span', 'mono', t('data in the volume {volume}', { volume: st.volume })));
        if (!['running', 'starting', 'stopping'].includes(st.state)) {
          const armed = this.armed === 'vol:' + st.volume;
          data.append(button(armed ? t('Delete {volume}? Sure', { volume: st.volume }) : t('Delete data'), armed ? 'armed' : '', () => this.deleteVolume(st.volume)));
        }
        row.append(data);
      }
      return row;
    }));
  }

  renderStartButton() {
    const k = this.kept(this.f.name);
    const runs = k && ['running', 'starting', 'stopping'].includes(k.state);
    const b = $('rn-start');
    b.disabled = !!this.problem || !!runs || (this.f.from === 'image' && !this.f.tag);
    b.title = runs ? t('{name} runs - stop it first', { name: k.name }) : (this.problem || '');
    b.textContent = runs ? t('{name} runs', { name: this.f.name }) : t('Start');
  }

  async start() {
    const d = this.def(true);
    this.f.opcua.password = '';                       // sent once: c3 keeps it, the page does not
    this.aas.started();
    $('rn-start').disabled = true;
    try {
      const b = await api.runStart(d);
      this.editing = null;
      if (this.ddsMap.box && !this.ddsMap.box.hidden) this.ddsMap.close();
      if (this.opcuaMap.box && !this.opcuaMap.box.hidden) this.opcuaMap.close();
      this.select('broker', b.name);
      this.nameTouched = false;
      this.portsChosen = false;
      this.stateText = '';
      await this.load();
      this.choosePorts();
      this.renderForm();
      return true;
    } catch (e) {
      $('rn-problem').textContent = e.message;
      setTimeout(() => this.renderStartButton(), 3000);
      return false;
    }
  }

  //
  // loadImages - the coraine images here and those published on quay.io, for step 1 (asked once a page load)
  //
  async loadImages() {
    if (this.images || this.imagesAsking) return;
    this.imagesAsking = true;
    this.imagesNote = t('asking quay.io for the published tags ...');
    this.renderImages();
    try {
      this.images = await api.runImages();
      const r = this.images;
      this.imagesNote = r.publishedError ? t('quay.io: {why}', { why: r.publishedError }) : '';
    } catch (e) {
      this.imagesNote = t('the tags could not be read: {why}', { why: e.message });
    }
    this.imagesAsking = false;
    this.renderImages();
  }

  // ------------------------------------------------------------------ Set up a broker, step 1: what runs

  //
  // pickRow - a choice of step 1: a button the size of a line - its name, a line about it, marks beside the name
  //
  pickRow(name, sub, marks, pressed, onPick) {
    const b = el('button', 'rn-pick');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!pressed));
    const head = el('span', 'pk-head');
    head.append(el('span', 'pk-name', name));
    for (const [text, cls, title] of marks) { const m = el('span', 'badge ' + (cls || ''), text); if (title) m.title = title; head.append(m); }
    b.append(head);
    if (sub) b.append(el('span', 'pk-sub', sub));
    b.addEventListener('click', onPick);
    return b;
  }

  renderPicks() {
    const f = this.f;
    //
    // Builds: Compile's, the newest first
    //
    const builds = [...this.builds()].sort((x, y) => String(y.ended || '').localeCompare(String(x.ended || '')));
    $('rn-p-builds').replaceChildren(...(builds.length ? builds.map((b, ix) => {
      const marks = [];
      if (ix === 0) marks.push([t('latest'), 'active']);
      if (b.image) marks.push([t('image'), '', t('a Docker image too: {image}', { image: b.image })]);
      const sub = [b.mode, b.ended ? b.ended.replace('T', ' ').slice(0, 16) : '', (b.version || '').split('\n')[0]].filter(Boolean).join(' · ');
      return this.pickRow(b.name, sub, marks, f.picked && f.from === 'build' && f.build === b.name, () => this.pick({ from: 'build', build: b.name }));
    }) : [el('span', 'cp-note', t('None yet - Compile makes them.'))]));

    //
    // Installed: the coraine in $PATH
    //
    const inst = this.sources && this.sources.installed;
    $('rn-p-installed').replaceChildren(inst
      ? this.pickRow(inst.path, (inst.version || '').split('\n')[0], [], f.picked && f.from === 'installed', () => this.pick({ from: 'installed' }))
      : el('span', 'cp-note', t('No coraine in $PATH.')));

    this.renderImages();
    this.renderEarlier();
  }

  //
  // renderImages - the coraine images here, then the published ones not here (the newest few - another tag by name)
  //
  renderImages() {
    const f = this.f;
    const cont = this.containers();
    $('rn-repo').textContent = this.repo() + ':';
    $('rn-tag').disabled = !cont;
    $('rn-tag-use').disabled = !cont || !$('rn-tag').value.trim();
    const box = $('rn-p-images');
    if (!cont) { box.replaceChildren(); return; }
    const rows = [];
    const r = this.images;
    if (r) {
      const local = new Set(r.local.map((x) => x.tag));
      const many = this.imagesAll ? Infinity : 4;
      for (const x of r.local.slice(0, many)) {
        rows.push(this.pickRow(x.tag, [t('here'), (x.created || '').slice(0, 16), x.size].filter(Boolean).join(' · '), [],
          f.picked && f.from === 'image' && f.tag === x.tag, () => this.pick({ from: 'image', tag: x.tag })));
      }
      const pub = r.published.filter((p) => !local.has(p.tag));
      for (const x of pub.slice(0, this.imagesAll ? 12 : 2)) {
        rows.push(this.pickRow(x.tag, ['quay.io', (x.modified || '').slice(5, 22)].filter(Boolean).join(' · '), [],
          f.picked && f.from === 'image' && f.tag === x.tag, () => this.pick({ from: 'image', tag: x.tag })));
      }
    }
    rows.push(el('span', 'cp-note rn-imgnote', this.imagesNote || ''));
    box.replaceChildren(...rows);
    const more = r ? r.local.length + Math.min(12, r.published.filter((p) => !r.local.some((x) => x.tag === p.tag)).length) : 0;
    const tog = $('rn-img-all');
    tog.hidden = more <= 6;
    tog.textContent = this.imagesAll ? '−' : '+';
    tog.title = this.imagesAll ? t('Fewer images') : t('All {n} images', { n: more });
    tog.setAttribute('aria-label', tog.title);
  }

  //
  // renderEarlier - the brokers c³ started before and that do not run: their settings fill step 2 (Start then
  // starts that broker with them); Forget drops one
  //
  renderEarlier() {
    const kept = ((this.state && this.state.brokers) || []).filter((b) => !this.listed(b) && b.state !== 'starting' && b.state !== 'stopping');
    $('rn-g-earlier').hidden = !kept.length;
    $('rn-p-earlier').replaceChildren(...kept.map((b) => {
      const d = b.def;
      const row = el('div', 'rn-pickrow');
      row.append(this.pickRow(b.name, [this.sourceLabel(d), d.where === 'container' ? t('in a container') : t('natively'), t('port {port}', { port: d.port })].join(' · '),
        [], this.editing === b.name, () => this.edit(b, 'pick')));
      const acts = el('div', 'racts');
      if (this.armed === 'forget:' + b.name) {
        acts.append(button(t('Forget, keep data'), 'armed', () => this.forget(b, false)));
        if ((b.dataDir && b.dataOwn !== false) || b.volume) acts.append(button(t('Forget and delete data'), 'armed', () => this.forget(b, true)));
        acts.append(closeX(t('Cancel - forget nothing'), () => this.disarm()));
      } else acts.append(button(t('Forget'), '', () => this.arm('forget:' + b.name)));
      row.append(acts);
      return row;
    }));
  }
}
