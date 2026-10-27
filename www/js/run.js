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
import { Metrics } from './metrics.js';
import { DdsMapper } from './ddsmap.js';

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
  ['distributed', 'distributed operations', 'REGISTRATIONS', '--distributed'],
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
    this.metrics = new Metrics();

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
    // DDS - the dds bridge's domain and mapping, in the bridge configuration c3 writes
    //
    $('rn-dds-domain').addEventListener('input', () => { this.f.dds.domain = parseInt($('rn-dds-domain').value, 10) || 0; this.renderDdsSum(); this.changed(false); });
    $('rn-dds-vocab').addEventListener('input', () => { this.f.dds.vocabulary = $('rn-dds-vocab').value.trim(); this.renderDdsSum(); this.changed(false); });
    $('rn-dds-type').addEventListener('input', () => { this.ddsType = $('rn-dds-type').value.trim(); });
    $('rn-dds-house').addEventListener('change', () => this.renderDdsInventory());
    $('rn-dds-discover').addEventListener('click', () => this.ddsDiscover());
    $('rn-dds-import').addEventListener('click', () => $('rn-dds-file').click());
    $('rn-dds-file').addEventListener('change', () => this.ddsImport());
    this.ddsMap = new DdsMapper(this);
    $('rn-dds-map').addEventListener('click', () => this.ddsMap.open());
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
    const cont = this.f.where === 'container';
    box.replaceChildren();
    o.channels.forEach((c, ix) => {
      const card = el('div', 'rn-ouch');
      for (const [key, label, ph] of [['node', 'Variable (NodeId)', 'ns=2;s=Tank1.Level'], ['entityId', 'entity id', 'urn:ngsi-ld:Tank:T1'],
                                      ['entityType', 'entity type', 'Tank'], ['attribute', 'attribute', 'level']]) {
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
      del.title = 'remove this Channel';
      del.setAttribute('aria-label', 'remove Channel ' + (ix + 1));
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
    if (this.f.where === 'container') return { url: null, why: '' };
    if (!this.f.opcua.url) return { url: null, why: 'Browsing asks a running broker: give the server, start the broker, then browse.' };
    if (!k || k.state !== 'running') return { url: null, why: 'Browsing asks the running broker\'s bridge: start ' + (this.f.name || 'the broker') + ', then browse - and stop and start it again for what you pick.' };
    if (!k.def.admin) return { url: null, why: 'Browsing needs the admin API in the broker (Switches).' };
    return { url: 'http://localhost:' + k.def.port, why: 'The server as ' + k.name + '\'s bridge sees it. What you pick takes effect when the broker is started again.' };
  }

  async browseToggle() {
    const tree = $('rn-ou-tree');
    if (!tree.hidden) { tree.hidden = true; $('rn-ou-browse').textContent = 'Browse the server'; return; }
    const b = this.browseBroker();
    if (!b.url) return;
    tree.hidden = false;
    $('rn-ou-browse').textContent = 'Close the browser';
    tree.replaceChildren(el('div', 'cp-note', 'asking the server ...'));
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
    return { error: r.status === 404 && !from ? 'the broker has no opcua bridge loaded - ' + why : why };
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
      const info = [n.dataType, n.writable ? 'writable' : 'read-only', n.unit].filter(Boolean).join(', ');
      row.append(el('span', 'rn-ouval', JSON.stringify(n.value)), el('span', 'rn-oukind', info));
      const added = this.f.opcua.channels.some((c) => c.node === n.id);
      const b = button(added ? 'a Channel' : '+ Channel', '', () => { this.channelAdd(this.channelFor(here)); b.textContent = 'a Channel'; b.disabled = true; });
      b.disabled = added || !n.id;
      row.append(b);
    } else if (n.node === 'object' && n.id && n.id !== 'i=85') {
      const roots = () => this.f.opcua.roots.split('\n').map((x) => x.trim()).filter(Boolean);
      const b = button(roots().includes(n.id) ? 'a model root' : '+ model root', '', () => {
        if (!roots().includes(n.id)) this.f.opcua.roots = [...roots(), n.id].join('\n');
        b.textContent = 'a model root'; b.disabled = true;
        this.renderOpcua(); this.changed(false);
      });
      b.disabled = roots().includes(n.id);
      b.title = 'the Object and everything in it as entities (an AssetChannel)';
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
  // %XX; the attribute the names from the Object down, the first one lower-case, only [A-Za-z0-9_] kept
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
    const attribute = names.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('') || 'value';
    return { node: v.id, entityId: 'urn:ngsi-ld:' + type + ':' + pct(idPart), entityType: type, attribute };
  }

  opcuaDefaults() {
    return { url: '', roots: '', mode: 'None', policy: '', certificate: '', privateKey: '', applicationUri: '',
             trustList: '', trustAny: false, username: '', password: '', passwordSet: false, channels: [] };
  }

  // ------------------------------------------------------------------ DDS: the mapping

  ddsDefaults() {
    return { domain: 0, vocabulary: '', rows: [] };
  }

  //
  // ddsDiscover - what the form's DDS domain announces: the backend starts a broker of its own on it, asks its
  // dds bridge once (it answers when discovery has gone quiet) and stops it again
  //
  async ddsDiscover() {
    const btn = $('rn-dds-discover');
    btn.disabled = true;
    $('rn-dds-why').textContent = 'discovering - a broker of its own on domain ' + this.f.dds.domain + ', for a few seconds ...';
    try {
      const inv = await api.runDdsDiscover(this.def());
      this.ddsInventorySet(inv, 'domain ' + this.f.dds.domain + ', discovered ' + new Date().toLocaleTimeString());
    } catch (e) {
      $('rn-dds-why').textContent = e.message;
    }
    btn.disabled = false;
    this.ddsMap.refresh();
  }

  //
  // ddsImport - an inventory.json a DDS discovery tool wrote (dds-discovery -o inventory.json): the same shape
  //
  async ddsImport() {
    const file = $('rn-dds-file').files[0];
    $('rn-dds-file').value = '';
    if (!file) return;
    try {
      const inv = JSON.parse(await file.text());
      if (!Array.isArray(inv.topics) && !Array.isArray(inv.services) && !Array.isArray(inv.actions)) throw new Error('not an inventory: no "topics", "services" or "actions"');
      this.ddsInventorySet(inv, file.name + (inv.discoveredAt ? ', discovered ' + inv.discoveredAt : ''));
    } catch (e) {
      $('rn-dds-why').textContent = file.name + ': ' + e.message;
      this.ddsMap.refresh();
    }
  }

  ddsInventorySet(inv, from) {
    this.ddsInv = { topics: inv.topics || [], services: inv.services || [], actions: inv.actions || [], types: inv.types || {} };
    const n = this.ddsInv.topics.length + this.ddsInv.services.length + this.ddsInv.actions.length;
    $('rn-dds-why').textContent = from + ' - ' + n + ' endpoint' + (n === 1 ? '' : 's')
      + (inv.settled === false ? '; the domain was still announcing more when it answered - Discover again for the rest' : '');
    $('rn-dds-inv').hidden = false;
    this.renderDdsInventory();
    this.renderDdsRows();
    this.ddsMap.refresh();
  }

  //
  // ddsHousekeeping - what ROS 2 itself has on every domain, rarely worth mapping: its discovery and log topics,
  // and every node's parameter services
  //
  ddsHousekeeping(kind, name) {
    if (kind === 'topic') return ['ros_discovery_info', 'rt/parameter_events', 'rt/rosout'].includes(name);
    return kind === 'service' && /(^|\/)(describe_parameters|get_parameter_types|get_parameters|get_type_description|list_parameters|set_parameters|set_parameters_atomically)$/.test(name);
  }

  //
  // ddsRowFor - a new row for an endpoint: the entity from the name's segments (rt/ dropped) but the last, the
  // attribute the last one camelCased; the entity type the form's (Robot)
  //
  ddsRowFor(kind, e) {
    const segs = e.name.replace(/^rt\//, '').split('/').filter(Boolean);
    const last = segs.pop() || e.name;
    const camel = (t) => t.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
    const type = this.ddsType || 'Robot';
    const id = segs.length ? segs.join('-').replace(/[^A-Za-z0-9._-]/g, '') : 'robot1';
    const row = { kind, name: e.name, entityId: 'urn:ngsi-ld:' + type + ':' + id, entityType: type, attribute: camel(last) || 'value' };
    if (kind === 'service') Object.assign(row, { requestType: (e.request || {}).type || '', replyType: (e.reply || {}).type || '' });
    if (kind === 'action') row.type = (((e.goal || {}).request || {}).type || '').replace(/_SendGoal_Request_$/, '');
    return row;
  }

  ddsTypeOf(kind, e) {
    if (kind === 'topic') return e.type || '';
    if (kind === 'service') return ((e.request || {}).type || '').replace(/_Request_$/, '');
    return (((e.goal || {}).request || {}).type || '').replace(/_SendGoal_Request_$/, '');
  }

  //
  // renderDdsInventory - what was announced, housekeeping hidden unless asked for: each one mapped with a
  // click, its type's fields (the sample the bridge gave) a click away
  //
  renderDdsInventory() {
    const box = $('rn-dds-list');
    const inv = this.ddsInv;
    box.replaceChildren();
    if (!inv) return;
    const house = $('rn-dds-house').checked;
    for (const [kind, list, label] of [['topic', inv.topics, 'Topics'], ['service', inv.services, 'Services'], ['action', inv.actions, 'Actions']]) {
      const shown = list.filter((e) => house || !this.ddsHousekeeping(kind, e.name));
      if (!shown.length) continue;
      box.append(el('div', 'rn-oukind', label + ' (' + shown.length + ')'));
      for (const e of shown) {
        const node = el('div', 'rn-ounode');
        const row = el('div', 'rn-ourow');
        const type = this.ddsTypeOf(kind, e);
        const sampleOf = kind === 'topic' ? e.type : kind === 'service' ? (e.request || {}).type : ((e.goal || {}).request || {}).type;
        const t = inv.types[sampleOf];
        const tog = el('button', 'rn-outog', t && t.sample ? '▸' : '');
        tog.type = 'button';
        tog.disabled = !(t && t.sample);
        tog.title = 'its fields';
        const mapped = this.f.dds.rows.some((r) => r.kind === kind && r.name === e.name);
        const b = button(mapped ? 'mapped' : '+ map', '', () => {
          this.f.dds.rows.push(this.ddsRowFor(kind, e));
          b.textContent = 'mapped'; b.disabled = true;
          this.renderDdsRows(); this.renderDdsSum(); this.changed(false);
        });
        b.disabled = mapped;
        row.append(tog, el('b', '', e.name), el('span', 'rn-ouid', type), b);
        const fields = el('pre', 'rn-ddssample');
        fields.hidden = true;
        if (t && t.sample) fields.textContent = JSON.stringify(t.sample, null, 2);
        tog.addEventListener('click', () => { fields.hidden = !fields.hidden; tog.textContent = fields.hidden ? '▸' : '▾'; });
        node.append(row, fields);
        box.append(node);
      }
    }
    if (!box.children.length) box.append(el('div', 'cp-note', 'nothing announced' + (house ? '' : ' but ROS 2 housekeeping')));
  }

  //
  // renderDdsRows - the mapping, each row editable: the endpoint, the entity's id and type, the attribute; a
  // service's or an action's types as discovered. A row the last discovery did not see says so
  //
  renderDdsRows() {
    const box = $('rn-dds-rows');
    const rows = this.f.dds.rows;
    const inv = this.ddsInv;
    box.replaceChildren();
    rows.forEach((r, ix) => {
      const card = el('div', 'rn-ouch');
      const seen = !inv || (inv[r.kind + 's'] || []).some((e) => e.name === r.name);
      for (const [key, label, ph, cls] of [['name', r.kind + (seen ? '' : ' - not in the last discovery'), 'rt/cmd_vel', 'node'],
                                           ['entityId', 'entity id', 'urn:ngsi-ld:Robot:robot1', 'entityId'],
                                           ['entityType', 'entity type', 'Robot', 'entityType'], ['attribute', 'attribute', 'velocity', 'attribute']]) {
        const f = el('label', 'rn-ouf rn-ouf-' + cls);
        const inp = el('input', 'cp-input');
        inp.value = r[key];
        inp.placeholder = ph;
        inp.spellcheck = false;
        inp.addEventListener('input', () => { r[key] = inp.value.trim(); this.renderDdsSum(); this.changed(false); });
        f.append(el('span', seen ? '' : 'why', label), inp);
        card.append(f);
      }
      if (r.kind === 'service') card.append(el('span', 'rn-ddstypes', r.requestType + ' -> ' + r.replyType));
      if (r.kind === 'action') card.append(el('span', 'rn-ddstypes', r.type));
      const del = button('×', 'rn-oudel', () => { rows.splice(ix, 1); this.renderDdsRows(); this.renderDdsInventory(); this.renderDdsSum(); this.changed(false); });
      del.title = 'remove this row';
      del.setAttribute('aria-label', 'remove row ' + (ix + 1));
      card.append(del);
      box.append(card);
    });
  }

  renderDds() {
    const on = this.f.bridges.includes('dds');
    const own = !!this.f.bridgeConfig;
    $('rn-dds-field').hidden = !on;
    if (!on) return;
    const set = (id, v) => { if ($(id).value !== v) $(id).value = v; };
    set('rn-dds-domain', String(this.f.dds.domain || 0));
    set('rn-dds-vocab', this.f.dds.vocabulary);
    for (const id of ['rn-dds-domain', 'rn-dds-vocab', 'rn-dds-discover', 'rn-dds-import', 'rn-dds-map']) $(id).disabled = own;
    this.renderDdsRows();
    this.renderDdsSum();
  }

  renderDdsSum() {
    const d = this.f.dds;
    const count = (k, word) => { const n = d.rows.filter((r) => r.kind === k).length; return n ? n + ' ' + word + (n === 1 ? '' : 's') : ''; };
    const mapped = [count('topic', 'topic'), count('service', 'service'), count('action', 'action')].filter(Boolean).join(', ');
    $('rn-dds-sum').textContent = this.f.bridgeConfig ? 'not with a bridge configuration file of one\'s own'
      : 'domain ' + (d.domain || 0) + ' - ' + (mapped || 'nothing mapped') + (d.vocabulary ? ', @context ' + d.vocabulary : '');
  }

  defaults() {
    return {
      name: '', set: 'cordb', from: 'installed', build: '', tag: '', where: 'native',
      store: 'corDB', dbDir: true, history: 'corDB', port: 1026, healthPort: 1027, grace: 30,
      ws: true, admin: true, distributed: true, verbose: true, bridges: [], bridgeConfig: '', ckan: [], args: '',
      opcua: this.opcuaDefaults(), dds: this.ddsDefaults(),
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
    this.metricsShow();
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
        this.renderBrowse();
        this.configShow(false);
        this.levelsShow(false);
        this.metricsShow();
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
    if (d.ckan && d.ckan.length) meta.push('CKAN ' + d.ckan.join(', '));
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
      acts.append(button('Explore', '', () => this.onConnect(b.url)));
      acts.append(button('Options', '', () => this.edit(b)));          // to see them - and browse its OPC UA server
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
      ws: (d.transports || []).includes('ws'), admin: d.admin, distributed: d.distributed !== false, verbose: d.verbose, bridges: [...(d.bridges || [])],
      bridgeConfig: d.bridgeConfig || '', ckan: [...(d.ckan || [])], args: d.args || '',
      opcua: this.opcuaDefaults(), dds: this.ddsDefaults(),
    };
    if (d.dds) {
      const row = (kind, key) => (x) => ({ ...x, kind, name: x[key] });
      Object.assign(this.f.dds, {
        domain: d.dds.domain || 0, vocabulary: d.dds.vocabulary || '',
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
    this.nameTouched = true;
    this.editing = d.name;
    this.portsChosen = true;
    this.renderForm();
    $('rn-form').scrollIntoView({ block: 'start' });
  }

  // ------------------------------------------------------------------ log and trace levels

  //
  // levelsBroker - the selected broker, when it runs with the admin API: its URL; null otherwise
  //
  levelsBroker() {
    const s = this.sel;
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
      body.append(el('div', 'rn-lvnote', [b.body.version, bd.type, bd.httpServer && 'HTTP server ' + bd.httpServer,
        bd.gitSha && 'git ' + String(bd.gitSha).slice(0, 8), bd.builtAt && 'built ' + bd.builtAt].filter(Boolean).join(' - ')));
      const feats = el('div', 'rn-cfgfeat');
      for (const [k, v] of Object.entries(b.body.features || {})) {
        const s = el('span', v ? 'on' : 'off', k);
        s.title = v ? 'compiled in' : 'compiled out - only another build brings it';
        feats.append(s);
      }
      body.append(feats);
      const loaded = (b.body.plugins && b.body.plugins.loaded) || {};
      const names = Object.entries(loaded).flatMap(([kind, v]) => (Array.isArray(v) ? v : [v]).filter(Boolean)
        .map((p) => kind + ' ' + (p.alias || p.name || '')));
      if (names.length) body.append(el('div', 'rn-lvnote', 'Plugins loaded: ' + names.join(', ')));
    } else {
      body.append(el('div', 'rn-lvnote warn', 'GET /build: ' + why(b)));
    }

    if (!c.ok || !c.body) {
      body.append(el('div', 'rn-lvnote warn', 'GET /admin/config: ' + why(c) + (c.status === 404 ? ' - a coraine older than /admin/config' : '')));
      $('rn-config-sum').textContent = 'Configuration and build';
      return;
    }
    const opts = c.body.options || [];
    const set = opts.filter((o) => o.from !== 'default');
    const tab = el('table', 'rn-cfgtab');
    const head = el('tr');
    for (const h of ['option', 'value', 'from', 'default']) head.append(el('th', '', h));
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
      n.title = (o.description || '') + (o.env ? '\nenvironment: ' + o.env : '') + (o.short ? '\nshort: ' + o.short : '');
      const v = el('td', 'v', show(o.value));
      if (o.secret) v.title = 'a secret - never shown';
      const resolved = o.from === 'default' && !o.secret && show(o.value) !== show(o.default);   // 0 = "the broker decides"
      const fromText = resolved ? 'default, resolved by the broker'
        : { default: '', env: 'environment', longOption: 'command line', shortOption: 'command line', configFile: 'config file' }[o.from] || o.from;
      tr.append(n, v, el('td', '', fromText), el('td', 'd', show(o.default)));
      tab.append(tr);
    }
    const wrap = el('div', 'rn-cfgwrap');
    wrap.append(tab);
    body.append(el('div', 'rn-lvnote', 'Read-only: ' + opts.length + ' options, ' + set.length + ' not at their default (bold). Hover an option for what it does.'), wrap);
    $('rn-config-sum').textContent = 'Configuration and build - ' + set.length + ' option' + (set.length === 1 ? '' : 's') + ' set';
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
      if (!url) $('rn-metrics-sum').textContent = 'Metrics';
      return;
    }
    const urls = () => ((this.state && this.state.brokers) || []).filter((b) => b.state === 'running' && b.def.admin)
      .map((b) => 'http://localhost:' + b.def.port);
    this.metrics.start(urls, () => this.metricsRender());
    this.metricsRender();
  }

  metricsRender() {
    const url = this.levelsBroker();
    if (!url || !$('rn-metrics').open) return;
    $('rn-metrics-body').replaceChildren(this.metrics.render(url));
    const sum = this.metrics.summary(url);
    $('rn-metrics-sum').textContent = 'Metrics' + (sum ? ' - ' + sum : '');
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
      if (!w.ok) $('rn-levels-body').prepend(el('div', 'rn-lvnote warn', 'PUT /admin/log: ' + ((w.body && (w.body.detail || w.body.title)) || 'HTTP ' + w.status)));
    };

    const flags = el('div', 'rn-lvflags');
    for (const [f, label, why] of [['verbose', 'verbose', 'the -v lines: what the broker does, request by request'],
                                   ['info', 'info', 'info lines']]) {
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

    if (traces === false) body.append(el('div', 'rn-lvnote warn', 'A release build: traces are compiled out - trace levels are kept and trace nothing. A debug build (Compile, mode Debug) traces.'));
    else if (traces === undefined) body.append(el('div', 'rn-lvnote', 'This broker does not say whether it has traces compiled in - only debug builds do.'));

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
    if (other.length) body.append(el('div', 'rn-lvnote', 'Also set, levels c3 has no name for: ' + rangesOf(other)));
    const n = on.size;
    $('rn-levels-sum').textContent = 'Log and trace levels - ' + ['verbose', 'info'].filter((f) => cur[f]).concat(n ? [n + ' trace level' + (n === 1 ? '' : 's')] : []).join(', ')
      .replace(/^$/, 'nothing extra');
  }

  // ------------------------------------------------------------------ the log

  select(kind, name) {
    this.sel = { kind, name };
    if (this.state) this.renderLists();
    this.configShow();
    this.levelsShow();
    this.metricsShow();
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
    let frag = document.createDocumentFragment();
    for (const line of text.split('\n')) {
      //
      // A start begins the broker's log again: only the latest attempt is shown - the earlier ones are
      // in the whole file (the link). Without this, every attempt added its lines under the last.
      //
      if (/^c3: \S+ start '/.test(line)) {
        pre.replaceChildren();
        frag = document.createDocumentFragment();
      }
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
    // Switches: what the broker has compiled in
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
    this.renderCkan(cont);
    this.renderOpcua();
    this.renderDds();
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
    const why = f.where === 'container' ? 'a native broker only: the image has no ckan bridge'
      : (f.bridgeConfig ? 'not with a bridge configuration file of one\'s own' : '');
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
      l.title = ds.portal + ' - resource ' + ds.resource;
      l.append(c, document.createTextNode(ds.label + (ds.rows ? ' (' + ds.rows + ')' : '')));
      return l;
    }));
    const n = f.ckan.length;
    $('rn-ckan-sum').textContent = why ? why : (n ? n + ' dataset' + (n > 1 ? 's' : '') + ': ' +
      f.ckan.map((id) => (sets.find((d) => d.id === id) || { label: id }).label.replace(/^.* - /, '')).join(', ') : 'none');
  }

  //
  // renderOpcua - the OPC UA server's fields, and the line that sums them up
  //
  renderOpcua() {
    const o = this.f.opcua;
    const cont = this.f.where === 'container';             // the image has no opcua bridge
    const set = (id, v) => { if ($(id).value !== v) $(id).value = v; };
    set('rn-ou-url', o.url); set('rn-ou-roots', o.roots); set('rn-ou-mode', o.mode); set('rn-ou-policy', o.policy);
    set('rn-ou-cert', o.certificate); set('rn-ou-key', o.privateKey); set('rn-ou-appuri', o.applicationUri);
    set('rn-ou-trust', o.trustList); set('rn-ou-user', o.username);
    $('rn-ou-trustany').checked = o.trustAny;
    if (!o.password) $('rn-ou-pw').value = '';
    $('rn-ou-pw').placeholder = o.passwordSet ? 'password - kept by c3; empty keeps it' : 'password';
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
    const cont = this.f.where === 'container';
    const secure = o.mode !== 'None';
    const roots = o.roots.split('\n').map((x) => x.trim()).filter(Boolean).length;
    const chans = o.channels.length;
    $('rn-opcua-sum').textContent = cont ? 'a native broker only: the image has no opcua bridge'
      : (!o.url ? 'none' : o.url + ' - ' + (secure ? o.mode + ' ' + (o.policy || 'Basic256Sha256') : 'no security')
        + (o.username ? ', user ' + o.username : ', anonymous') + ', ' + roots + ' model' + (roots === 1 ? '' : 's')
        + ', ' + chans + ' Channel' + (chans === 1 ? '' : 's'));
  }

  def(withSecret = false) {
    const f = this.f;
    const d = {
      name: f.name, set: f.set, from: f.from, where: f.where, store: f.store, dbDir: f.store === 'corDB' && f.dbDir,
      history: f.history, port: f.port, healthPort: f.healthPort || 0, grace: f.grace || 30,
      transports: f.ws ? ['ws'] : [], admin: !!f.admin, distributed: !!f.distributed, verbose: !!f.verbose, bridges: f.bridges,
      args: f.args,
    };
    if (f.bridgeConfig) d.bridgeConfig = f.bridgeConfig;
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
    if (f.bridges.includes('dds') && !f.bridgeConfig) {
      const rows = f.dds.rows.filter((r) => r.name || r.entityId || r.entityType || r.attribute);
      const pick = (kind, key, extra) => rows.filter((r) => r.kind === kind).map((r) => {
        const o = { [key]: r.name, entityId: r.entityId, entityType: r.entityType, attribute: r.attribute };
        for (const k of extra) o[k] = r[k];
        return o;
      });
      d.dds = { domain: f.dds.domain || 0, topics: pick('topic', 'topic', []), services: pick('service', 'service', ['requestType', 'replyType']),
                actions: pick('action', 'action', ['type']) };
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
    const d = this.def(true);
    this.f.opcua.password = '';                       // sent once: c3 keeps it, the page does not
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
