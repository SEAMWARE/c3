//
// opcuamap.js - the OPC UA mapper: Operate's left side given to the mapping of an OPC UA server's nodes to NGSI-LD
// entities, then the two files it makes and a broker started with them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The mapping screen: the server's address space (Discover, or an inventory.json), a tree from its Objects
// folder. A Variable mapped is a Channel - one attribute of an entity: its name, the entity's id and type (the
// type once for each entity, on any of its Variables), its value both ways. An Object mapped is a model - an
// AssetChannel: the Object and every Object in it an entity, their Variables attributes, their references
// Relationships, as the opcua bridge makes them. A Method is shown, not mapped. Done writes the OPC UA
// configuration (POST /api/run/opcua/files): the bridge configuration and the @context, in c³'s data directory -
// the files screen says where, and starts a broker with them, through the broker form.
//
// What was written is read back when the page opens (GET /api/run/opcua/files): mapping once is the usual case,
// the mapper opens on it.
//
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

// count - '1 Channel', '3 Channels'
function count(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

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

function input(value, placeholder, label, onInput) {
  const i = el('input', 'cp-input');
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  i.setAttribute('aria-label', label);
  i.addEventListener('input', () => onInput(i.value.trim()));
  return i;
}

function select(options, value, label, onChange) {
  const s = el('select', 'cp-input');
  s.setAttribute('aria-label', label);
  for (const [v, t] of options) {
    const o = el('option', '', t);
    o.value = v;
    o.selected = (value === v);
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// the ▸ of a line that opens: aria-expanded kept with it
function toggle(open, label, onClick) {
  const b = el('button', 'dm-tog', open ? '▾' : '▸');
  b.type = 'button';
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

//
// NGSI-LD names: an attribute's or a type's name may not hold these (TS 104-176 § 4.6.2), and an entity's own
// members are not attributes
//
const FORBIDDEN = /[\s<>"'=;()]/;
const RESERVED  = ['id', 'type', '@id', '@type', '@context', 'scope', 'createdAt', 'modifiedAt', 'deletedAt'];

// a TypeDefinition that says nothing of what the Object is: the proposals' type instead
const GENERIC = ['BaseObjectType', 'FolderType', ''];

const LAYOUTS = [['attributes', 'an attribute per Variable, named by its path'], ['subAttributes', 'a container one attribute, its Variables sub-attributes'],
                 ['value', 'a container one JsonProperty, its values as the server has them']];

//
// housekeeping - the server's own nodes, rarely worth mapping: namespace 0 - its Server object, aliases, locations
//
function housekeeping(n) {
  return !/^ns=/.test(n.id || '') || /^ns=0;/.test(n.id);
}

// clean - a BrowseName as the opcua bridge keeps it in a name: [A-Za-z0-9_], a space starting a new word
function words(name) {
  return String(name || '').split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean);
}

// camel - names joined in camel case, the first word lower-case (Hydraulics, Oil Temp: hydraulicsOilTemp)
function camel(names) {
  const ws = names.flatMap(words);
  return ws.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

// pct - a BrowseName in an entity id, as the bridge writes it: each byte outside [A-Za-z0-9._-] as %XX
function pct(t) {
  return [...new TextEncoder().encode(String(t))].map((b) => (b < 128 && /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
    ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
}

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

export class OpcuaMapper {
  constructor(run) {
    this.run     = run;           // the Run page: its form, its Start, the broker discovery is started from
    this.box     = null;          // the mapper's section in Operate's left side, built on first open
    this.server  = this.serverDefaults();
    this.vocab   = '';
    this.rows    = new Map();     // NodeId -> { kind: 'variable', node, attribute, entityId, entityType } | { kind: 'model', node, attributeLayout, channelDirection }
    this.inv     = null;          // the inventory: { url, complete, nodes, objects }
    this.index   = new Map();     // NodeId -> { n, path }: every node of the inventory, and the nodes above it
    this.files   = null;          // GET /api/run/opcua/files: { directory, bridgeConfig, userContext, mapping }
    this.openN   = new Set();     // the nodes open in the tree
    this.openEp  = new Set();     // the nodes whose fields are open
    this.house   = false;         // the server's own nodes shown
    this.propType = 'Machine';    // the entity type of the proposals, where an Object's TypeDefinition says nothing
    this.status  = '';
    this.screen  = 'map';         // 'map' | 'files'
    this.from    = '';            // 'compile' when opened from Compile: a way back to it
  }

  serverDefaults() {
    return { url: '', mode: 'None', policy: '', certificate: '', privateKey: '', applicationUri: '', trustList: '', trustAny: false,
             username: '', password: '', passwordSet: false };
  }

  // ------------------------------------------------------------------ the saved configuration

  async load() {
    try {
      this.files = await api.runOpcuaFiles();
    } catch (e) {
      this.files = null;
    }
    const m = this.files && this.files.mapping;
    if (!m) return;
    const sec = m.security || {}, u = m.user || {};
    this.server = { url: m.url || '', mode: sec.mode || 'None', policy: sec.policy || '', certificate: sec.certificate || '',
                    privateKey: sec.privateKey || '', applicationUri: sec.applicationUri || '', trustList: (sec.trustList || []).join('\n'),
                    trustAny: !!sec.trustAny, username: u.username || '', password: '', passwordSet: !!u.passwordSet };
    this.vocab = m.vocabulary || '';
    this.terms = m.terms || [];
    this.rows.clear();
    for (const c of m.channels || []) this.rows.set(c.node, { kind: 'variable', node: c.node, attribute: c.attribute || '', entityId: c.entityId || '', entityType: c.entityType || '' });
    for (const x of m.models || []) this.rows.set(x.node, { kind: 'model', node: x.node, attributeLayout: x.attributeLayout || 'attributes', channelDirection: x.channelDirection || 'in' });
  }

  // note - the line under the form's button
  note(on) {
    const m = this.files && this.files.mapping;
    if (!m) return on ? 'nothing mapped yet - the mapper reads the server\'s address space and writes the opcua bridge\'s configuration' : '';
    const n = (k) => (m[k] || []).length;
    return 'the OPC UA configuration: ' + m.url + ' - ' + count(n('channels'), 'Channel', 'Channels') + ', ' + count(n('models'), 'model', 'models')
      + ' - ' + this.files.bridgeConfig;
  }

  // ------------------------------------------------------------------ open, close

  build() {
    const main = document.querySelector('#page-run .cp-main');
    this.box = el('section', 'dm om');
    this.box.setAttribute('aria-label', 'OPC UA mapping');
    this.box.hidden = true;
    main.append(this.box);
    this.onKey = (e) => { if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) this.close(); };
  }

  open(from) {
    this.from = from || '';
    if (!this.box) this.build();
    if (!this.server.url && this.run.f.opcua && this.run.f.opcua.url) {     // the form's server, the first time
      const o = this.run.f.opcua;
      Object.assign(this.server, { url: o.url, mode: o.mode || 'None', policy: o.policy || '', certificate: o.certificate || '',
                                   privateKey: o.privateKey || '', applicationUri: o.applicationUri || '', trustList: o.trustList || '',
                                   trustAny: !!o.trustAny, username: o.username || '' });
    }
    const main = this.box.parentElement;
    for (const c of main.children) if (c !== this.box) { c.dataset.omHidden = c.hidden ? '1' : ''; c.hidden = true; }
    this.box.hidden = false;
    this.show('map');
    document.addEventListener('keydown', this.onKey);
  }

  close() {
    if (!this.box || this.box.hidden) return;
    const main = this.box.parentElement;
    for (const c of main.children) if (c !== this.box) { c.hidden = c.dataset.omHidden === '1'; delete c.dataset.omHidden; }
    this.box.hidden = true;
    document.removeEventListener('keydown', this.onKey);
    this.run.renderOpcuaMap();
    $('rn-opcua-map').focus();
  }

  // closeButtons - the × of a screen, and, opened from Compile, the way back to it
  closeButtons() {
    const out = [];
    if (this.from === 'compile') out.push(button('← Back to Compile', 'small dm-back', () => { this.close(); location.hash = '#compile'; }));
    const close = button('×', 'dm-close', () => this.close());
    close.title = 'back to the brokers';
    close.setAttribute('aria-label', 'close the OPC UA mapping');
    out.push(close);
    return out;
  }

  // show - a screen, from its top
  show(screen) {
    this.screen = screen;
    this.render();
    const page = this.box.closest('.page');
    page.scrollTop = 0;
    requestAnimationFrame(() => { page.scrollTop = 0; });   // after the layout: the button pressed, gone, had the page scrolled to it
  }

  render() {
    this.box.replaceChildren(...(this.screen === 'files' ? this.filesScreen() : this.mapScreen()));
  }

  // ------------------------------------------------------------------ discovery

  // security - the server's SecureChannel and user, as the API takes them
  security() {
    const s = this.server;
    const sec = { mode: s.mode || 'None' };
    if (sec.mode !== 'None') {
      Object.assign(sec, { certificate: s.certificate, privateKey: s.privateKey, applicationUri: s.applicationUri,
                           trustList: lines(s.trustList), trustAny: !!s.trustAny });
      if (s.policy) sec.policy = s.policy;
    }
    return sec;
  }

  user() {
    const s = this.server;
    if (!s.username) return null;
    const u = { username: s.username };
    if (s.password) u.password = s.password;
    return u;
  }

  async discover(btn) {
    btn.disabled = true;
    this.status = 'discovering - a broker of c³\'s own connects to ' + (this.server.url || 'the server') + ' and reads its address space ...';
    this.renderStatus();
    try {
      const def = this.run.def();
      def.opcua = { url: this.server.url, security: this.security(), roots: [], channels: [] };
      const u = this.user();
      if (u) def.opcua.user = u;
      def.dds = this.run.ddsDefaults();
      delete def.bridgeConfig;
      delete def.userContext;
      const inv = await api.runOpcuaDiscover(def);
      this.inventorySet(inv, this.server.url + ', discovered ' + new Date().toLocaleTimeString());
    } catch (e) {
      this.status = e.message;
    }
    btn.disabled = false;
    this.render();
  }

  async importFile(file) {
    if (!file) return;
    try {
      const inv = JSON.parse(await file.text());
      // c³'s discovery ({ objects }), or the bridge's inventory as the broker answers it (a node, its children)
      const root = inv.objects || (inv.node ? inv : null);
      if (!root || !Array.isArray(root.children)) throw new Error('not an inventory: no "objects", and not a node with "children"');
      this.inventorySet({ url: inv.url || '', complete: inv.complete, nodes: inv.nodes, objects: root },
        file.name + (inv.discoveredAt ? ', discovered ' + inv.discoveredAt : ''));
    } catch (e) {
      this.status = file.name + ': ' + e.message;
    }
    this.render();
  }

  inventorySet(inv, from) {
    this.inv = inv;
    this.index.clear();
    const walk = (n, path) => {
      if (n.id) this.index.set(n.id, { n, path });
      for (const c of n.children || []) walk(c, [...path, n]);
    };
    walk(inv.objects, []);
    let n = 0;
    for (const { n: x } of this.index.values()) if (!housekeeping(x)) n++;
    this.status = from + ' - ' + count(n, 'node', 'nodes') + (this.index.size > n ? ' (and ' + (this.index.size - n) + ' of the server\'s own)' : '')
      + (inv.complete === false ? '; the address space is larger than one discovery reads - what is shown is cut' : '');
    for (const c of inv.objects.children || []) if (!housekeeping(c)) this.openN.add(c.id);   // the application's top level, open
  }

  renderStatus() {
    const s = this.box.querySelector('.dm-status');
    if (s) s.textContent = this.status;
  }

  // ------------------------------------------------------------------ the mapping

  mapped(r) {
    if (!r) return false;
    return r.kind === 'model' || !!(r.attribute || r.entityId || r.entityType);
  }

  // objectAbove - the nearest Object above a node (its path), not the Objects folder; -1: none
  objectAbove(path) {
    let ix = path.length - 1;
    while (ix >= 0 && (path[ix].node !== 'object' || path[ix].id === 'i=85')) ix--;
    return ix;
  }

  // typeOf - an Object's entity type as proposed: its TypeDefinition's name, unless that says nothing
  typeOf(o) {
    const t = words(o.typeName).join('');
    return GENERIC.includes(o.typeName || '') || !t ? (this.propType || 'Machine') : t;
  }

  //
  // proposal - a Variable's attribute, entity id and type as proposed, named as an AssetChannel on its Objects
  // names them (coraine's asset-channels.md), so that both write the same entity: the entity is the nearest
  // Object above the Variable, its id the Objects' names from the top down (urn:ngsi-ld:<type>:Press17:Unit1),
  // the attribute the names from that Object down (Hydraulics, Pressure: hydraulicsPressure); the type none when
  // the entity has one already
  //
  proposal(n) {
    const at   = this.index.get(n.id);
    const path = at ? at.path : [];
    const ix   = this.objectAbove(path);
    const obj  = ix >= 0 ? path[ix] : null;
    const type = obj ? this.typeOf(obj) : (this.propType || 'Machine');
    const objs = path.slice(0, ix + 1).filter((p) => p.node === 'object' && p.id !== 'i=85' && !housekeeping(p) || p === obj);
    const id   = 'urn:ngsi-ld:' + type + ':' + (objs.length ? objs.map((o) => pct(o.name || o.id)).join(':') : pct(n.name || 'object'));
    const attribute = camel([...path.slice(ix + 1).filter((p) => p.id !== 'i=85').map((p) => p.name), n.name]) || 'value';
    const r    = this.rows.get(n.id);
    const has  = this.entityTypes().get((r && r.entityId) || id);
    return { attribute, entityId: id, entityType: has ? '' : type };
  }

  // row - a Variable's Channel, made on its first field
  row(n) {
    let r = this.rows.get(n.id);
    if (!r) {
      r = { kind: 'variable', node: n.id, attribute: this.proposal(n).attribute, entityId: '', entityType: '' };
      this.rows.set(n.id, r);
    }
    return r;
  }

  // accept - the proposal into a Variable's empty fields
  accept(n) {
    const p = this.proposal(n);
    const r = this.row(n);
    if (!r.attribute) r.attribute = p.attribute;
    if (!r.entityId)  r.entityId  = p.entityId;
    if (!r.entityType && !this.entityTypes().has(r.entityId)) r.entityType = p.entityType || this.propType || 'Machine';
  }

  // modelAdd - an Object's model: every Object in it an entity, read-only, its attributes named by their paths
  modelAdd(n) {
    if (!this.rows.has(n.id)) this.rows.set(n.id, { kind: 'model', node: n.id, attributeLayout: 'attributes', channelDirection: 'in' });
  }

  // entityTypes - each entity id's type: the first given on one of its Variables
  entityTypes() {
    const t = new Map();
    for (const r of this.rows.values()) if (r.kind === 'variable' && r.entityId && r.entityType && !t.has(r.entityId)) t.set(r.entityId, r.entityType);
    return t;
  }

  // modelOver - the model a node is in (the NodeId of the Object mapped above it); null: none
  modelOver(id) {
    const at = this.index.get(id);
    if (!at) return null;
    for (let ix = at.path.length - 1; ix >= 0; ix--) {
      const r = this.rows.get(at.path[ix].id);
      if (r && r.kind === 'model') return at.path[ix].id;
    }
    return null;
  }

  //
  // modelMakes - what a model makes, as the bridge makes it with entities "natural": an entity per Object (a
  // folder's content goes into the entity above it), named by its TypeDefinition; per Variable an attribute
  // named by its path from its entity (attributes), a container's name (subAttributes, value) - the container's
  // Variables then sub-attributes; per part that is an entity a Relationship named by its BrowseName, per other
  // reference one named by the reference type
  //
  modelMakes(root, layout) {
    const entities = [], types = new Set(), attrs = new Set();
    const walk = (n, names, inEntity) => {
      const entity = n.node === 'object';
      if (entity) {
        entities.push(n);
        types.add(words(n.typeName).join('') || 'BaseObjectType');
        if (n !== root) attrs.add(camel([...names, n.name]));      // the part's Relationship, from the entity above
        if ((n.semanticIds || []).length) attrs.add('semanticId');
        for (const ref of n.references || []) attrs.add(camel([ref.type]));
      }
      for (const c of n.children || []) {
        if (c.node === 'variable') {
          if (layout === 'attributes' || (entity && !names.length)) attrs.add(camel([...(entity ? [] : names), c.name]));
          else attrs.add(camel([names[0]]));
          if (layout === 'subAttributes' && names.length) attrs.add(camel([c.name]));
        } else if (c.node === 'folder' || c.node === 'object') {
          walk(c, c.node === 'object' ? [] : (entity ? [c.name] : [...names, c.name]), entity || inEntity);
        }
      }
    };
    walk(root, [], true);
    attrs.delete('');
    return { entities, types, attrs };
  }

  //
  // problems - per node (its NodeId) what Done would refuse; 'server' - what the server's fields lack
  //
  problems() {
    const per = new Map();
    const add = (k, t) => { if (!per.has(k)) per.set(k, []); per.get(k).push(t); };
    const types = this.entityTypes();
    const attrs = new Map();       // entityId + '\n' + attribute -> the first Variable with it

    for (const [k, r] of this.rows) {
      if (r.kind === 'model') {
        const over = this.modelOver(k);
        if (over) add(k, 'inside the model of ' + ((this.index.get(over) || {}).n || {}).name + ' already - the bridge would read it twice');
        continue;
      }
      if (!this.mapped(r)) continue;
      if (!r.attribute) add(k, 'no attribute name');
      else if (FORBIDDEN.test(r.attribute)) add(k, 'the attribute name has a character NGSI-LD forbids in a name (space < > " \' = ; ( ))');
      else if (RESERVED.includes(r.attribute)) add(k, '"' + r.attribute + '" is a member of every entity, not an attribute name');
      if (!r.entityId) add(k, 'no entity id');
      else if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(r.entityId)) add(k, 'the entity id is not a URI (urn:ngsi-ld:Tank:T1)');
      else if (!types.has(r.entityId)) add(k, 'the entity ' + r.entityId + ' has no type - give it one here, or on another of its Variables');
      if (r.entityType && FORBIDDEN.test(r.entityType)) add(k, 'the entity type has a character NGSI-LD forbids in a name');
      if (r.entityType && types.get(r.entityId) && r.entityType !== types.get(r.entityId)) add(k, 'another Variable gives ' + r.entityId + ' the type ' + types.get(r.entityId));
      if (r.attribute && r.entityId) {
        const a = r.entityId + '\n' + r.attribute;
        if (attrs.has(a)) add(k, r.entityId + ' has the attribute ' + r.attribute + ' already, from ' + attrs.get(a));
        else attrs.set(a, ((this.index.get(k) || {}).n || {}).name || k);
      }
    }

    const s = this.server;
    if (!s.url) add('server', 'the server\'s URL');
    else if (!/^opc\.tcp:\/\/\S+$/.test(s.url)) add('server', 'the URL is opc.tcp://<host>:<port>');
    if (s.mode !== 'None') {
      if (!s.certificate || !s.privateKey || !s.applicationUri) add('server', s.mode + ' needs the client\'s certificate, its private key and the application URI the certificate names');
      if (!lines(s.trustList).length && !s.trustAny) add('server', s.mode + ' needs the server certificates to trust - or "trust any"');
    }
    if (s.username && !s.password && !s.passwordSet) add('server', 'the user ' + s.username + ' has no password: give it once, c³ keeps it');
    if (!s.username && s.password) add('server', 'a password needs its username');
    return per;
  }

  // ------------------------------------------------------------------ the mapping screen

  // the server, its SecureChannel and its user - what the bridge connects with, written into its configuration
  reachRow(problems) {
    const s = this.server;
    const box = el('div', 'dm-reach');
    const lab = (text, ctl) => { const l = el('label', 'dm-plabel'); l.append(el('span', '', text), ctl); return l; };
    const changed = () => { this.refresh(); };

    const row = el('div', 'dm-row');
    const url = input(s.url, 'opc.tcp://host:4840', 'OPC UA server URL', (v) => { s.url = v; changed(); });
    url.classList.add('om-url');
    const mode = select([['None', 'no security (None)'], ['Sign', 'Sign'], ['SignAndEncrypt', 'SignAndEncrypt']], s.mode, 'Security mode',
      (v) => { s.mode = v; this.render(); });
    row.append(el('span', 'dm-reachtitle', 'How c³ reaches your OPC UA server'), lab('server', url), lab('security', mode));
    box.append(row);

    if (s.mode !== 'None') {
      const sec = el('div', 'om-sec');
      const pol = select([['', 'Basic256Sha256'], ['Aes128_Sha256_RsaOaep', 'Aes128_Sha256_RsaOaep'], ['Aes256_Sha256_RsaPss', 'Aes256_Sha256_RsaPss']],
        s.policy, 'Security policy', (v) => { s.policy = v; changed(); });
      const f = (label, key, ph) => {
        const l = el('label', 'dm-field');
        const i = input(s[key], ph, label, (v) => { s[key] = v; changed(); });
        l.append(el('span', 'dm-flabel', label), i);
        return l;
      };
      const pl = el('label', 'dm-field');
      pl.append(el('span', 'dm-flabel', 'Policy'), pol);
      const tr = el('textarea', 'cp-input om-trust');
      tr.rows = 2;
      tr.value = s.trustList;
      tr.placeholder = 'the server certificates to trust - a file a line';
      tr.spellcheck = false;
      tr.setAttribute('aria-label', 'Trusted server certificates');
      tr.addEventListener('input', () => { s.trustList = tr.value; changed(); });
      const tl = el('label', 'dm-field');
      tl.append(el('span', 'dm-flabel', 'Trust'), tr);
      const any = el('label', 'rn-check om-any');
      const ac = el('input');
      ac.type = 'checkbox';
      ac.checked = s.trustAny;
      ac.addEventListener('change', () => { s.trustAny = ac.checked; changed(); });
      any.append(ac, document.createTextNode(' trust any server certificate - cannot tell the server meant from one that pretends to be it'));
      sec.append(pl, f('Certificate', 'certificate', 'the client\'s certificate - a file (DER or PEM)'), f('Private key', 'privateKey', 'its private key - a file'),
        f('Application URI', 'applicationUri', 'the URI the certificate names (urn:...)'), tl, any);
      box.append(sec);
    }

    const urow = el('div', 'dm-row');
    const user = input(s.username, 'empty: anonymous', 'OPC UA username', (v) => { s.username = v; changed(); });
    user.classList.add('om-user');
    const pw = input('', s.passwordSet ? 'kept by c³ - empty keeps it' : 'password', 'OPC UA password', (v) => { s.password = v; changed(); });
    pw.type = 'password';
    pw.autocomplete = 'new-password';
    pw.value = s.password;
    pw.classList.add('om-user');
    urow.append(lab('user', user), lab('password', pw));
    box.append(urow);

    box.append(el('p', 'cp-note', 'The bridge is an OPC UA client of one server. c³ keeps the password in its data directory, readable by you only, '
      + 'and the bridge configuration names that file - the password is in no file you share. Discover needs a native broker with the opcua bridge: '
      + 'an installed coraine or a build - the image has none. The broker Done starts connects the same way.'));
    box.append(el('div', 'dm-probs', (problems.get('server') || []).join(' · ')));
    return box;
  }

  mapScreen() {
    const out = [];
    const problems = this.problems();

    const head = el('div', 'cp-card dm-head');
    const top = el('div', 'dm-top');
    top.append(el('h2', 'section', 'Map an OPC UA server'), ...this.closeButtons());
    head.append(top, el('p', 'cp-note', 'A Variable mapped is one attribute of an entity - its name, the entity\'s id, and the entity\'s type, once for '
      + 'each entity, on any of its Variables - its value both ways: a write of the attribute writes the Variable. An Object mapped is a model: '
      + 'the Object and every Object in it entities, their Variables attributes, their references Relationships. Done writes the OPC UA '
      + 'configuration, two files, and a broker starts with them.'));

    head.append(this.reachRow(problems));

    const row = el('div', 'dm-row');
    const voc = input(this.vocab, 'vocabulary - the terms\' namespace (https://example.org/plant/); empty: the default context\'s', 'Vocabulary',
      (v) => { this.vocab = v; });
    voc.classList.add('dm-vocab');
    const pt = input(this.propType, 'Machine', 'Entity type of the proposals', (v) => { this.propType = v; this.refresh(); });
    pt.classList.add('dm-ptype');
    pt.title = 'the entity type the proposals give an Object whose TypeDefinition says nothing (BaseObjectType)';
    const ptl = el('label', 'dm-plabel');
    ptl.append(el('span', '', 'proposals\' type'), pt);
    const disc = button('Discover', 'primary', () => this.discover(disc));
    disc.disabled = !this.server.url;
    disc.title = this.server.url ? '' : 'the server\'s URL first';
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; this.importFile(f); });
    const imp = button('Import inventory.json', '', () => file.click());
    row.append(voc, ptl, disc, imp, file);
    const st = el('div', 'dm-row');
    const house = el('label', 'rn-check');
    const hc = el('input');
    hc.type = 'checkbox';
    hc.checked = this.house;
    hc.addEventListener('change', () => { this.house = hc.checked; this.render(); });
    house.title = 'namespace 0: the Server object, its diagnostics and sessions, aliases, locations';
    house.append(hc, document.createTextNode(' show the server\'s own nodes'));
    st.append(el('span', 'dm-status', this.status || (this.inv ? '' : 'Discover reads the server\'s address space - or import an inventory.json')), house);
    head.append(row, st);
    out.push(head);

    const types = this.entityTypes();
    const ids = [...new Set([...this.rows.values()].map((r) => r.entityId).filter(Boolean))];
    const listIds = el('datalist');
    listIds.id = 'om-ids';
    for (const id of ids) listIds.append(new Option(id));
    const listTypes = el('datalist');
    listTypes.id = 'om-types';
    for (const t of new Set(types.values())) listTypes.append(new Option(t));

    const card = el('div', 'cp-card dm-groups om-tree');
    card.append(listIds, listTypes);
    const ghead = el('div', 'dm-ghead');
    const nVar = [...this.rows.values()].filter((r) => r.kind === 'variable' && this.mapped(r)).length;
    const nMod = [...this.rows.values()].filter((r) => r.kind === 'model').length;
    ghead.append(el('span', 'dm-gtitle', 'The server\'s Objects'),
      el('span', 'dm-gcount', [nVar ? count(nVar, 'Variable', 'Variables') : '', nMod ? count(nMod, 'model', 'models') : ''].filter(Boolean).join(', ')
        + (nVar || nMod ? ' mapped' : '')));
    card.append(ghead);
    if (!this.inv) card.append(el('div', 'dm-empty', 'nothing discovered yet'));
    else {
      const kids = (this.inv.objects.children || []).filter((c) => this.house || !housekeeping(c) || this.mappedBelow(c));
      if (!kids.length) card.append(el('div', 'dm-empty', 'no Objects' + (this.house ? '' : ' but the server\'s own')));
      for (const c of kids) card.append(this.nodeLine(c, problems, 0));
    }
    out.push(card);

    // mapped, and not in the last discovery
    const gone = [...this.rows.values()].filter((r) => this.mapped(r) && !this.index.has(r.node));
    if (gone.length) {
      const g = el('div', 'cp-card dm-groups');
      g.append(el('div', 'dm-ghead', ''));
      g.firstChild.append(el('span', 'dm-gtitle', count(gone.length, 'node', 'nodes') + ' mapped' + (this.inv ? ', not in the last discovery' : ' - Discover, or import an inventory.json, to see them in the tree')));
      for (const r of gone) g.append(this.goneLine(r, problems.get(r.node) || []));
      out.push(g);
    }

    // Done
    const foot = el('div', 'cp-card dm-foot');
    const mapped = [...this.rows.values()].filter((r) => this.mapped(r));
    const nProblems = [...problems.values()].reduce((n, l) => n + l.length, 0);
    const ents = new Set(mapped.filter((r) => r.kind === 'variable').map((r) => r.entityId).filter(Boolean));
    const sum = el('span', 'dm-sum', mapped.length
      ? count(nVar, 'Channel', 'Channels') + ' (' + count(ents.size, 'entity', 'entities') + '), ' + count(nMod, 'model', 'models')
        + (nProblems ? ' - ' + nProblems + ' to fix first' : '')
      : 'nothing mapped yet');
    const done = button('Done', 'primary dm-done', () => this.done(done));
    done.disabled = !mapped.length || nProblems > 0;
    foot.append(sum, el('span', 'dm-err'), done);
    out.push(foot);
    return out;
  }

  // mappedBelow - how many nodes under a node are mapped
  mappedBelow(n) {
    let k = 0;
    for (const c of n.children || []) k += (this.mapped(this.rows.get(c.id)) ? 1 : 0) + this.mappedBelow(c);
    return k;
  }

  // variablesBelow - the Variables under a node not mapped, and not in a model - each a Channel the proposal makes
  variablesBelow(n) {
    const out = [];
    const walk = (x) => {
      for (const c of x.children || []) {
        const r = this.rows.get(c.id);
        if (r && r.kind === 'model') continue;
        if (c.node === 'variable' && !this.mapped(r)) out.push(c);
        walk(c);
      }
    };
    walk(n);
    return out;
  }

  //
  // nodeLine - a node of the tree: its ▸ opens what it contains; its name opens its fields - a Variable's
  // Channel, an Object's model
  //
  nodeLine(n, problems, depth) {
    const k = n.id;
    const r = this.rows.get(k);
    const probs = problems.get(k) || [];
    const kids = (n.children || []).filter((c) => this.house || !housekeeping(c) || this.mapped(this.rows.get(c.id)) || this.mappedBelow(c));
    const open = this.openN.has(k);
    const fieldsOpen = this.openEp.has(k);
    const inModel = this.modelOver(k);
    const node = el('div', 'dm-ep om-node om-' + n.node + (this.mapped(r) ? ' mapped' : '') + (probs.length ? ' bad' : '') + (inModel ? ' inmodel' : ''));
    const head = el('div', 'dm-ephead');

    if (kids.length) head.append(toggle(open, (open ? 'close ' : 'open ') + n.name, () => { if (open) this.openN.delete(k); else this.openN.add(k); this.render(); }));
    else head.append(el('span', 'om-leaf', n.hasChildren ? '·' : ''));

    const name = el('span', 'dm-name', n.name || n.id);
    const mappable = (n.node === 'variable' || n.node === 'object') && !inModel;
    if (mappable) {
      name.classList.add('om-click');
      name.setAttribute('role', 'button');
      name.tabIndex = 0;
      name.setAttribute('aria-expanded', String(fieldsOpen));
      const flip = () => { if (fieldsOpen) this.openEp.delete(k); else this.openEp.add(k); this.render(); };
      name.addEventListener('click', flip);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    }
    head.append(name, el('span', 'dm-type', this.meta(n)));

    const chip = el('span', 'dm-chip');
    head.append(chip);
    if (inModel && n.node !== 'method') {
      chip.textContent = 'in the model of ' + ((this.index.get(inModel) || {}).n || {}).name;
      chip.classList.add('prop');
    } else if (n.node === 'variable') {
      const complete = r && r.attribute && r.entityId && (r.entityType || this.entityTypes().has(r.entityId));
      if (this.mapped(r)) chip.textContent = (r.attribute || '?') + ' of ' + (r.entityId || '?');
      if (!complete) {
        const p = this.proposal(n);
        if (!this.mapped(r)) { chip.textContent = p.attribute + ' of ' + p.entityId; chip.classList.add('prop'); }
        const ok = button('✓', 'dm-ok', () => { this.accept(n); this.render(); });
        ok.title = 'accept the proposal' + (this.mapped(r) ? ' for the empty fields' : ': ' + p.attribute + ' of ' + p.entityId);
        ok.setAttribute('aria-label', 'accept the proposal for ' + n.name);
        head.append(ok);
      }
    } else if (n.node === 'object') {
      const made = this.modelMakes(n, (r && r.attributeLayout) || 'attributes');
      const what = 'a model: ' + count(made.entities.length, 'entity', 'entities') + ', ' + count(made.attrs.size, 'attribute', 'attributes');
      chip.textContent = what;
      if (!r) {
        chip.classList.add('prop');
        const ok = button('✓', 'dm-ok', () => { this.modelAdd(n); this.render(); });
        ok.title = 'map it as a model: ' + what + ' - every Object in it an entity';
        ok.setAttribute('aria-label', 'map ' + n.name + ' as a model');
        head.append(ok);
      }
    } else if (n.node === 'method') {
      chip.textContent = 'a method - not mapped here';
      chip.classList.add('prop');
      chip.title = 'a method is a service of its entity: a Service Registration whose endpoint is opcua://<the Object\'s NodeId>/<the method\'s> - made by hand (the opcua bridge\'s README)';
    }
    node.append(head);

    if (fieldsOpen && mappable) node.append(...this.fields(n, r, probs));
    else if (probs.length) node.append(el('div', 'dm-probs', probs.join(' · ')));

    if (open && kids.length) {
      const box = el('div', 'om-kids');
      for (const c of kids) box.append(this.nodeLine(c, problems, depth + 1));
      node.append(box);
    }
    return node;
  }

  // meta - what a node is, after its name: a Variable's DataType, unit and access; an Object's type
  meta(n) {
    if (n.node === 'variable') return [n.dataType, n.unit, n.writable ? 'writable' : 'read-only'].filter(Boolean).join(' · ');
    if (n.node === 'object') return n.typeName || 'Object';
    if (n.node === 'folder') return 'folder';
    return n.node || '';
  }

  // fields - a Variable's Channel, or an Object's model
  fields(n, r, probs) {
    const out = [];
    const k = n.id;
    const tools = el('div', 'dm-eptools');

    if (n.node === 'variable') {
      const fields = el('div', 'dm-fields');
      const types = this.entityTypes();
      const prop = this.proposal(n);
      const f = (label, key, ph, list, hint) => {
        const l = el('label', 'dm-field');
        const i = input(r ? r[key] : '', ph, label + ' of ' + n.name, (v) => {
          const row = this.row(n);
          row[key] = v;
          this.refresh();
        });
        if (list) i.setAttribute('list', list);
        l.append(el('span', 'dm-flabel', label), i);
        if (hint) l.append(el('span', 'dm-fhint', hint));
        return l;
      };
      const inherited = r && r.entityId && !r.entityType && types.get(r.entityId);
      fields.append(
        f('Attribute name', 'attribute', prop.attribute || 'value', null, n.writable ? 'a write of the attribute writes the Variable - it is writable' : 'the server does not let it be written: read-only'),
        f('Entity ID', 'entityId', (r && r.entityId) ? '' : prop.entityId, 'om-ids'),
        f('Entity type', 'entityType', inherited || prop.entityType || this.propType, 'om-types', inherited ? 'optional - ' + r.entityId + ' is a ' + inherited : 'optional, if another Variable of the entity gives it'));
      out.push(fields);
      if (n.value !== undefined) {
        const pre = el('pre', 'dm-sample', JSON.stringify(n.value, null, 2) + (n.sourceTime ? '\n' + n.sourceTime : ''));
        pre.hidden = true;
        const b = button('its value', 'small', () => { pre.hidden = !pre.hidden; });
        b.title = 'the value the server had when it was discovered - the attribute\'s value, its SourceTimestamp the attribute\'s observedAt';
        tools.append(b);
        out.push(tools, pre);
      }
      if (this.mapped(r)) tools.append(button('not mapped', 'small', () => { this.rows.delete(k); this.render(); }));
    } else {
      const fields = el('div', 'dm-fields');
      const cur = r || { attributeLayout: 'attributes', channelDirection: 'in' };
      const set = (key, v) => { this.modelAdd(n); this.rows.get(k)[key] = v; this.render(); };
      const lay = select(LAYOUTS.map(([v, t]) => [v, v + ' - ' + t]), cur.attributeLayout, 'Attribute layout of ' + n.name, (v) => set('attributeLayout', v));
      const ll = el('label', 'dm-field');
      ll.append(el('span', 'dm-flabel', 'Containers'), lay, el('span', 'dm-fhint', 'what a folder, or an Object no entity, becomes in the entity above it'));
      const dir = select([['in', 'read-only - values in'], ['both', 'both - a write of an attribute writes its Variable']], cur.channelDirection,
        'Direction of ' + n.name, (v) => set('channelDirection', v));
      const dl = el('label', 'dm-field');
      dl.append(el('span', 'dm-flabel', 'Direction'), dir);
      fields.append(ll, dl);
      out.push(fields);
      const made = this.modelMakes(n, cur.attributeLayout);
      const pre = el('pre', 'dm-sample', made.entities.map((e) => this.typeOf(e) === this.propType && GENERIC.includes(e.typeName || '')
        ? (e.typeName || 'BaseObjectType') + '  ' + e.name : (e.typeName || '') + '  ' + e.name).join('\n')
        + '\n\nattributes: ' + [...made.attrs].join(', '));
      pre.hidden = true;
      const b = button('what it makes', 'small', () => { pre.hidden = !pre.hidden; });
      b.title = 'the entities - each Object, its type its TypeDefinition\'s name - and the attributes, as the bridge names them';
      tools.append(b);
      if (!r) tools.append(button('map it as a model', 'small', () => { this.modelAdd(n); this.render(); }));
      const vs = this.variablesBelow(n);
      if (!r && vs.length) {
        const all = button('✓ its Variables (' + vs.length + ')', 'small dm-all', () => { for (const v of vs) this.accept(v); this.render(); });
        all.title = 'each Variable in it a Channel, as proposed - instead of the model; each name stays editable';
        tools.append(all);
      }
      if (r) tools.append(button('not mapped', 'small', () => { this.rows.delete(k); this.render(); }));
      out.push(tools, pre);
    }
    out.push(el('div', 'dm-probs', probs.join(' · ')));
    return out;
  }

  // goneLine - a node mapped that the last discovery did not have: its mapping, and a way to drop it
  goneLine(r, probs) {
    const node = el('div', 'dm-ep mapped' + (probs.length ? ' bad' : ''));
    const head = el('div', 'dm-ephead');
    head.append(el('span', 'dm-name', r.node), el('span', 'dm-type', this.inv ? 'not in the last discovery' : 'not discovered yet'),
      el('span', 'dm-chip', r.kind === 'model' ? 'a model' : (r.attribute || '?') + ' of ' + (r.entityId || '?')));
    head.append(button('not mapped', 'small', () => { this.rows.delete(r.node); this.render(); }));
    node.append(head, el('div', 'dm-probs', probs.join(' · ')));
    return node;
  }

  //
  // refresh - after a keystroke in a field, a moment later: the screen again, the focus and the caret where they
  // were
  //
  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const focus = document.activeElement;
      const label = focus && focus.getAttribute('aria-label');
      const pos = focus && focus.selectionStart;
      this.render();
      if (label) {
        const again = [...this.box.querySelectorAll('input, textarea')].find((i) => i.getAttribute('aria-label') === label);
        if (again) { again.focus(); if (pos !== null && pos !== undefined) again.setSelectionRange(pos, pos); }
      }
    }, 250);
  }

  // ------------------------------------------------------------------ Done: the files

  body() {
    const types = this.entityTypes();
    const b = { url: this.server.url, security: this.security(), vocabulary: this.vocab, channels: [], models: [], terms: [] };
    const u = this.user();
    if (u) b.user = u;
    const terms = new Set();
    for (const r of this.rows.values()) {
      if (!this.mapped(r)) continue;
      if (r.kind === 'variable') {
        b.channels.push({ node: r.node, entityId: r.entityId, entityType: r.entityType || types.get(r.entityId), attribute: r.attribute });
        continue;
      }
      b.models.push({ node: r.node, attributeLayout: r.attributeLayout, channelDirection: r.channelDirection });
      const at = this.index.get(r.node);
      if (at) {
        const made = this.modelMakes(at.n, r.attributeLayout);
        for (const t of [...made.types, ...made.attrs]) terms.add(t);
      } else for (const t of this.terms || []) terms.add(t);          // not discovered this time: the terms written before
    }
    b.terms = [...terms].filter((t) => t && !FORBIDDEN.test(t));
    if (!b.vocabulary) delete b.vocabulary;
    return b;
  }

  async done(btn) {
    btn.disabled = true;
    try {
      this.files = await api.runOpcuaFilesWrite(this.body());
      this.server.password = '';                     // sent once: c³ keeps it, the page does not
      this.server.passwordSet = !!this.server.username;
      this.terms = (this.files.mapping || {}).terms || [];
      this.show('files');
      this.run.renderOpcuaMap();
    } catch (e) {
      this.box.querySelector('.dm-err').textContent = e.message;
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ the files screen

  filesScreen() {
    const f = this.files;
    const m = f.mapping || {};
    const n = (k) => (m[k] || []).length;
    const ents = new Set((m.channels || []).map((x) => x.entityId));
    const sec = m.security || {};
    const out = [];

    const head = el('div', 'cp-card dm-head');
    const top = el('div', 'dm-top');
    top.append(el('h2', 'section', 'The OPC UA configuration is written'), ...this.closeButtons());
    head.append(top, el('p', 'cp-note', count(n('channels'), 'Channel', 'Channels') + ' (attributes of ' + count(ents.size, 'entity', 'entities') + ') and '
      + count(n('models'), 'model', 'models') + ' - ' + m.url + ', ' + (sec.mode && sec.mode !== 'None' ? sec.mode + ' ' + (sec.policy || 'Basic256Sha256') : 'no security')
      + ((m.user || {}).username ? ', user ' + m.user.username : ', anonymous') + '. Two files, in ' + f.directory + ':'));

    const fileCard = (title, path, what, flag) => {
      const c = el('div', 'dm-file');
      const p = el('code', 'dm-path', path);
      const copy = button('Copy', 'small', async () => {
        try { await navigator.clipboard.writeText(path); copy.textContent = 'Copied'; } catch (e) { copy.textContent = 'select it and copy'; }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
      const line = el('div', 'dm-fileline');
      line.append(p, copy);
      c.append(el('div', 'dm-filetitle', title), line, el('div', 'cp-note', what + ' - ' + flag));
      return c;
    };
    head.append(
      fileCard('The bridge configuration', f.bridgeConfig, 'the server the opcua bridge connects to, its Channels and its models'
        + ((m.user || {}).username ? ' - the password not in it: it names the file c³ keeps it in, in the same directory' : ''), '--bridgeConfig'),
      fileCard('The @context', f.userContext, 'each entity type and attribute a term of ' + (m.vocabulary || 'the default context\'s namespace')
        + ', so clients use the short names', '--defaultUserContext'));
    out.push(head);

    // a broker with them
    const start = el('div', 'cp-card dm-start');
    start.append(el('h2', 'section', 'Start a broker with it'));
    start.append(el('p', 'cp-note', 'The broker of the form on the right - its name, port, store and source - with the opcua bridge and the two files. '
      + 'A native broker: the image has no opcua bridge. More options are added as typed.'));
    const cmd = el('pre', 'cp-cmd dm-cmd');
    const more = input(this.run.f.args || '', '--memoryLimit 512', 'More options for the broker', () => show());
    more.classList.add('dm-more');
    const show = () => {
      cmd.textContent = 'coraine --bridges opcua \\\n  --bridgeConfig ' + f.bridgeConfig + ' \\\n  --defaultUserContext ' + f.userContext
        + (more.value.trim() ? ' \\\n  ' + more.value.trim() : '');
    };
    show();
    const ml = el('label', 'dm-field');
    ml.append(el('span', 'dm-flabel', 'More options'), more);
    const go = button('Start the broker', 'primary dm-go', () => this.startBroker(more.value.trim(), go));
    const fill = button('Put it in the broker form', '', () => { this.applyToForm(more.value.trim()); this.close(); });
    fill.title = 'the form on the right gets the opcua bridge, the two files and the options - to change more before Start';
    const btns = el('div', 'dm-row');
    btns.append(go, fill, el('span', 'dm-err'));
    start.append(cmd, ml, btns);
    out.push(start);

    const back = el('div', 'dm-row');
    back.append(button('Edit the mapping', '', () => this.show('map')), button('Close', '', () => this.close()));
    if (this.from === 'compile') back.append(button('← Back to Compile', '', () => { this.close(); location.hash = '#compile'; }));
    out.push(back);
    return out;
  }

  applyToForm(args) {
    const f = this.run.f;
    if (!f.bridges.includes('opcua')) f.bridges = [...f.bridges, 'opcua'];
    f.bridgeConfig = this.files.bridgeConfig;
    f.userContext  = this.files.userContext;
    f.opcua        = this.run.opcuaDefaults();         // the server and the mapping are in the file, not in the broker's definition
    f.where        = 'native';                         // the image has no opcua bridge
    f.args         = args;
    this.run.renderForm();
  }

  async startBroker(args, btn) {
    btn.disabled = true;
    this.applyToForm(args);
    if (!await this.run.start()) {
      this.box.querySelector('.dm-start .dm-err').textContent = $('rn-problem').textContent;
      btn.disabled = false;
      return;
    }
    this.close();
  }
}
