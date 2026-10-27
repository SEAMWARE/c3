//
// ddsmap.js - the DDS mapper: Operate's left side given to the mapping of DDS topics, services and actions to
// NGSI-LD attributes, then the two files it makes and a broker started with them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The mapping screen: what a DDS domain announced (Discover, or an inventory.json), three lines - the topics,
// the services, the actions - each opening to its endpoints, each endpoint opening to its attribute's name, its
// entity's id and type. An entity's type is given once, on any of its endpoints; the others take it. Done
// writes the DDS configuration (POST /api/run/dds/files): the bridge configuration and the @context, in c³'s
// data directory - the files screen says where, and starts a broker with them, through the broker form.
//
// What was written is read back when the page opens (GET /api/run/dds/files): mapping once is the usual case,
// the mapper opens on it.
//
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

// count - '1 topic', '3 topics'
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
// rosType - a DDS type name as ROS 2 writes it: turtlesim::msg::dds_::Pose_ is turtlesim/msg/Pose
//
function rosType(t) {
  return String(t || '').replace(/::dds_::/, '::').replace(/_$/, '').split('::').join('/');
}

//
// NGSI-LD names: an attribute's or a type's name may not hold these (TS 104-176 § 4.6.2), and an entity's own
// members are not attributes
//
const FORBIDDEN = /[\s<>"'=;()]/;
const RESERVED  = ['id', 'type', '@id', '@type', '@context', 'scope', 'createdAt', 'modifiedAt', 'deletedAt'];

const KINDS = [['topic', 'topics', 'Topics'], ['service', 'services', 'Services'], ['action', 'actions', 'Actions']];

//
// housekeeping - what ROS 2 itself has on every domain, rarely worth mapping: its discovery and log topics, and
// every node's parameter services
//
function housekeeping(kind, name) {
  if (kind === 'topic') return ['ros_discovery_info', 'rt/parameter_events', 'rt/rosout'].includes(name);
  return kind === 'service' && /(^|\/)(describe_parameters|get_parameter_types|get_parameters|get_type_description|list_parameters|set_parameters|set_parameters_atomically)$/.test(name);
}

// typeOf - an endpoint's type as discovered: a service's and an action's without the request suffixes
function typeOf(kind, e) {
  if (kind === 'topic') return e.type || '';
  if (kind === 'service') return ((e.request || {}).type || '').replace(/_Request_$/, '');
  return (((e.goal || {}).request || {}).type || '').replace(/_SendGoal_Request_$/, '');
}

// suggested - an attribute name from an endpoint's name: its last segment, camelCased (rt/turtle1/cmd_vel: cmdVel)
function suggested(name) {
  const segs = name.replace(/^rt\//, '').split('/').filter(Boolean);
  const last = segs.pop() || name;
  return last.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

export class DdsMapper {
  constructor(run) {
    this.run     = run;           // the Run page: its form, its Start, the broker discovery is started from
    this.box     = null;          // the mapper's section in Operate's left side, built on first open
    this.domain  = 0;
    this.vocab   = '';
    this.rows    = new Map();     // kind + '\n' + name -> { kind, name, attribute, entityId, entityType, requestType, replyType, type }
    this.inv     = null;          // the inventory: { topics, services, actions, types }
    this.files   = null;          // GET /api/run/dds/files: { directory, bridgeConfig, userContext, mapping }
    this.open_   = { topic: false, service: false, action: false };
    this.openEp  = new Set();     // the endpoints open (kind + '\n' + name)
    this.house   = false;         // ROS 2 housekeeping shown
    this.status  = '';
    this.screen  = 'map';         // 'map' | 'files'
    this.from    = '';            // 'compile' when opened from Compile: a way back to it
  }

  // ------------------------------------------------------------------ the saved configuration

  async load() {
    try {
      this.files = await api.runDdsFiles();
    } catch (e) {
      this.files = null;
    }
    const m = this.files && this.files.mapping;
    if (!m) return;
    this.domain = m.domain || 0;
    this.vocab  = m.vocabulary || '';
    this.rows.clear();
    for (const [kind, plural] of KINDS) {
      for (const x of m[plural] || []) {
        const r = { kind, name: x[kind], attribute: x.attribute || '', entityId: x.entityId || '', entityType: x.entityType || '' };
        if (kind === 'service') Object.assign(r, { requestType: x.requestType || '', replyType: x.replyType || '' });
        if (kind === 'action') r.type = x.type || '';
        this.rows.set(kind + '\n' + r.name, r);
      }
    }
  }

  // note - the line under the form's button
  note(on) {
    const m = this.files && this.files.mapping;
    if (!m) return on ? 'nothing mapped yet - a broker with the dds bridge alone shows what it sees on one entity, urn:ngsi-ld:dds:default' : '';
    const n = (k) => (m[k] || []).length;
    return 'the DDS configuration: ' + count(n('topics'), 'topic', 'topics') + ', ' + count(n('services'), 'service', 'services') + ', '
      + count(n('actions'), 'action', 'actions') + ' mapped - '
      + this.files.bridgeConfig;
  }

  // ------------------------------------------------------------------ open, close

  build() {
    const main = document.querySelector('#page-run .cp-main');
    this.box = el('section', 'dm');
    this.box.setAttribute('aria-label', 'DDS mapping');
    this.box.hidden = true;
    main.append(this.box);
    this.onKey = (e) => { if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) this.close(); };
  }

  open(from) {
    this.from = from || '';
    if (!this.box) this.build();
    const main = this.box.parentElement;
    for (const c of main.children) if (c !== this.box) { c.dataset.dmHidden = c.hidden ? '1' : ''; c.hidden = true; }
    this.box.hidden = false;
    this.show('map');
    document.addEventListener('keydown', this.onKey);
  }

  close() {
    if (!this.box || this.box.hidden) return;
    const main = this.box.parentElement;
    for (const c of main.children) if (c !== this.box) { c.hidden = c.dataset.dmHidden === '1'; delete c.dataset.dmHidden; }
    this.box.hidden = true;
    document.removeEventListener('keydown', this.onKey);
    this.run.renderDds();
    $('rn-dds-map').focus();
  }

  // closeButtons - the × of a screen, and, opened from Compile, the way back to it
  closeButtons() {
    const out = [];
    if (this.from === 'compile') out.push(button('← Back to Compile', 'small dm-back', () => { this.close(); location.hash = '#compile'; }));
    const close = button('×', 'dm-close', () => this.close());
    close.title = 'back to the brokers';
    close.setAttribute('aria-label', 'close the DDS mapping');
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

  async discover(btn) {
    btn.disabled = true;
    this.status = 'discovering - a broker of c³\'s own on domain ' + this.domain + ', for a few seconds ...';
    this.renderStatus();
    try {
      const def = this.run.def();
      def.dds = { domain: this.domain, topics: [], services: [], actions: [] };
      delete def.bridgeConfig;
      delete def.userContext;
      const inv = await api.runDdsDiscover(def);
      this.inventorySet(inv, 'domain ' + this.domain + ', discovered ' + new Date().toLocaleTimeString());
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
      if (!Array.isArray(inv.topics) && !Array.isArray(inv.services) && !Array.isArray(inv.actions)) throw new Error('not an inventory: no "topics", "services" or "actions"');
      this.inventorySet(inv, file.name + (inv.discoveredAt ? ', discovered ' + inv.discoveredAt : ''));
    } catch (e) {
      this.status = file.name + ': ' + e.message;
    }
    this.render();
  }

  inventorySet(inv, from) {
    this.inv = { topics: inv.topics || [], services: inv.services || [], actions: inv.actions || [], types: inv.types || {} };
    const n = this.inv.topics.length + this.inv.services.length + this.inv.actions.length;
    this.status = from + ' - ' + count(n, 'endpoint', 'endpoints')
      + (inv.settled === false ? '; the domain was still announcing more when it answered - Discover again for the rest' : '');
    for (const [kind, plural] of KINDS) if (this.inv[plural].some((e) => !housekeeping(kind, e.name))) this.open_[kind] = true;
  }

  renderStatus() {
    const s = this.box.querySelector('.dm-status');
    if (s) s.textContent = this.status;
  }

  // ------------------------------------------------------------------ the mapping

  key(kind, name) { return kind + '\n' + name; }

  // endpoints - of a kind: the discovered (housekeeping hidden unless asked) and the mapped not discovered
  endpoints(kind) {
    const plural = kind + 's';
    const seen = new Set();
    const out = [];
    for (const e of (this.inv && this.inv[plural]) || []) {
      seen.add(e.name);
      if (this.house || !housekeeping(kind, e.name) || this.rows.has(this.key(kind, e.name))) out.push({ e, seen: true });
    }
    for (const r of this.rows.values()) if (r.kind === kind && !seen.has(r.name)) out.push({ e: { name: r.name }, seen: false });
    return out;
  }

  // row - an endpoint's row, made on its first field: the attribute's name suggested from the endpoint's, a service's
  // and an action's DDS types from the inventory
  row(kind, e) {
    const k = this.key(kind, e.name);
    let r = this.rows.get(k);
    if (!r) {
      r = { kind, name: e.name, attribute: suggested(e.name), entityId: '', entityType: '' };
      if (kind === 'service') Object.assign(r, { requestType: (e.request || {}).type || '', replyType: (e.reply || {}).type || '' });
      if (kind === 'action') r.type = typeOf('action', e);
      this.rows.set(k, r);
    }
    return r;
  }

  mapped(r) { return !!(r && (r.attribute || r.entityId || r.entityType)); }

  // entityTypes - each entity id's type: the first given on one of its endpoints
  entityTypes() {
    const t = new Map();
    for (const r of this.rows.values()) if (r.entityId && r.entityType && !t.has(r.entityId)) t.set(r.entityId, r.entityType);
    return t;
  }

  //
  // problems - per endpoint (its key) what Done would refuse; 'entities' - per entity id with no type anywhere
  //
  problems() {
    const per = new Map();
    const add = (k, t) => { if (!per.has(k)) per.set(k, []); per.get(k).push(t); };
    const types = this.entityTypes();
    const attrs = new Map();       // entityId + '\n' + attribute -> the first endpoint with it

    for (const [k, r] of this.rows) {
      if (!this.mapped(r)) continue;
      if (!r.attribute) add(k, 'no attribute name');
      else if (FORBIDDEN.test(r.attribute)) add(k, 'the attribute name has a character NGSI-LD forbids in a name (space < > " \' = ; ( ))');
      else if (RESERVED.includes(r.attribute)) add(k, '"' + r.attribute + '" is a member of every entity, not an attribute name');
      if (!r.entityId) add(k, 'no entity id');
      else if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(r.entityId)) add(k, 'the entity id is not a URI (urn:ngsi-ld:Robot:1)');
      else if (!types.has(r.entityId)) add(k, 'the entity ' + r.entityId + ' has no type - give it one here, or on another of its endpoints');
      if (r.entityType && FORBIDDEN.test(r.entityType)) add(k, 'the entity type has a character NGSI-LD forbids in a name');
      if (r.entityType && types.get(r.entityId) && r.entityType !== types.get(r.entityId)) add(k, 'another endpoint gives ' + r.entityId + ' the type ' + types.get(r.entityId));
      if (r.attribute && r.entityId) {
        const a = r.entityId + '\n' + r.attribute;
        if (attrs.has(a)) add(k, r.entityId + ' has the attribute ' + r.attribute + ' already, from ' + attrs.get(a));
        else attrs.set(a, r.name);
      }
    }
    return per;
  }

  // ------------------------------------------------------------------ the mapping screen

  mapScreen() {
    const out = [];

    const head = el('div', 'cp-card dm-head');
    const top = el('div', 'dm-top');
    top.append(el('h2', 'section', 'Map DDS topics, services and actions'), ...this.closeButtons());
    head.append(top, el('p', 'cp-note', 'Each topic, service or action mapped is one attribute of an entity: its name, the entity\'s id, and the '
      + 'entity\'s type - once for each entity, on any of its endpoints. Done writes the DDS configuration, two files, and a broker starts with them.'));

    const row = el('div', 'dm-row');
    const dom = input(String(this.domain), 'domain (0)', 'DDS domain', (v) => { this.domain = parseInt(v, 10) || 0; });
    dom.inputMode = 'numeric';
    dom.classList.add('dm-domain');
    const voc = input(this.vocab, 'vocabulary - the terms\' namespace (https://example.org/robots/); empty: the default context\'s', 'Vocabulary',
      (v) => { this.vocab = v; });
    voc.classList.add('dm-vocab');
    const disc = button('Discover', 'primary', () => this.discover(disc));
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; this.importFile(f); });
    const imp = button('Import inventory.json', '', () => file.click());
    row.append(dom, voc, disc, imp, file);
    const st = el('div', 'dm-row');
    const house = el('label', 'rn-check');
    const hc = el('input');
    hc.type = 'checkbox';
    hc.checked = this.house;
    hc.addEventListener('change', () => { this.house = hc.checked; this.render(); });
    house.title = 'ROS 2 discovery and log topics, every node\'s parameter services';
    house.append(hc, document.createTextNode(' show ROS 2 housekeeping'));
    st.append(el('span', 'dm-status', this.status || (this.inv ? '' : 'Discover asks the domain what it announces (a ROS 2 node, or anything speaking DDS, running on it) - or import an inventory.json')), house);
    head.append(row, st);
    out.push(head);

    const problems = this.problems();
    const types = this.entityTypes();
    const ids = [...new Set([...this.rows.values()].map((r) => r.entityId).filter(Boolean))];
    const listIds = el('datalist');
    listIds.id = 'dm-ids';
    for (const id of ids) listIds.append(new Option(id));
    const listTypes = el('datalist');
    listTypes.id = 'dm-types';
    for (const t of new Set(types.values())) listTypes.append(new Option(t));

    const card = el('div', 'cp-card dm-groups');
    card.append(listIds, listTypes);
    for (const [kind, , label] of KINDS) card.append(this.group(kind, label, problems));
    out.push(card);

    // Done
    const foot = el('div', 'cp-card dm-foot');
    const mapped = [...this.rows.values()].filter((r) => this.mapped(r));
    const nProblems = [...problems.values()].reduce((n, l) => n + l.length, 0);
    const ents = new Set(mapped.map((r) => r.entityId).filter(Boolean));
    const sum = el('span', 'dm-sum', mapped.length
      ? mapped.length + ' mapped, ' + count(ents.size, 'entity', 'entities') + (nProblems ? ' - ' + nProblems + ' to fix first' : '')
      : 'nothing mapped yet');
    const done = button('Done', 'primary dm-done', () => this.done(done));
    done.disabled = !mapped.length || nProblems > 0;
    foot.append(sum, el('span', 'dm-err'), done);
    out.push(foot);
    return out;
  }

  group(kind, label, problems) {
    const g = el('div', 'dm-group');
    const list = this.endpoints(kind);
    const nMapped = list.filter(({ e }) => this.mapped(this.rows.get(this.key(kind, e.name)))).length;
    const open = this.open_[kind];
    const head = el('div', 'dm-ghead');
    const tog = toggle(open, label, () => { this.open_[kind] = !open; this.render(); });
    const title = el('span', 'dm-gtitle', list.length + ' DDS ' + label);
    title.addEventListener('click', () => tog.click());
    head.append(tog, title, el('span', 'dm-gcount', nMapped ? nMapped + ' mapped' : ''));
    g.append(head);
    if (!open) return g;
    if (!list.length) g.append(el('div', 'dm-empty', this.inv ? 'none announced' + (this.house ? '' : ' but ROS 2 housekeeping') : 'nothing discovered yet'));
    for (const { e, seen } of list) g.append(this.endpoint(kind, e, seen, problems.get(this.key(kind, e.name)) || []));
    return g;
  }

  endpoint(kind, e, seen, probs) {
    const k = this.key(kind, e.name);
    const r = this.rows.get(k);
    const open = this.openEp.has(k);
    const node = el('div', 'dm-ep' + (this.mapped(r) ? ' mapped' : '') + (probs.length ? ' bad' : ''));
    const head = el('div', 'dm-ephead');
    const tog = toggle(open, e.name, () => { if (open) this.openEp.delete(k); else this.openEp.add(k); this.render(); });
    const name = el('span', 'dm-name', e.name);
    name.addEventListener('click', () => tog.click());
    head.append(tog, name, el('span', 'dm-type', seen ? rosType(typeOf(kind, e)) : 'not in the last discovery'));
    const chip = el('span', 'dm-chip');
    if (this.mapped(r)) chip.textContent = (r.attribute || '?') + ' of ' + (r.entityId || '?');
    head.append(chip);
    node.append(head);
    if (!open) return node;

    const fields = el('div', 'dm-fields');
    const types = this.entityTypes();
    const sugg = suggested(e.name);
    const f = (label, key, ph, list, hint) => {
      const l = el('label', 'dm-field');
      const i = input(r ? r[key] : '', ph, label + ' of ' + e.name, (v) => {
        const row = this.row(kind, e);
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
      f('Attribute name', 'attribute', sugg || 'value', null),
      f('Entity ID', 'entityId', 'urn:ngsi-ld:Robot:1', 'dm-ids'),
      f('Entity type', 'entityType', inherited || 'Robot', 'dm-types', inherited ? 'optional - ' + r.entityId + ' is a ' + inherited : 'optional, if another endpoint of the entity gives it'));
    node.append(fields);

    const tools = el('div', 'dm-eptools');
    const sample = this.sample(kind, e);
    if (sample) {
      const pre = el('pre', 'dm-sample', sample);
      pre.hidden = true;
      const b = button('its fields', 'small', () => { pre.hidden = !pre.hidden; });
      tools.append(b);
      node.append(tools, pre);
    }
    if (this.mapped(r)) tools.append(button('not mapped', 'small', () => { this.rows.delete(k); this.render(); }));
    if (!tools.parentElement) node.append(tools);
    node.append(el('div', 'dm-probs', probs.join(' · ')));
    return node;
  }

  sample(kind, e) {
    const t = (name) => ((this.inv && this.inv.types) || {})[name];
    const parts = [];
    const add = (label, name) => { if (t(name) && t(name).sample !== undefined) parts.push([label, t(name).sample]); };
    if (kind === 'topic') add('sample', e.type);
    else if (kind === 'service') { add('request', (e.request || {}).type); add('reply', (e.reply || {}).type); }
    else { add('goal', ((e.goal || {}).request || {}).type); add('feedback', (e.feedback || {}).type); add('result', ((e.result || {}).reply || {}).type); }
    return parts.map(([l, s]) => (parts.length > 1 ? l + ':\n' : '') + JSON.stringify(s, null, 2)).join('\n') || null;
  }

  //
  // refresh - after a keystroke in an endpoint's field, a moment later: the screen again, the focus and the caret
  // where they were
  //
  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const focus = document.activeElement;
      const label = focus && focus.getAttribute('aria-label');
      const pos = focus && focus.selectionStart;
      this.render();
      if (label) {
        const again = [...this.box.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === label);
        if (again) { again.focus(); if (pos !== null && pos !== undefined) again.setSelectionRange(pos, pos); }
      }
    }, 250);
  }

  // ------------------------------------------------------------------ Done: the files

  body() {
    const types = this.entityTypes();
    const b = { domain: this.domain, vocabulary: this.vocab, topics: [], services: [], actions: [] };
    for (const r of this.rows.values()) {
      if (!this.mapped(r)) continue;
      const o = { [r.kind]: r.name, entityId: r.entityId, entityType: r.entityType || types.get(r.entityId), attribute: r.attribute };
      if (r.kind === 'service') Object.assign(o, { requestType: r.requestType, replyType: r.replyType });
      if (r.kind === 'action') o.type = r.type;
      b[r.kind + 's'].push(o);
    }
    if (!b.vocabulary) delete b.vocabulary;
    return b;
  }

  async done(btn) {
    btn.disabled = true;
    try {
      this.files = await api.runDdsFilesWrite(this.body());
      this.show('files');
      this.run.renderDds();
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
    const ents = new Set(['topics', 'services', 'actions'].flatMap((k) => (m[k] || []).map((x) => x.entityId)));
    const out = [];

    const head = el('div', 'cp-card dm-head');
    const top = el('div', 'dm-top');
    top.append(el('h2', 'section', 'The DDS configuration is written'), ...this.closeButtons());
    head.append(top, el('p', 'cp-note', count(n('topics'), 'topic', 'topics') + ', ' + count(n('services'), 'service', 'services') + ' and '
      + count(n('actions'), 'action', 'actions') + ', as attributes of ' + count(ents.size, 'entity', 'entities') + ' - domain ' + (m.domain || 0) + '. Two files, in ' + f.directory + ':'));

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
      fileCard('The bridge configuration', f.bridgeConfig, 'the dds bridge\'s domain and the mapping the broker reads', '--bridgeConfig'),
      fileCard('The @context', f.userContext, 'each entity type and attribute a term of ' + (m.vocabulary || 'the default context\'s namespace')
        + ', so clients use the short names', '--defaultUserContext'));
    out.push(head);

    // a broker with them
    const start = el('div', 'cp-card dm-start');
    start.append(el('h2', 'section', 'Start a broker with it'));
    start.append(el('p', 'cp-note', 'The broker of the form on the right - its name, port, store and where it runs - with the dds bridge and the two files. '
      + 'More options are added as typed.'));
    const cmd = el('pre', 'cp-cmd dm-cmd');
    const more = input(this.run.f.args || '', '--memoryLimit 512 --ddsSync', 'More options for the broker', () => show());
    more.classList.add('dm-more');
    const show = () => {
      cmd.textContent = 'coraine --bridges dds \\\n  --bridgeConfig ' + f.bridgeConfig + ' \\\n  --defaultUserContext ' + f.userContext
        + (more.value.trim() ? ' \\\n  ' + more.value.trim() : '');
    };
    show();
    const ml = el('label', 'dm-field');
    ml.append(el('span', 'dm-flabel', 'More options'), more);
    const go = button('Start the broker', 'primary dm-go', () => this.startBroker(more.value.trim(), go));
    const fill = button('Put it in the broker form', '', () => { this.applyToForm(more.value.trim()); this.close(); });
    fill.title = 'the form on the right gets the dds bridge, the two files and the options - to change more before Start';
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
    if (!f.bridges.includes('dds')) f.bridges = [...f.bridges, 'dds'];
    f.bridgeConfig = this.files.bridgeConfig;
    f.userContext  = this.files.userContext;
    f.dds          = this.run.ddsDefaults();          // the mapping is in the file, not in the broker's definition
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
