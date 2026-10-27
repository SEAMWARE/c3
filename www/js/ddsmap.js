//
// ddsmap.js - the DDS mapper: the whole window for the mapping - what a DDS domain announced on the left, the
// entities it becomes in the middle, the NGSI-LD and the configuration they make on the right
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// It edits the Run form's DDS mapping in place (run.f.dds.rows: one row per endpoint - kind, name, entityId,
// entityType, attribute, and a service's or an action's DDS types); the form's summary and command follow each
// change. An endpoint is mapped by picking its entity (the list beside it, or dragged onto the entity), and its
// attribute is named in the entity. An entity with no attribute yet lives here only (this.empty): the bridge
// configuration has no entity without an endpoint.
//

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

export class DdsMapper {
  constructor(run) {
    this.run    = run;     // the Run page: its form (run.f.dds), the inventory (run.ddsInv), discovery
    this.ov     = null;    // the mapper, built on first open
    this.empty  = [];      // [{id, type}] - entities with no endpoint yet
    this.sel    = null;    // the entity shown in the preview (its id); null: every entity
    this.filter = '';
    this.house  = false;   // ROS 2 housekeeping shown
  }

  get dds()  { return this.run.f.dds; }
  get rows() { return this.run.f.dds.rows; }
  get inv()  { return this.run.ddsInv; }

  // ------------------------------------------------------------------ open, close

  open() {
    if (!this.ov) this.build();
    this.ov.hidden = false;
    this.domainIn.value = String(this.dds.domain || 0);
    this.vocabIn.value  = this.dds.vocabulary || '';
    this.render();
    document.addEventListener('keydown', this.onKey);
    (this.inv ? this.filterIn : this.discoverBtn).focus();
  }

  close() {
    if (!this.ov || this.ov.hidden) return;
    this.ov.hidden = true;
    document.removeEventListener('keydown', this.onKey);
    this.run.renderDds();
    if (this.inv) this.run.renderDdsInventory();
    $('rn-dds-map').focus();
  }

  get isOpen() { return !!this.ov && !this.ov.hidden; }

  // changed - the form's summary and command after a change of the mapping
  changed() {
    this.run.renderDdsSum();
    this.run.changed(false);
  }

  build() {
    const ov = el('div', 'dm');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'DDS mapping');
    this.onKey = (e) => { if (e.key === 'Escape') this.close(); };

    const bar = el('div', 'dm-bar');
    bar.append(el('h2', 'dm-title', 'DDS mapping'));
    this.domainIn = input('', 'domain (0)', 'DDS domain', (v) => { this.dds.domain = parseInt(v, 10) || 0; this.changed(); });
    this.domainIn.classList.add('dm-domain');
    this.domainIn.inputMode = 'numeric';
    this.vocabIn = input('', 'vocabulary - the terms\' namespace (https://example.org/robots/); empty: no @context', 'Vocabulary',
      (v) => { this.dds.vocabulary = v; this.renderPreview(); this.changed(); });
    this.vocabIn.classList.add('dm-vocab');
    this.discoverBtn = button('Discover', 'primary', () => this.discover());
    const importBtn = button('Import inventory.json', '', () => $('rn-dds-file').click());
    this.status = el('span', 'dm-status');
    const done = button('Done', '', () => this.close());
    done.classList.add('dm-done');
    bar.append(this.domainIn, this.vocabIn, this.discoverBtn, importBtn, this.status, done);

    const cols = el('div', 'dm-cols');

    // what was announced
    const left = el('section', 'dm-col dm-left');
    const lhead = el('div', 'dm-colhead');
    lhead.append(el('h3', '', 'Announced'));
    this.count = el('span', 'dm-count');
    lhead.append(this.count);
    const tools = el('div', 'dm-tools');
    this.filterIn = input('', 'filter by name', 'Filter the endpoints by name', (v) => { this.filter = v.toLowerCase(); this.renderLeft(); });
    const house = el('label', 'rn-check');
    const hc = el('input');
    hc.type = 'checkbox';
    hc.addEventListener('change', () => { this.house = hc.checked; this.renderLeft(); });
    house.title = 'ROS 2 discovery and log topics, every node\'s parameter services';
    house.append(hc, document.createTextNode(' ROS 2 housekeeping'));
    const byName = button('Map topics by their names', 'small', () => this.mapByNames());
    byName.title = 'every topic shown and not mapped: its entity from the name (rt/turtle1/pose - urn:ngsi-ld:<type>:turtle1), its attribute the last segment (pose)';
    tools.append(this.filterIn, house, byName);
    this.list = el('div', 'dm-list');
    left.append(lhead, tools, this.list);

    // the entities
    const mid = el('section', 'dm-col dm-mid');
    const mhead = el('div', 'dm-colhead');
    mhead.append(el('h3', '', 'Entities'));
    this.newType = input('', 'type of a new entity (Robot)', 'Entity type of a new entity', () => {});
    this.newType.classList.add('dm-newtype');
    mhead.append(this.newType, button('+ Entity', 'small', () => this.entityNew()));
    this.ents = el('div', 'dm-ents');
    mid.append(mhead, this.ents);

    // what it makes
    const right = el('section', 'dm-col dm-right');
    this.preview = el('div', 'dm-preview');
    right.append(this.preview);

    cols.append(left, mid, right);
    ov.append(bar, cols);
    ov.hidden = true;
    document.body.append(ov);
    this.ov = ov;
  }

  // ------------------------------------------------------------------ discovery

  async discover() {
    this.discoverBtn.disabled = true;
    this.status.textContent = 'discovering - a broker of its own on domain ' + (this.dds.domain || 0) + ', for a few seconds ...';
    await this.run.ddsDiscover();
    this.discoverBtn.disabled = false;
    this.render();
  }

  // refresh - after a discovery or an import (Run.ddsInventorySet), or its failure
  refresh() {
    if (this.isOpen) this.render();
  }

  // ------------------------------------------------------------------ the mapping

  rowOf(kind, name) {
    return this.rows.find((r) => r.kind === kind && r.name === name);
  }

  // entities - every entity: those of the rows, in their order, then the empty ones
  entities() {
    const out = [];
    const byId = new Map();
    for (const r of this.rows) {
      let e = byId.get(r.entityId);
      if (!e) { e = { id: r.entityId, type: r.entityType, rows: [] }; byId.set(r.entityId, e); out.push(e); }
      e.rows.push(r);
    }
    this.empty = this.empty.filter((e) => !byId.has(e.id));
    for (const e of this.empty) out.push({ id: e.id, type: e.type, rows: [], empty: e });
    return out;
  }

  // attributeFree - 'base', or base2, base3 ... - one the entity does not have yet
  attributeFree(entityId, base, except) {
    const taken = new Set(this.rows.filter((r) => r.entityId === entityId && r !== except).map((r) => r.attribute));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(base + n)) return base + n;
  }

  // map - an endpoint onto an entity: its row made, or moved there; the attribute's name kept (free in the
  // entity), or the endpoint's last segment
  map(kind, name, ent) {
    const e = this.endpoint(kind, name);
    let r = this.rowOf(kind, name);
    if (!r) {
      if (!e) return;
      r = this.run.ddsRowFor(kind, e);
      this.rows.push(r);
    }
    r.entityId   = ent.id;
    r.entityType = ent.type;
    r.attribute  = this.attributeFree(ent.id, r.attribute || 'value', r);
    this.sel = ent.id;
    this.render();
    this.changed();
  }

  unmap(r) {
    const left = this.rows.filter((x) => x.entityId === r.entityId).length === 1;
    if (left && !this.empty.some((e) => e.id === r.entityId)) this.empty.push({ id: r.entityId, type: r.entityType });
    this.rows.splice(this.rows.indexOf(r), 1);
    this.render();
    this.changed();
  }

  mapByNames() {
    if (!this.inv) return;
    let n = 0;
    for (const e of this.shown('topic')) {
      if (this.rowOf('topic', e.name)) continue;
      const r = this.run.ddsRowFor('topic', e);
      r.attribute = this.attributeFree(r.entityId, r.attribute, null);
      this.rows.push(r);
      n++;
    }
    this.status.textContent = n ? n + ' topic' + (n === 1 ? '' : 's') + ' mapped by name' : 'every topic shown is mapped already';
    this.render();
    this.changed();
  }

  entityNew(type) {
    const t = type || this.newType.value.trim() || this.run.ddsType || 'Robot';
    const ids = new Set(this.entities().map((e) => e.id));
    let n = 1;
    while (ids.has('urn:ngsi-ld:' + t + ':' + n)) n++;
    const ent = { id: 'urn:ngsi-ld:' + t + ':' + n, type: t };
    this.empty.push(ent);
    this.sel = ent.id;
    this.render();
    const card = this.ents.querySelector('[data-entity="' + CSS.escape(ent.id) + '"] .dm-entid');
    if (card) { card.focus(); card.select(); }
    return ent;
  }

  // entityRename - the id or the type of an entity: every row of it, or the empty entity
  entitySet(ent, key, v) {
    const old = ent.id;
    for (const r of this.rows) if (r.entityId === old) r[key === 'id' ? 'entityId' : 'entityType'] = v;
    if (ent.empty) ent.empty[key] = v;
    ent[key] = v;
    if (key === 'id' && this.sel === old) this.sel = v;
  }

  entityDelete(ent) {
    for (const r of [...ent.rows]) this.rows.splice(this.rows.indexOf(r), 1);
    this.empty = this.empty.filter((e) => e.id !== ent.id);
    if (this.sel === ent.id) this.sel = null;
    this.render();
    this.changed();
  }

  // ------------------------------------------------------------------ the inventory

  endpoint(kind, name) {
    return this.inv ? (this.inv[kind + 's'] || []).find((e) => e.name === name) : null;
  }

  shown(kind) {
    if (!this.inv) return [];
    return (this.inv[kind + 's'] || []).filter((e) => (this.house || !this.run.ddsHousekeeping(kind, e.name))
                                                 && (!this.filter || e.name.toLowerCase().includes(this.filter)));
  }

  // samples - what an endpoint carries, as its discovered types' samples: [label, sample]
  samples(kind, e) {
    const t = (name) => ((this.inv && this.inv.types) || {})[name];
    const s = (label, name) => (t(name) && t(name).sample !== undefined ? [[label, t(name).sample]] : []);
    if (!e) return [];
    if (kind === 'topic')   return s('sample', e.type);
    if (kind === 'service') return [...s('request', (e.request || {}).type), ...s('reply', (e.reply || {}).type)];
    return [...s('goal', ((e.goal || {}).request || {}).type), ...s('feedback', (e.feedback || {}).type),
            ...s('result', ((e.result || {}).reply || {}).type)];
  }

  // ------------------------------------------------------------------ drag and drop

  dragSource(node, kind, name) {
    node.draggable = true;
    node.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-c3-dds', JSON.stringify({ kind, name }));
      ev.dataTransfer.effectAllowed = 'move';
      this.ov.classList.add('dm-dragging');
    });
    node.addEventListener('dragend', () => this.ov.classList.remove('dm-dragging'));
  }

  dropTarget(node, onDrop) {
    node.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer.types.includes('application/x-c3-dds')) return;
      ev.preventDefault();
      node.classList.add('dm-over');
    });
    node.addEventListener('dragleave', (ev) => { if (!node.contains(ev.relatedTarget)) node.classList.remove('dm-over'); });
    node.addEventListener('drop', (ev) => {
      ev.preventDefault();
      node.classList.remove('dm-over');
      this.ov.classList.remove('dm-dragging');
      try { const d = JSON.parse(ev.dataTransfer.getData('application/x-c3-dds')); onDrop(d.kind, d.name); } catch { /* not ours */ }
    });
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const inv = this.inv;
    if (!this.discoverBtn.disabled) {
      const why = $('rn-dds-why').textContent;
      this.status.textContent = why || (inv ? '' : 'Discover asks the domain what it announces - or import an inventory.json');
    }
    this.renderLeft();
    this.renderEntities();
    this.renderPreview();
  }

  renderLeft() {
    const box = this.list;
    box.replaceChildren();
    const inv = this.inv;
    const ents = this.entities();
    let all = 0, mapped = 0;

    if (!inv) {
      box.append(el('p', 'cp-note', 'Nothing discovered yet. Discover starts a broker of c³\'s own on the domain, a few seconds, and lists '
        + 'the topics, services and actions it saw announced. A ROS 2 node, or anything else speaking DDS, has to be running on that domain.'));
    }

    for (const [kind, , label] of KINDS) {
      const list = this.shown(kind);
      if (!list.length) continue;
      const m = list.filter((e) => this.rowOf(kind, e.name)).length;
      all += list.length; mapped += m;
      box.append(el('div', 'dm-group', label + ' - ' + m + ' of ' + list.length + ' mapped'));
      for (const e of list) box.append(this.endpointNode(kind, e, ents));
    }

    // rows whose endpoint the inventory has not (the mapping of an earlier discovery, or a broker's saved one)
    const unseen = this.rows.filter((r) => !this.endpoint(r.kind, r.name));
    if (inv && unseen.length) {
      box.append(el('div', 'dm-group', 'Mapped, not in the last discovery - ' + unseen.length));
      for (const r of unseen) box.append(this.endpointNode(r.kind, { name: r.name }, ents, true));
    }

    if (inv && !all && !unseen.length) box.append(el('p', 'cp-note', this.filter ? 'no name has "' + this.filter + '"' : 'nothing announced' + (this.house ? '' : ' but ROS 2 housekeeping')));
    this.count.textContent = inv ? mapped + ' of ' + all + ' mapped' : '';
  }

  endpointNode(kind, e, ents, unseen) {
    const r = this.rowOf(kind, e.name);
    const node = el('div', 'dm-ep' + (r ? ' mapped' : '') + (unseen ? ' unseen' : ''));
    const head = el('div', 'dm-ephead');
    const samples = this.samples(kind, e);
    const tog = el('button', 'dm-tog', samples.length ? '▸' : '');
    tog.type = 'button';
    tog.disabled = !samples.length;
    tog.title = 'its fields';
    tog.setAttribute('aria-label', 'the fields of ' + e.name);
    const type = unseen ? '' : rosType(this.run.ddsTypeOf(kind, e));
    head.append(tog, el('span', 'dm-kind dm-k-' + kind, kind), el('b', 'dm-name', e.name), el('span', 'dm-type', type));
    node.append(head);

    const line = el('div', 'dm-epmap');
    const sel = el('select', 'cp-input dm-pick');
    sel.setAttribute('aria-label', 'the entity of ' + e.name);
    sel.append(new Option('- not mapped -', ''));
    for (const ent of ents) sel.append(new Option(ent.id + (ent.type ? '  (' + ent.type + ')' : ''), ent.id));
    sel.append(new Option('+ a new entity', '+'));
    sel.value = r ? r.entityId : '';
    sel.addEventListener('change', () => {
      if (sel.value === '') { if (r) this.unmap(r); return; }
      const ent = sel.value === '+' ? this.entityNew() : ents.find((x) => x.id === sel.value);
      this.map(kind, e.name, ent);
    });
    line.append(sel);
    if (r) line.append(el('span', 'dm-as', 'as'), el('b', 'dm-attr', r.attribute || '?'));
    if (unseen) line.append(el('span', 'why', 'not announced'));
    node.append(line);

    const pre = el('pre', 'dm-sample');
    pre.hidden = true;
    pre.textContent = samples.map(([label, s]) => (samples.length > 1 ? label + ':\n' : '') + JSON.stringify(s, null, 2)).join('\n');
    tog.addEventListener('click', () => { pre.hidden = !pre.hidden; tog.textContent = pre.hidden ? '▸' : '▾'; });
    node.append(pre);

    if (!unseen) this.dragSource(node, kind, e.name);
    return node;
  }

  renderEntities() {
    const box = this.ents;
    box.replaceChildren();
    const ents = this.entities();

    if (!ents.length) {
      box.append(el('p', 'cp-note', 'No entity yet. Pick one in the list beside an endpoint, drag an endpoint here, or + Entity. '
        + 'Each mapped endpoint is one attribute of its entity, its name yours to choose.'));
    }

    for (const ent of ents) box.append(this.entityCard(ent, ents));

    const drop = el('div', 'dm-dropnew', 'drop an endpoint here - a new entity');
    this.dropTarget(drop, (kind, name) => this.map(kind, name, this.entityNew()));
    box.append(drop);
  }

  entityCard(ent, ents) {
    const card = el('div', 'dm-ent' + (this.sel === ent.id ? ' sel' : ''));
    card.dataset.entity = ent.id;
    card.addEventListener('focusin', () => { if (this.sel !== ent.id) { this.sel = ent.id; this.markSel(); this.renderPreview(); } });
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('input, select, button')) return;
      this.sel = this.sel === ent.id ? null : ent.id;
      this.markSel();
      this.renderPreview();
    });

    const head = el('div', 'dm-enthead');
    const typeIn = input(ent.type, 'Robot', 'The entity\'s type', (v) => { this.entitySet(ent, 'type', v); this.check(card, ent); this.renderPreview(); this.changed(); });
    typeIn.classList.add('dm-enttype');
    const idIn = input(ent.id, 'urn:ngsi-ld:Robot:1', 'The entity\'s id', (v) => { this.entitySet(ent, 'id', v); card.dataset.entity = v; this.check(card, ent); this.renderPreview(); this.changed(); });
    idIn.classList.add('dm-entid');
    idIn.addEventListener('change', () => this.render());             // the entity lists beside the endpoints
    const del = button('×', 'dm-del', () => this.entityDelete(ent));
    del.title = ent.rows.length ? 'remove the entity - its ' + ent.rows.length + ' endpoint' + (ent.rows.length === 1 ? '' : 's') + ' not mapped any more' : 'remove the entity';
    del.setAttribute('aria-label', 'remove ' + ent.id);
    head.append(typeIn, idIn, del);
    card.append(head);

    const attrs = el('div', 'dm-attrs');
    if (!ent.rows.length) attrs.append(el('div', 'dm-hint', 'no attribute yet - drop an endpoint here, or pick this entity beside one'));
    for (const r of ent.rows) {
      const row = el('div', 'dm-arow');
      const nameIn = input(r.attribute, 'attribute', 'The attribute of ' + r.name, (v) => { r.attribute = v; this.check(card, ent); this.renderPreview(); this.changed(); });
      nameIn.classList.add('dm-aname');
      nameIn.addEventListener('change', () => this.renderLeft());
      const move = el('select', 'cp-input dm-move');
      move.setAttribute('aria-label', 'move ' + r.name + ' to another entity');
      move.title = 'move to another entity';
      move.append(new Option('move to ...', ''));
      for (const x of ents) if (x.id !== ent.id) move.append(new Option(x.id, x.id));
      move.append(new Option('+ a new entity', '+'));
      move.addEventListener('change', () => {
        if (!move.value) return;
        this.map(r.kind, r.name, move.value === '+' ? this.entityNew(ent.type) : ents.find((x) => x.id === move.value));
      });
      const un = button('×', 'dm-del', () => this.unmap(r));
      un.title = 'not mapped';
      un.setAttribute('aria-label', 'unmap ' + r.name);
      const src = el('span', 'dm-src');
      src.append(el('span', 'dm-kind dm-k-' + r.kind, r.kind), el('span', 'dm-name', r.name));
      row.append(nameIn, src, move, un);
      this.dragSource(row, r.kind, r.name);
      attrs.append(row);
    }
    card.append(attrs, el('div', 'dm-warn'));
    this.dropTarget(card, (kind, name) => this.map(kind, name, ent));
    this.check(card, ent);
    return card;
  }

  markSel() {
    for (const c of this.ents.querySelectorAll('.dm-ent')) c.classList.toggle('sel', c.dataset.entity === this.sel);
  }

  // problems - what the broker would refuse or do otherwise than meant, for an entity
  problems(ent) {
    const out = [];
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(ent.id)) out.push('the id is not a URI (urn:ngsi-ld:Robot:1)');
    if (this.entities().filter((e) => e.id === ent.id).length > 1) out.push('another entity has this id');
    if (!ent.type) out.push('no type');
    else if (FORBIDDEN.test(ent.type)) out.push('the type has a character NGSI-LD forbids in a name (space < > " \' = ; ( ))');
    if (new Set(ent.rows.map((r) => r.entityType)).size > 1) out.push('its endpoints disagree on the type - type it again');
    const seen = new Set();
    for (const r of ent.rows) {
      const a = r.attribute;
      if (!a) out.push(r.name + ': no attribute name');
      else if (FORBIDDEN.test(a)) out.push(a + ': a character NGSI-LD forbids in a name (space < > " \' = ; ( ))');
      else if (RESERVED.includes(a)) out.push(a + ': a member of every entity, not an attribute name');
      else if (seen.has(a)) out.push(a + ': two endpoints, one attribute');
      seen.add(a);
    }
    return out;
  }

  check(card, ent) {
    const p = this.problems(ent);
    const w = card.querySelector('.dm-warn');
    w.replaceChildren(...p.map((t) => el('div', '', t)));
    card.classList.toggle('bad', p.length > 0);
  }

  // ------------------------------------------------------------------ what it makes

  renderPreview() {
    const box = this.preview;
    box.replaceChildren();
    const ents = this.entities().filter((e) => e.rows.length && (!this.sel || e.id === this.sel));

    box.append(el('h3', '', this.sel ? 'The entity' : 'The entities'));
    box.append(el('p', 'cp-note', 'As the broker makes them: each attribute is there from the start, "uninitialized" until its first '
      + 'sample; a topic\'s value is then the whole sample - here one of its type, as discovered (zeros). A service\'s attribute '
      + 'calls the service when written, an action\'s sends a goal.' + (this.sel ? ' Click the entity again for all of them.' : '')));
    if (!ents.length) box.append(el('p', 'cp-note', 'nothing mapped yet'));
    for (const ent of ents) {
      const o = { id: ent.id, type: ent.type };
      for (const r of ent.rows) {
        const e = this.endpoint(r.kind, r.name);
        const s = r.kind === 'topic' ? this.samples('topic', e) : [];
        o[r.attribute || '?'] = { type: 'Property', value: s.length ? s[0][1] : 'uninitialized' };
      }
      box.append(el('pre', 'dm-json', JSON.stringify(o, null, 2)));
    }

    const voc = this.dds.vocabulary;
    box.append(el('h3', '', 'The @context'));
    if (!voc) {
      box.append(el('p', 'cp-note', 'No vocabulary: the types and attributes expand to the default context\'s namespace. With one, c³ writes '
        + 'dds-context.jsonld and starts the broker with it as --defaultUserContext.'));
    } else {
      const ctx = {};
      for (const r of this.rows) for (const t of [r.entityType, r.attribute]) if (t && !(t in ctx)) ctx[t] = voc + t;
      box.append(el('pre', 'dm-json', JSON.stringify({ '@context': ctx }, null, 2)));
    }

    box.append(el('h3', '', 'The configuration'));
    box.append(el('p', 'cp-note', 'dds.ngsild of the bridge configuration c³ writes when the broker starts'));
    const conf = { topics: {}, services: {}, actions: {} };
    for (const r of this.rows) {
      const o = { entityId: r.entityId, entityType: r.entityType, attribute: r.attribute };
      if (r.kind === 'service') Object.assign(o, { requestType: r.requestType, replyType: r.replyType });
      if (r.kind === 'action') o.type = r.type;
      conf[r.kind + 's'][r.name] = o;
    }
    for (const k of ['topics', 'services', 'actions']) if (!Object.keys(conf[k]).length) delete conf[k];
    box.append(el('pre', 'dm-json', JSON.stringify(conf, null, 2)));
  }
}
