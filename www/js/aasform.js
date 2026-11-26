//
// aasform.js - the AAS part of Operate's broker form: an Asset Administration Shell server for the aas bridge (corAasBridge),
// and the shells (or submodels) it carries, each one an AssetChannel - its model a graph of entities in the broker
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The server: its URL, an AAS Registry asked first where a shell is, the MQTT broker it publishes its changes to (push),
// the CAs its certificate is verified against (or none verified), a client certificate (mutual TLS), and its
// credentials: none, an Authorization header, or an OAuth2 client (the client credentials grant). The secrets - the
// header's value, the client's secret - are sent once, kept by c3 in the broker's directory (0600) and handed to the
// broker in its environment, never in c3.json. An AssetChannel: the shell's or the submodel's id, which nodes become entities ("natural" - the shell and
// each submodel - or rules: a node kind, optionally its semanticId, and the entity type), what a collection that is no
// entity becomes (attributeLayout), whether a client's write goes to the server first (channelDirection both), and how
// often the model is read again (pollInterval).
//
// Discover (POST /api/run/aas/discover): a broker of c3's own, the aas bridge alone, reads the server - its shells and
// submodels and each one's model, whole - and stops. The models are shown as the bridge hands them to the broker
// (coraine doc/asset-channels.md § 3.3), with the entities each AssetChannel makes of them.
//
import * as api from './api.js';
import { t, plural } from './i18n.js';

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

function select(options, value, label, onChange) {
  const s = el('select', 'rn-select');
  s.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = v;
    o.selected = (value === v);
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function field(label, cls, value, placeholder, onInput) {
  const f = el('label', 'rn-ouf ' + cls);
  const i = el('input', 'cp-input');
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  i.addEventListener('input', () => onInput(i.value.trim()));
  f.append(el('span', '', label), i);
  return f;
}

// typeOf - an entity type as coraine's AssetMap makes one of a node in "natural": its typeName, else its kind capitalized
const typeOf = (n) => n.typeName || (n.node ? n.node.charAt(0).toUpperCase() + n.node.slice(1) : 'Entity');
const semOf  = (n) => (n.semanticIds && n.semanticIds[0]) || '';
const isIri  = (id) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(id || '');
// pct - a name in an entity id as coraine writes it: each byte outside [A-Za-z0-9._-] as %XX
const pct    = (s) => [...new TextEncoder().encode(String(s))].map((b) => (b < 128 && /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
  ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');

export class AasForm {
  constructor(run) {
    this.run = run;
    this.found = null;                     // the last discovery: { url, complete, shells, submodels, models, errors }
    this.status = '';
    this.open = new Set();                 // the ids of the models shown open

    const a = (id, key, ev, get) => $(id).addEventListener(ev, () => { this.f[key] = get($(id)); this.render(); this.run.changed(false); });
    a('rn-aas-url',      'url',         'input',  (e) => e.value.trim());
    a('rn-aas-registry', 'registry',    'input',  (e) => e.value.trim());
    a('rn-aas-push',     'push',        'input',  (e) => e.value.trim());
    a('rn-aas-cred',     'credentials', 'change', (e) => e.value);
    a('rn-aas-token',    'tokenUrl',    'input',  (e) => e.value.trim());
    a('rn-aas-client',   'clientId',    'input',  (e) => e.value.trim());
    a('rn-aas-scope',    'scope',       'input',  (e) => e.value.trim());
    a('rn-aas-cert',     'clientCert',  'input',  (e) => e.value.trim());
    a('rn-aas-key',      'clientKey',   'input',  (e) => e.value.trim());
    a('rn-aas-ca',       'caFile',      'input',  (e) => e.value.trim());
    a('rn-aas-insecure', 'insecure',    'change', (e) => e.checked);
    $('rn-aas-auth').addEventListener('input', () => { this.f.authorization = $('rn-aas-auth').value; this.renderSum(); });
    $('rn-aas-secret').addEventListener('input', () => { this.f.clientSecret = $('rn-aas-secret').value; this.renderSum(); });
    $('rn-aas-add').addEventListener('click', () => this.channelAdd(''));
    $('rn-aas-discover').addEventListener('click', () => this.discover());
  }

  get f() { return this.run.f.aas; }

  defaults() {
    return { url: '', registry: '', push: '', caFile: '', insecure: false, clientCert: '', clientKey: '', credentials: 'none',
             authorization: '', authorizationSet: false, tokenUrl: '', clientId: '', scope: '', clientSecret: '', clientSecretSet: false, channels: [] };
  }

  // fromDef - a kept broker's "aas" (the API's shape) as the form has it
  fromDef(a) {
    const f = this.defaults();
    if (!a) return f;
    return Object.assign(f, {
      url: a.url || '', registry: a.registry || '', push: a.push || '', caFile: a.caFile || '', insecure: !!a.insecure,
      clientCert: a.clientCert || '', clientKey: a.clientKey || '', authorizationSet: !!a.authorizationSet,
      // an older c3 has no credentials: the Authorization header, when it keeps one
      credentials: a.credentials || (a.authorizationSet ? 'authorization' : 'none'),
      tokenUrl: (a.oauth2 && a.oauth2.tokenUrl) || '', clientId: (a.oauth2 && a.oauth2.clientId) || '', scope: (a.oauth2 && a.oauth2.scope) || '',
      clientSecretSet: !!(a.oauth2 && a.oauth2.clientSecretSet),
      channels: (a.channels || []).map((c) => ({
        id: c.id || '', rules: Array.isArray(c.entities) ? c.entities.map((r) => ({ from: r.from, semanticId: r.semanticId || '', type: r.type })) : null,
        attributeLayout: c.attributeLayout || 'attributes', channelDirection: c.channelDirection || 'in', pollInterval: c.pollInterval || '',
      })),
    });
  }

  // toDef - the form's AAS as a broker's "aas"; undefined: no server. The secrets only with 'withSecret' (Start, Discover)
  toDef(withSecret) {
    const f = this.f;
    if (!f.url) return undefined;
    const d = { url: f.url, insecure: !!f.insecure, credentials: f.credentials };
    for (const k of ['registry', 'push', 'caFile', 'clientCert', 'clientKey']) if (f[k]) d[k] = f[k];
    if (f.credentials === 'authorization' && withSecret && f.authorization) d.authorization = f.authorization;
    if (f.credentials === 'oauth2') {
      d.oauth2 = { tokenUrl: f.tokenUrl, clientId: f.clientId };
      if (f.scope) d.oauth2.scope = f.scope;
      if (withSecret && f.clientSecret) d.oauth2.clientSecret = f.clientSecret;
    }
    d.channels = f.channels.filter((c) => c.id).map((c) => {
      const ch = { id: c.id, entities: c.rules ? c.rules.map((r) => (r.semanticId ? { from: r.from, semanticId: r.semanticId, type: r.type } : { from: r.from, type: r.type })) : 'natural',
                   attributeLayout: c.attributeLayout, channelDirection: c.channelDirection };
      if (c.pollInterval) ch.pollInterval = c.pollInterval;
      return ch;
    });
    return d;
  }

  // started - the secrets were sent: c3 keeps the one the credentials use (and drops the other), the page none
  started() {
    const f = this.f;
    if (f.credentials === 'authorization' && f.authorization) f.authorizationSet = true;
    if (f.credentials === 'oauth2' && f.clientSecret) f.clientSecretSet = true;
    if (f.credentials !== 'authorization') f.authorizationSet = false;
    if (f.credentials !== 'oauth2') f.clientSecretSet = false;
    f.authorization = '';
    f.clientSecret = '';
  }

  channelAdd(id) {
    if (id && this.f.channels.some((c) => c.id === id)) return;
    this.f.channels.push({ id, rules: null, attributeLayout: 'attributes', channelDirection: 'in', pollInterval: '' });
    this.render();
    this.run.changed(false);
  }

  channelOf(id) { return this.f.channels.find((c) => c.id === id); }

  // ------------------------------------------------------------------ the form

  render() {
    const f = this.f;
    const cont = !this.run.bridgeOk('aas');                // a broker without the aas bridge
    const native = this.run.f.where !== 'container';       // Discover runs a broker natively: a server on localhost is reached
    const set = (id, v) => { if ($(id).value !== v) $(id).value = v; };
    set('rn-aas-url', f.url); set('rn-aas-registry', f.registry); set('rn-aas-push', f.push); set('rn-aas-ca', f.caFile);
    set('rn-aas-cred', f.credentials); set('rn-aas-token', f.tokenUrl); set('rn-aas-client', f.clientId); set('rn-aas-scope', f.scope);
    set('rn-aas-cert', f.clientCert); set('rn-aas-key', f.clientKey);
    $('rn-aas-insecure').checked = f.insecure;
    if (!f.authorization) $('rn-aas-auth').value = '';
    if (!f.clientSecret) $('rn-aas-secret').value = '';
    $('rn-aas-auth').placeholder = f.authorizationSet ? t('Authorization header - kept by c3; empty keeps it') : t('Authorization header (Bearer ...)');
    $('rn-aas-secret').placeholder = f.clientSecretSet ? t('client secret - kept by c3; empty keeps it') : t('client secret');
    // the credentials' fields: both rows' room kept whatever is chosen - nothing below moves
    const oauth2 = f.credentials === 'oauth2';
    $('rn-aas-auth').hidden = oauth2;
    $('rn-aas-token').hidden = !oauth2;
    document.querySelector('.rn-aas-cred1').classList.toggle('rn-invisible', f.credentials === 'none');
    document.querySelector('.rn-aas-cred2').classList.toggle('rn-invisible', !oauth2);
    for (const id of ['rn-aas-url', 'rn-aas-registry', 'rn-aas-push', 'rn-aas-cred', 'rn-aas-auth', 'rn-aas-token', 'rn-aas-client', 'rn-aas-secret',
      'rn-aas-scope', 'rn-aas-cert', 'rn-aas-key', 'rn-aas-ca', 'rn-aas-insecure', 'rn-aas-add']) $(id).disabled = cont;
    $('rn-aas-discover').disabled = cont || !native || !f.url || this.busy;
    $('rn-aas-discover').title = cont ? t('this broker has no {name} bridge', { name: 'aas' }) : !native ? t('Discover runs the broker natively - choose Natively to discover')
      : (!f.url ? t('give the server\'s URL first') : '');
    this.renderChannels(cont);
    this.renderFound();
    this.renderSum();
  }

  renderSum() {
    const f = this.f;
    const cont = !this.run.bridgeOk('aas');
    const cred = f.credentials === 'oauth2' ? t('an OAuth2 client') : (f.credentials === 'authorization' && (f.authorization || f.authorizationSet))
      ? t('with an Authorization header') : t('no credentials');
    $('rn-aas-sum').textContent = cont ? t('this broker has no {name} bridge', { name: 'aas' })
      : (!f.url ? t('none') : f.url + ' - ' + cred + (f.clientCert ? ', ' + t('a client certificate') : '')
        + (f.insecure ? ', ' + t('certificate not verified') : '') + (f.registry ? ', ' + t('a registry') : '') + (f.push ? ', ' + t('change events') : '')
        + ', ' + plural(f.channels.length, '{n} AssetChannel', '{n} AssetChannels'));
  }

  //
  // renderChannels - an AssetChannel each: its id, and how its model becomes entities; the rules editable when it has them
  //
  renderChannels(cont) {
    const box = $('rn-aas-chans');
    box.replaceChildren();
    this.f.channels.forEach((c, ix) => {
      const card = el('div', 'rn-aasch');
      const head = el('div', 'rn-aashead');
      head.append(field(t('shell or submodel id'), 'rn-aasid', c.id, 'https://acme.example/ids/aas/press-17', (v) => { c.id = v; this.renderSum(); this.renderFound(); this.run.changed(false); }));
      const del = button('×', 'rn-aasbtn', () => { this.f.channels.splice(ix, 1); this.render(); this.run.changed(false); });
      del.title = t('remove this AssetChannel');
      del.setAttribute('aria-label', t('remove AssetChannel {n}', { n: ix + 1 }));
      head.append(del);
      card.append(head);

      const opts = el('div', 'rn-aasopts');
      opts.append(
        select([['natural', t('entities: the shell and each submodel')], ['rules', t('entities: by rules')]], c.rules ? 'rules' : 'natural', t('Which nodes become entities'),
          (v) => { c.rules = (v === 'rules') ? this.rulesFor(c.id) : null; this.render(); this.run.changed(false); }),
        select([['attributes', t('a collection: an attribute per element')], ['subAttributes', t('a collection: one attribute, its elements sub-attributes')],
                ['value', t('a collection: one JSON attribute')]], c.attributeLayout, t('What a collection that is no entity becomes'),
          (v) => { c.attributeLayout = v; this.renderFound(); this.run.changed(false); }),
        select([['in', t('read from the server')], ['both', t('read, and a client\'s write goes to the server')]], c.channelDirection, t('Direction'),
          (v) => { c.channelDirection = v; this.run.changed(false); }));
      const poll = el('input', 'cp-input rn-aaspoll');
      poll.value = c.pollInterval;
      poll.placeholder = t('read every PT10S');
      poll.spellcheck = false;
      poll.setAttribute('aria-label', t('How often the model is read again (ISO 8601 duration)'));
      poll.title = t('How often the model is read again - an ISO 8601 duration: PT2S, PT0.5S, PT1M. None: every 10 s');
      poll.addEventListener('input', () => { c.pollInterval = poll.value.trim(); this.run.changed(false); });
      opts.append(poll);
      card.append(opts);

      if (c.rules) card.append(this.rulesEditor(c));
      for (const e of card.querySelectorAll('input, select, button')) e.disabled = cont;
      box.append(card);
    });
  }

  //
  // rulesEditor - the rules, in order: the first one a node matches names its entity type; a node no rule names is no
  // entity - its content goes into the entity above it
  //
  rulesEditor(c) {
    const box = el('div', 'rn-aasrules');
    box.append(el('span', 'cp-note', t('The first rule a node matches makes it an entity of its type; a node no rule matches goes into the entity above it.')));
    c.rules.forEach((r, ix) => {
      const row = el('div', 'rn-aasrule');
      row.append(
        select([['shell', 'shell'], ['submodel', 'submodel'], ['collection', 'collection']], r.from, t('node kind'), (v) => { r.from = v; this.renderFound(); this.run.changed(false); }),
        field(t('semanticId'), 'rn-aassem', r.semanticId, t('any node of this kind'), (v) => { r.semanticId = v; this.renderFound(); this.run.changed(false); }),
        field(t('entity type'), 'rn-aastype', r.type, 'Nameplate', (v) => { r.type = v; this.renderFound(); this.run.changed(false); }));
      const up = button('↑', 'rn-aasbtn', () => { c.rules.splice(ix - 1, 0, c.rules.splice(ix, 1)[0]); this.render(); this.run.changed(false); });
      up.title = t('match this rule first');
      up.disabled = ix === 0;
      const del = button('×', 'rn-aasbtn', () => { c.rules.splice(ix, 1); if (!c.rules.length) c.rules = null; this.render(); this.run.changed(false); });
      del.title = t('remove this rule');
      row.append(up, del);
      box.append(row);
    });
    box.append(button(t('+ rule'), '', () => { c.rules.push({ from: 'collection', semanticId: '', type: '' }); this.render(); this.run.changed(false); }));
    return box;
  }

  //
  // rulesFor - the rules that make what "natural" makes of a model: the shell, and each submodel by its semanticId (else
  // any submodel) - its type as natural names it. The model discovered tells; without one, the shell and every submodel
  //
  rulesFor(id) {
    const m = this.found && this.found.models[id];
    const rules = [];
    if (!m || m.node === 'shell') rules.push({ from: 'shell', semanticId: '', type: m ? typeOf(m) : 'Shell' });
    const subs = m ? (m.node === 'submodel' ? [m] : (m.children || []).filter((n) => n.node === 'submodel')) : [];
    for (const s of subs) {
      const sem = semOf(s);
      if (sem && !rules.some((r) => r.from === 'submodel' && r.semanticId === sem)) rules.push({ from: 'submodel', semanticId: sem, type: typeOf(s) });
    }
    rules.push({ from: 'submodel', semanticId: '', type: 'Submodel' });
    return rules;
  }

  // ------------------------------------------------------------------ discovery

  async discover() {
    const f = this.f;
    this.busy = true;
    this.status = t('discovering - a broker of c³\'s own reads {url}: its shells, its submodels and each one\'s model ...', { url: f.url });
    this.render();
    try {
      const def = this.run.def(true);
      def.aas = this.toDef(true);
      delete def.bridgeConfig;
      delete def.userContext;
      delete def.opcua;
      delete def.dds;
      delete def.ckan;
      def.bridges = ['aas'];
      this.found = await api.runAasDiscover(def);
      const n = Object.keys(this.found.errors || {}).length;
      this.status = t('{url}, discovered {time}', { url: this.found.url, time: new Date().toLocaleTimeString() })
        + (this.found.complete ? '' : ' - ' + t('only the first 200 models are read'))
        + (n ? ' - ' + plural(n, '{n} model not read', '{n} models not read') : '');
    } catch (e) {
      this.status = e.message;
    }
    this.busy = false;
    this.render();
  }

  //
  // renderFound - what the discovery found: each shell, and each submodel no shell refers to - a model each, with what an
  // AssetChannel on it makes
  //
  renderFound() {
    const box = $('rn-aas-tree');
    $('rn-aas-status').textContent = this.status;
    box.hidden = !this.found;
    if (!this.found) return;
    box.replaceChildren();
    const fd = this.found;
    const inShell = new Set(fd.shells.flatMap((s) => s.submodels || []));
    const roots = [...fd.shells.map((s) => ({ item: s, kind: 'shell' })),
                   ...fd.submodels.filter((s) => !inShell.has(s.id)).map((s) => ({ item: s, kind: 'submodel' }))];
    if (!roots.length) box.append(el('div', 'cp-note', t('The server has no shells and no submodels.')));
    for (const { item, kind } of roots) box.append(this.rootNode(item, kind));
  }

  rootNode(item, kind) {
    const fd = this.found;
    const m = fd.models[item.id];
    const ch = this.channelOf(item.id);
    const box = el('div', 'rn-ounode top');
    const row = el('div', 'rn-ourow');
    const kids = el('div', '');
    const isOpen = this.open.has(item.id);
    const tog = el('button', 'rn-outog', m ? (isOpen ? '▾' : '▸') : '');
    tog.type = 'button';
    tog.disabled = !m;
    tog.setAttribute('aria-label', t('show the model'));
    row.append(tog, el('span', 'rn-oukind', kind), el('b', '', item.idShort || item.id), el('span', 'rn-ouid', item.id));
    if (kind === 'shell') row.append(el('span', 'rn-oukind', plural((item.submodels || []).length, '{n} submodel', '{n} submodels')));
    const b = button(ch ? t('an AssetChannel') : t('+ AssetChannel'), '', () => this.channelAdd(item.id));
    b.disabled = !!ch || !this.run.bridgeOk('aas');
    b.title = t('the model as entities in the broker, kept up to date');
    row.append(b);
    box.append(row);
    if (fd.errors && fd.errors[item.id]) box.append(el('div', 'cp-note err', t('not read: {why}', { why: fd.errors[item.id] })));
    if (m) {
      const made = this.entitiesOf(m, ch);
      box.append(el('div', 'rn-aasmade', made.length
        ? plural(made.length, 'makes {n} entity: {list}', 'makes {n} entities: {list}', { list: made.map((e) => e.type + ' ' + e.id).join(', ') })
        : t('makes no entity - no rule matches the shell or a submodel')));
    }
    if (m && isOpen) for (const c of m.children || []) kids.append(this.modelNode(c, item.id, ch));
    tog.addEventListener('click', () => { if (this.open.has(item.id)) this.open.delete(item.id); else this.open.add(item.id); this.renderFound(); });
    box.append(kids);
    return box;
  }

  //
  // modelNode - a node of a model as the bridge hands it over: a submodel or a collection can be made an entity of its
  // own (a rule, on the AssetChannel of its model), a leaf shows its value, an operation its variables
  //
  modelNode(n, rootId, ch) {
    const box = el('div', 'rn-ounode');
    const row = el('div', 'rn-ourow');
    row.append(el('span', 'rn-oukind', n.node), el('b', '', n.name || n.id || ''));
    const sem = semOf(n);
    if (n.value !== undefined) {
      const v = JSON.stringify(n.value);
      row.append(el('span', 'rn-ouval', v.length > 80 ? v.slice(0, 77) + '...' : v));
      if (n.attributeType) row.append(el('span', 'rn-oukind', n.attributeType));
    }
    if (n.node === 'operation') {
      const vars = (n.input || []).map((x) => x.name + (x.valueType ? ': ' + x.valueType : '')).join(', ');
      row.append(el('span', 'rn-oukind', t('a service - input {vars}', { vars: vars || t('none') })));
    }
    if (sem) { const s = el('span', 'rn-ouid', sem); s.title = t('semanticId'); row.append(s); }
    if ((n.node === 'submodel' || n.node === 'collection') && ch) {
      const rule = { from: n.node, semanticId: sem, type: String(n.typeName || n.name || '').replace(/[^A-Za-z0-9_]/g, '') || typeOf(n) };   // its own name, else its kind
      const has = ch.rules && ch.rules.some((r) => r.from === rule.from && r.semanticId === rule.semanticId);
      const b = button(has ? t('an entity rule') : t('+ entity rule'), '', () => {
        if (!ch.rules) ch.rules = this.rulesFor(rootId);
        const at = ch.rules.findIndex((r) => r.from === rule.from && !r.semanticId);     // before the catch-all of its kind
        if (!ch.rules.some((r) => r.from === rule.from && r.semanticId === rule.semanticId)) ch.rules.splice(at < 0 ? ch.rules.length : at, 0, rule);
        this.render();
        this.run.changed(false);
      });
      b.disabled = has;
      b.title = sem ? t('every {kind} with this semanticId an entity of its own, type {type}', { kind: n.node, type: rule.type })
        : t('every {kind} an entity of its own, type {type} - it has no semanticId to tell it from the others', { kind: n.node, type: rule.type });
      row.append(b);
    }
    box.append(row);
    for (const c of n.children || []) box.append(this.modelNode(c, rootId, ch));
    return box;
  }

  //
  // entitiesOf - the entities an AssetChannel makes of a model (coraine's AssetMap): "natural" (no channel yet: what it
  // would make) the shell and each submodel; rules, each node the first matching rule names. Their ids: the node's id when
  // it is an IRI, else urn:ngsi-ld:<type>:<the names from the root>
  //
  entitiesOf(m, ch) {
    const out = [];
    const match = (n) => {
      if (!ch || !ch.rules) return (n.node === 'shell' || n.node === 'submodel') ? typeOf(n) : null;
      const r = ch.rules.find((x) => x.from === n.node && x.type && (!x.semanticId || (n.semanticIds || []).includes(x.semanticId)));
      return r ? r.type : null;
    };
    const walk = (n, names) => {
      const here = [...names, n.name || ''];
      const type = match(n);
      if (type) out.push({ type, id: isIri(n.id) ? n.id : 'urn:ngsi-ld:' + type + ':' + here.map(pct).join(':') });
      for (const c of n.children || []) if (c.children) walk(c, here);
    };
    walk(m, []);
    return out;
  }
}
