//
// editor.js - an entity edited as rows: its attributes, their instances and sub-attributes, and Save
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Every attribute instance is a row: ▸ opens its sub-attributes, 🗑 marks it deleted (struck through
// until Save, and restorable), ＋ at the end of a row's sub-attributes adds one, ＋ attribute at the
// bottom adds an attribute (or another instance of one, with a datasetId). The input of a row is its
// kind's: a value and its JSON type for a Property, a target for a Relationship (or picked in the
// graph), longitude and latitude for a Point, language rows for a LanguageProperty, item rows for the
// lists, JSON for a JsonProperty.
//
// Save sends:
//   edit     what changed, as the "Save as" choice says (the default the merge):
//              merge     PATCH /entities/{id} - Merge Entity (TS 104 175 § 10.2.9, RFC 7396 at the
//                        attribute level): what changed, and "urn:ngsi-ld:null" for what was deleted -
//                        an attribute, a sub-attribute, a key inside an object value, or one instance
//                        (with its datasetId)
//              update    PATCH /entities/{id}/attrs - Update Attributes: each new or changed instance
//                        whole (a new one is appended), "urn:ngsi-ld:null" for a deleted attribute or
//                        instance
//              append    POST /entities/{id}/attrs - Append Attributes: each new or changed instance
//                        whole; nothing deleted (an append cannot delete - the request says what is left
//                        out)
//              appendNo  POST /entities/{id}/attrs?options=noOverwrite - the same, an existing attribute
//                        left as it is (the broker's 207 names it)
//              partial   PATCH /entities/{id}/attrs/{attrId} - Partial Attribute Update, one request per
//                        changed instance: its changed members whole, "urn:ngsi-ld:null" for a deleted
//                        sub-attribute; neither a new attribute nor a deletion of one (left out)
//   replace  PUT /entities/{id} - the entity as edited
//   create   POST /entities - the entity as edited, its id and type typed in
//
// A kind is chosen when an attribute is added; an existing attribute keeps its kind (a merge cannot
// change it).
//
import { brokerWrite } from './api.js';

export const NULL = 'urn:ngsi-ld:null';

export const KINDS = ['Property', 'Relationship', 'GeoProperty', 'LanguageProperty', 'ListProperty', 'ListRelationship', 'JsonProperty', 'VocabProperty'];

const MEMBER = {
  Property: 'value', Relationship: 'object', GeoProperty: 'value', LanguageProperty: 'languageMap',
  ListProperty: 'valueList', ListRelationship: 'objectList', JsonProperty: 'json', VocabProperty: 'vocab',
};

const ENTITY_CORE = new Set(['id', 'type', '@context', 'scope', 'createdAt', 'modifiedAt', 'deletedAt']);
const SYSTEM = new Set(['createdAt', 'modifiedAt', 'deletedAt', 'instanceId']);   // the broker's: never sent
const STRINGS = new Set(['observedAt', 'unitCode', 'objectType', 'lang']);        // sub-members that are plain strings
const EMBEDDED = new Set(['entity', 'entityList']);                                // a join's: never sent

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls, text, title, onclick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.onclick = onclick;
  return b;
}

function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isAttribute(x) {
  return isObject(x) && typeof x.type === 'string' && KINDS.includes(x.type);
}

//
// canon - JSON with sorted keys: two values compared whatever the order of their members
//
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (isObject(x)) return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}

function same(a, b) {
  return canon(a) === canon(b);
}

//
// instancesOf - an attribute's instances: an array of them, or the one
//
export function instancesOf(v) {
  if (Array.isArray(v) && v.length && v.every(isObject)) return v;
  return isObject(v) ? [v] : [{ type: 'Property', value: v }];
}

function instanceKey(i) {
  return typeof i.datasetId === 'string' ? i.datasetId : '@none';
}

//
// sendable - an attribute (or sub-attribute) without the broker's own members
//
function sendable(x) {
  if (Array.isArray(x)) return x.map(sendable);
  if (!isObject(x)) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (SYSTEM.has(k) || EMBEDDED.has(k)) continue;
    out[k] = isAttribute(v) || Array.isArray(v) ? sendable(v) : v;
  }
  return out;
}

//
// objDiff - what turns 'o' into 'e' as a merge patch: the members that changed (a nested attribute or
// object value as its own diff - a merge descends into it), "urn:ngsi-ld:null" for a member that went;
// an attribute keeps its type and datasetId, so the broker knows what it patches.

// An attribute's fragment also carries its main member (value, object, ...) even when unchanged, and a
// GeoProperty's value whole: the spec's merge needs neither, but a broker that checks a fragment as it
// checks an attribute refuses a Property without a value, or a GeoJSON value without its type.
//
function objDiff(o, e) {
  const r    = {};
  const main = isAttribute(e) ? MEMBER[e.type] : null;

  for (const k of Object.keys(o)) {
    if (SYSTEM.has(k) || EMBEDDED.has(k)) continue;
    if (!(k in e)) r[k] = NULL;
  }
  for (const [k, v] of Object.entries(e)) {
    if (SYSTEM.has(k) || EMBEDDED.has(k)) continue;
    if (k in o && same(o[k], v)) continue;
    const whole = (k === main) && (e.type === 'GeoProperty');
    if (!whole && k in o && isObject(o[k]) && isObject(v) && !(isAttribute(o[k]) && o[k].type !== v.type)) r[k] = objDiff(o[k], v);
    else r[k] = sendable(v);
  }
  if (isAttribute(e)) {
    r.type = e.type;
    if (typeof e.datasetId === 'string') r.datasetId = e.datasetId;
    if (main && !(main in r) && (main in e)) r[main] = sendable(e[main]);
  }
  return r;
}

//
// mergePatch - the merge that turns the attributes of 'orig' into those of 'edit' ({} when nothing changed)
//
export function mergePatch(orig, edit) {
  const patch = {};

  for (const k of Object.keys(orig)) {
    if (ENTITY_CORE.has(k)) continue;
    if (!(k in edit)) patch[k] = NULL;
  }

  for (const [name, v] of Object.entries(edit)) {
    if (ENTITY_CORE.has(name)) continue;
    if (!(name in orig)) { patch[name] = sendable(v); continue; }
    if (same(sendable(orig[name]), sendable(v))) continue;

    const before = new Map(instancesOf(orig[name]).map((i) => [instanceKey(i), i]));
    const after = new Map(instancesOf(v).map((i) => [instanceKey(i), i]));
    const frags = [];

    for (const [key, i] of before) {
      if (after.has(key)) continue;
      frags.push(gone(i, key));
    }
    for (const [key, i] of after) {
      if (!before.has(key)) frags.push(sendable(i));
      else if (!same(sendable(before.get(key)), sendable(i))) frags.push(objDiff(before.get(key), i));
    }
    if (frags.length) patch[name] = frags.length === 1 ? frags[0] : frags;
  }

  return patch;
}

//
// gone - an instance deleted, as a merge and an update say it: its main member "urn:ngsi-ld:null"
//
function gone(i, key) {
  const kind = i.type;
  const g = { type: kind, [MEMBER[kind] || 'value']: kind === 'LanguageProperty' ? { '@none': NULL } : NULL };
  if (key !== '@none') g.datasetId = key;
  return g;
}

//
// changes - per attribute of 'edit' that differs from 'orig': the instances added, changed (with the one
// before) and deleted; and the attributes deleted
//
function changes(orig, edit) {
  const attrs = [];
  const deleted = Object.keys(orig).filter((k) => !ENTITY_CORE.has(k) && !(k in edit));

  for (const [name, v] of Object.entries(edit)) {
    if (ENTITY_CORE.has(name)) continue;
    if (name in orig && same(sendable(orig[name]), sendable(v))) continue;
    const before = new Map(name in orig ? instancesOf(orig[name]).map((i) => [instanceKey(i), i]) : []);
    const after = new Map(instancesOf(v).map((i) => [instanceKey(i), i]));
    const c = { name, isNew: !(name in orig), added: [], changed: [], removed: [] };
    for (const [key, i] of before) if (!after.has(key)) c.removed.push([key, i]);
    for (const [key, i] of after) {
      if (!before.has(key)) c.added.push(i);
      else if (!same(sendable(before.get(key)), sendable(i))) c.changed.push([before.get(key), i]);
    }
    attrs.push(c);
  }
  return { attrs, deleted };
}

//
// attrsBody - Update Attributes (deletes: true) or Append Attributes (deletes: false): each new or changed
// instance whole; with deletes "urn:ngsi-ld:null" for the deleted, else their number in 'left'
//
export function attrsBody(orig, edit, deletes) {
  const { attrs, deleted } = changes(orig, edit);
  const body = {};
  let left = 0;

  for (const k of deleted) {
    if (deletes) body[k] = NULL;
    else ++left;
  }
  for (const c of attrs) {
    const frags = [...c.added.map(sendable), ...c.changed.map(([, i]) => sendable(i))];
    for (const [key, i] of c.removed) {
      if (deletes) frags.push(gone(i, key));
      else ++left;
    }
    if (frags.length) body[c.name] = frags.length === 1 ? frags[0] : frags;
  }
  return { body, left };
}

//
// partialFragment - Partial Attribute Update of one instance: the members that changed, whole (the
// broker replaces them, it does not merge into them), "urn:ngsi-ld:null" for one that went; its type,
// datasetId and main member always
//
function partialFragment(o, e) {
  const r = {};
  const main = MEMBER[e.type];

  for (const k of Object.keys(o)) {
    if (SYSTEM.has(k) || EMBEDDED.has(k)) continue;
    if (!(k in e)) r[k] = NULL;
  }
  for (const [k, v] of Object.entries(e)) {
    if (SYSTEM.has(k) || EMBEDDED.has(k)) continue;
    if (!(k in o) || !same(o[k], v)) r[k] = sendable(v);
  }
  r.type = e.type;
  if (typeof e.datasetId === 'string') r.datasetId = e.datasetId;
  if (main && !(main in r) && (main in e)) r[main] = sendable(e[main]);
  return r;
}

//
// partials - one Partial Attribute Update per changed instance; what it cannot send - a new attribute or
// instance, a deleted attribute or instance - counted in 'left'
//
export function partials(orig, edit) {
  const { attrs, deleted } = changes(orig, edit);
  const list = [];
  let left = deleted.length;

  for (const c of attrs) {
    left += c.added.length + c.removed.length;
    for (const [o, e] of c.changed) list.push({ name: c.name, body: partialFragment(o, e) });
  }
  return { list, left };
}

//
// shortName - an attribute name as a broker's UpdateResult gives it, expanded: without the default @vocab
//
function shortName(n) {
  return n.startsWith('https://uri.etsi.org/ngsi-ld/default-context/') ? n.slice(45) : n;
}

//
// SAVE_AS - how an edit is saved: the label, and what an append or a partial update leaves out
//
const SAVE_AS = {
  merge:    'Merge - PATCH /entities/{id}',
  update:   'Update attributes - PATCH …/attrs',
  append:   'Append attributes - POST …/attrs',
  appendNo: 'Append, no overwrite - POST …/attrs?options=noOverwrite',
  partial:  'Partial attribute update - PATCH …/attrs/{attrId}, one per instance',
};

//
// fresh - a new attribute instance of 'kind', with an empty value of the kind
//
function fresh(kind) {
  switch (kind) {
  case 'Relationship':     return { type: kind, object: '' };
  case 'GeoProperty':      return { type: kind, value: { type: 'Point', coordinates: [0, 0] } };
  case 'LanguageProperty': return { type: kind, languageMap: { en: '' } };
  case 'ListProperty':     return { type: kind, valueList: [] };
  case 'ListRelationship': return { type: kind, objectList: [] };
  case 'JsonProperty':     return { type: kind, json: {} };
  case 'VocabProperty':    return { type: kind, vocab: '' };
  default:                 return { type: 'Property', value: '' };
  }
}

function jsonType(v) {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'text';
  return 'json';
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

//
// EntityEditor - the panel, over the graph's right side (the graph stays usable: a target can be picked)
//
export class EntityEditor {
  //
  // root: the panel's element; toast(text); onSaved(id, mode); pick(prompt, done): the next entity clicked
  // in the graph or on the map goes to done(id) (done(null): cancelled)
  //
  // pickPoint(done): the next point clicked on the map goes to done([lon, lat]); pick(null, null) cancels
  // either
  //
  constructor({ root, toast, onSaved, pick, pickPoint }) {
    this.root = root;
    this.toast = toast;
    this.onSaved = onSaved;
    this.pickFn = pick;
    this.pickPointFn = pickPoint;
    this.isOpen = false;

    root.textContent = '';
    const head = el('div', 'ehead');
    this.title = el('span', 'etitle');
    this.modeLabel = el('span', 'emode');
    this.saveBtn = button('btn primary', 'Save', 'Save - send the request below', () => this.save());
    head.append(this.title, this.modeLabel, this.saveBtn, button('btn', 'Cancel', 'Close without saving', () => this.close()));

    this.idRow = el('div', 'eidrow');
    this.body = el('div', 'ebody');
    const foot = el('div', 'efoot');
    this.err = el('div', 'eerr');
    this.err.hidden = true;
    this.saveAs = 'merge';                       // kept from one edit to the next
    this.asRow = el('label', 'eas');
    this.asSel = el('select');
    for (const [k, label] of Object.entries(SAVE_AS)) {
      const o = el('option', null, label);
      o.value = k;
      this.asSel.append(o);
    }
    this.asSel.onchange = () => { this.saveAs = this.asSel.value; this.err.hidden = true; this.refresh(); };
    this.asRow.append(el('span', null, 'Save as'), this.asSel);
    this.req = el('details', 'ereq');
    this.reqSum = el('summary');
    this.reqPre = el('pre');
    this.req.append(this.reqSum, this.reqPre);
    foot.append(this.asRow, this.err, this.req);
    root.append(head, this.idRow, this.body, foot);

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.picking) { this.pickCancel(); return; }
      if (this.dirty() && !this.escArmed) {
        this.escArmed = true;
        this.toast('Unsaved changes - Esc again to close without saving');
        setTimeout(() => { this.escArmed = false; }, 2500);
        return;
      }
      this.close();
    });
  }

  //
  // open - mode 'edit' or 'replace' (entity: as the broker returned it), or 'create' (entity: a start -
  // {id, type, ...}); focus: an attribute name to open and focus; names: attribute names to offer
  //
  // types: entity types to offer for a create; typeAttrs(type): [[name, kind, a value]] - the attributes
  // the loaded entities of a type have, offered as a start (a Property with the value's JSON type)
  //
  open({ broker, entity, mode = 'edit', focus = null, names = [], types = [], typeAttrs = () => [] }) {
    this.broker = broker;
    this.mode = mode;
    this.names = names;
    this.types = types;
    this.typeAttrs = typeAttrs;
    this.orig = clone(entity);
    this.work = {};
    for (const [k, v] of Object.entries(entity)) {
      if (ENTITY_CORE.has(k)) continue;
      this.work[k] = clone(instancesOf(v));
    }
    this.id = entity.id || '';
    this.type = Array.isArray(entity.type) ? entity.type.join(',') : (entity.type || '');
    this.deleted = new Set();                    // "name#i" and "name#i/sub" paths
    this.added = new Set();                      // "name#i" of instances added here
    this.expanded = new Set(focus ? Object.keys(this.work).filter((k) => k === focus).map((k) => k + '#0') : []);
    this.bad = new Set();                        // paths whose input does not parse
    this.escArmed = false;

    this.title.textContent = mode === 'create' ? 'New entity' : this.id;
    this.title.title = this.id;
    this.modeLabel.textContent = { edit: 'edit', replace: 'replace', create: 'create' }[mode];
    this.asRow.hidden = mode !== 'edit';
    this.asSel.value = this.saveAs;
    this.err.hidden = true;
    this.req.open = false;
    this.root.hidden = false;
    this.isOpen = true;

    this.renderIds();
    this.render();

    const target = focus ? this.body.querySelector(`[data-attr="${CSS.escape(focus)}"] input, [data-attr="${CSS.escape(focus)}"] textarea`) : null;
    (target || this.body.querySelector('input, textarea, select, button') || this.saveBtn).focus({ preventScroll: false });
  }

  close() {
    if (!this.isOpen) return;
    this.pickCancel();
    this.isOpen = false;
    this.root.hidden = true;
  }

  //
  // The entity as edited: the instances not deleted, one instance as the attribute itself
  //
  edited() {
    const attrs = {};
    for (const [name, list] of Object.entries(this.work)) {
      const kept = [];
      list.forEach((inst, ix) => {
        const p = name + '#' + ix;
        if (this.deleted.has(p)) return;
        const copy = {};
        for (const [k, v] of Object.entries(inst)) if (!this.deleted.has(p + '/' + k)) copy[k] = v;
        kept.push(copy);
      });
      if (kept.length) attrs[name] = kept.length === 1 ? kept[0] : kept;
    }
    return attrs;
  }

  origAttrs() {
    const out = {};
    for (const [k, v] of Object.entries(this.orig)) if (!ENTITY_CORE.has(k)) out[k] = v;
    return out;
  }

  //
  // request - what Save sends: { requests: [{ method, path, body }], count, left } - count: the attributes
  // in it (an edit's), left: the changes the edit's "Save as" cannot send
  //
  request() {
    const attrs = this.edited();
    const path = '/ngsi-ld/v1/entities' + (this.mode === 'create' ? '' : '/' + encodeURIComponent(this.id));
    const types = this.type.split(',').map((t) => t.trim()).filter(Boolean);
    const whole = { id: this.id, type: types.length === 1 ? types[0] : types, ...sendable(attrs) };
    const orig = this.origAttrs();

    if (this.mode !== 'edit') return { requests: [{ method: this.mode === 'create' ? 'POST' : 'PUT', path, body: whole }], count: 1, left: 0 };

    if (this.saveAs === 'partial') {
      const { list, left } = partials(orig, attrs);
      const requests = list.map((x) => ({ method: 'PATCH', path: path + '/attrs/' + encodeURIComponent(x.name), body: x.body }));
      return { requests, count: requests.length, left };
    }
    if (this.saveAs === 'merge') {
      const body = mergePatch(orig, attrs);
      return { requests: [{ method: 'PATCH', path, body }], count: Object.keys(body).length, left: 0 };
    }
    const { body, left } = attrsBody(orig, attrs, this.saveAs === 'update');
    const method = this.saveAs === 'update' ? 'PATCH' : 'POST';
    const query = this.saveAs === 'appendNo' ? '?options=noOverwrite' : '';
    return { requests: [{ method, path: path + '/attrs' + query, body }], count: Object.keys(body).length, left };
  }

  dirty() {
    if (!this.isOpen) return false;
    if (this.mode !== 'edit') return true;
    const r = this.request();
    return r.count + r.left > 0;
  }

  //
  // refresh - after an input: the request shown, Save enabled or not, the rows marked changed
  //
  refresh() {
    const r = this.request();
    const empty = this.mode === 'edit' && r.count === 0;
    const leftOut = r.left ? `${r.left} change${r.left === 1 ? '' : 's'} left out - ${this.saveAs === 'partial' ? 'a partial update neither adds nor deletes an attribute or an instance' : 'an append cannot delete'}` : '';
    const one = r.requests[0];
    if (empty) this.reqSum.textContent = leftOut || 'Nothing changed yet';
    else if (r.requests.length > 1) this.reqSum.textContent = `${r.requests.length} requests: PATCH …/attrs/{attrId}` + (leftOut ? ` (${leftOut})` : '');
    else this.reqSum.textContent = `The request: ${one.method} ${decodeURIComponent(one.path)}${this.mode === 'edit' ? `  (${r.count} attribute${r.count === 1 ? '' : 's'})` : ''}` + (leftOut ? ` - ${leftOut}` : '');
    this.reqPre.textContent = empty ? '' : r.requests.map((q) => (r.requests.length > 1 ? `${q.method} ${decodeURIComponent(q.path)}\n` : '') + JSON.stringify(q.body, null, 2)).join('\n\n');
    const idBad = this.mode !== 'edit' && (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(this.id) || !this.type.trim());
    this.saveBtn.disabled = empty || this.bad.size > 0 || idBad;
    this.saveBtn.title = this.bad.size ? 'An input does not parse - it is marked' : (idBad ? 'An id (a URI) and a type are needed' : 'Save - send the request below');

    const before = this.origAttrs();
    for (const row of this.body.querySelectorAll('.erow[data-path]')) {
      const p = row.dataset.path;
      const [name, ix] = p.split('#');
      const inst = (this.work[name] || [])[+ix];
      let changed = false;
      if (this.added.has(p)) changed = true;
      else if (inst && name in before) {
        const o = instancesOf(before[name]).find((i) => instanceKey(i) === instanceKey(inst));
        changed = !o || !same(sendable(o), sendable(inst));
      }
      row.classList.toggle('changed', changed && !this.deleted.has(p));
    }
  }

  //
  // renderIds - the id and type: typed in for a create, shown for the others
  //
  renderIds() {
    this.idRow.textContent = '';
    if (this.mode !== 'create') {
      this.idRow.append(el('span', 'k', 'type'), el('span', 'mono', this.type));
      return;
    }
    const id = el('input', 'mono');
    id.placeholder = 'urn:ngsi-ld:Vehicle:A';
    id.value = this.id;
    id.setAttribute('aria-label', 'Entity id');
    id.spellcheck = false;
    id.oninput = () => { this.id = id.value.trim(); this.refresh(); };
    const type = el('input', 'mono');
    type.placeholder = 'Vehicle';
    type.value = this.type;
    type.setAttribute('aria-label', 'Entity type');
    type.spellcheck = false;
    const dl = el('datalist');
    dl.id = 'ed-types';
    for (const t of this.types) { const o = el('option'); o.value = t; dl.append(o); }
    type.setAttribute('list', 'ed-types');

    //
    // ＋ the attributes of the type: what its loaded entities have, each empty of its kind
    //
    const start = button('btn small', '', '', () => {
      for (const [n, k, sample] of this.typeAttrs(this.type.trim())) {
        if (n in this.work) continue;
        const i = fresh(k);
        if (k === 'Property' && sample !== undefined) i.value = { number: 0, boolean: false, text: '', json: {} }[jsonType(sample)];
        this.work[n] = [i];
        this.added.add(n + '#0');
      }
      this.render();
      startShow();
    });
    const startShow = () => {
      const t = this.type.trim();
      const attrs = this.typeAttrs(t).filter(([n]) => !(n in this.work));
      start.hidden = attrs.length === 0;
      start.textContent = `＋ ${t}'s attributes (${attrs.length})`;
      start.setAttribute('aria-label', `Add the attributes ${t}'s loaded entities have: ${attrs.map(([n]) => n).join(', ')}`);
      start.title = attrs.map(([n, k]) => `${n} - ${k}`).join('\n');
    };
    type.oninput = () => {
      this.type = type.value;
      if (!id.value.trim() && /^[A-Za-z][\w-]*$/.test(this.type.trim())) id.placeholder = `urn:ngsi-ld:${this.type.trim()}:1`;
      startShow();
      this.refresh();
    };
    this.idRow.append(el('span', 'k', 'id'), id, el('span', 'k', 'type'), type, dl, start);
    startShow();
  }

  render() {
    const top = this.body.scrollTop;
    this.body.textContent = '';
    for (const [name, list] of Object.entries(this.work)) {
      list.forEach((inst, ix) => this.body.append(this.instanceRow(name, inst, ix, list.length > 1)));
    }
    if (!Object.keys(this.work).length) this.body.append(el('p', 'enone', 'No attributes.'));
    this.body.append(this.addForm(null));
    this.body.scrollTop = top;
    this.refresh();
  }

  //
  // instanceRow - an attribute instance: name, kind, its input, 🗑; opened: its sub-attributes and ＋
  //
  instanceRow(name, inst, ix, several) {
    const p = name + '#' + ix;
    const gone = this.deleted.has(p);
    const row = el('div', 'erow');
    row.dataset.path = p;
    row.dataset.attr = name;
    if (gone) row.classList.add('gone');

    const line = el('div', 'eline');
    const open = this.expanded.has(p);
    const caret = button('ecaret', open ? '▾' : '▸', open ? 'Close the sub-attributes' : 'Open the sub-attributes', () => {
      if (open) this.expanded.delete(p); else this.expanded.add(p);
      this.render();
    });
    caret.setAttribute('aria-expanded', String(open));
    const subs = Object.keys(inst).filter((k) => !['type', MEMBER[inst.type], 'datasetId'].includes(k) && !SYSTEM.has(k) && !EMBEDDED.has(k));
    if (subs.length) caret.dataset.n = subs.length;

    line.append(caret, el('span', 'ename', name), el('span', 'ekind', inst.type));
    if (several || typeof inst.datasetId === 'string') line.append(el('span', 'eds', typeof inst.datasetId === 'string' ? inst.datasetId : 'default instance'));
    line.append(gone
      ? button('ebin', '↺', `Restore ${name}`, () => { this.deleted.delete(p); this.render(); })
      : button('ebin', '🗑', `Delete ${name}${several ? ' - this instance' : ''}`, () => this.remove(name, ix)));
    row.append(line);

    if (!gone) row.append(this.valueInput(inst, p, inst.type));

    if (open && !gone) {
      const box = el('div', 'esubs');
      for (const k of subs) box.append(this.subRow(inst, k, p));
      box.append(this.addForm(inst, p));
      row.append(box);
    }
    return row;
  }

  remove(name, ix) {
    const p = name + '#' + ix;
    if (this.added.has(p)) {
      //
      // Added here: it simply goes (the later instances' paths move down by one)
      //
      this.work[name].splice(ix, 1);
      if (!this.work[name].length) delete this.work[name];
      this.reindex(name, ix);
    } else {
      this.deleted.add(p);
    }
    this.render();
  }

  reindex(name, from) {
    const move = (set) => {
      const out = new Set();
      for (const q of set) {
        const m = q.match(/^(.*)#(\d+)(\/.*)?$/);
        if (!m || m[1] !== name || +m[2] < from) out.add(q);
        else if (+m[2] > from) out.add(`${name}#${+m[2] - 1}${m[3] || ''}`);
      }
      return out;
    };
    this.added = move(this.added);
    this.deleted = move(this.deleted);
    this.expanded = move(this.expanded);
    this.bad = move(this.bad);
  }

  //
  // subRow - a sub-attribute: a plain string member (observedAt, unitCode, objectType), or an attribute
  //
  subRow(inst, k, p) {
    const sp = p + '/' + k;
    const gone = this.deleted.has(sp);
    const row = el('div', 'esub');
    if (gone) row.classList.add('gone');
    const v = inst[k];
    row.append(el('span', 'ename', k));

    if (gone) {
      row.append(el('span', 'ekind', ''), button('ebin', '↺', `Restore ${k}`, () => { this.deleted.delete(sp); this.render(); }));
      return row;
    }

    if (STRINGS.has(k) || !isAttribute(v)) {
      row.append(el('span', 'ekind', k === 'observedAt' ? 'DateTime' : 'text'));
      const input = el('input', 'mono');
      input.value = typeof v === 'string' ? v : JSON.stringify(v);
      input.spellcheck = false;
      input.setAttribute('aria-label', k);
      input.oninput = () => {
        inst[k] = input.value;
        const bad = k === 'observedAt' && Number.isNaN(Date.parse(input.value));
        this.mark(sp, input, bad);
      };
      const cell = el('div', 'ecell');
      cell.append(input);
      if (k === 'observedAt') cell.append(button('btn small', 'now', 'Now, in UTC', () => { input.value = nowIso(); input.oninput(); }));
      row.append(cell);
    } else {
      row.append(el('span', 'ekind', v.type), this.valueInput(v, sp, v.type));
    }
    row.append(button('ebin', '🗑', `Delete ${k}`, () => { this.deleted.add(sp); this.render(); }));
    return row;
  }

  mark(path, input, bad) {
    if (bad) this.bad.add(path); else this.bad.delete(path);
    input.classList.toggle('bad', bad);
    this.refresh();
  }

  //
  // valueInput - the kind's input for an attribute 'a' (an instance or a sub-attribute), writing into it
  //
  valueInput(a, path, kind) {
    const cell = el('div', 'ecell');
    const member = MEMBER[kind] || 'value';

    const textIn = (value, label, onval) => {
      const i = el('input', 'mono');
      i.value = value;
      i.spellcheck = false;
      i.setAttribute('aria-label', label);
      i.oninput = () => onval(i);
      return i;
    };

    const jsonArea = (value, label, onval) => {
      const t = el('textarea', 'mono');
      t.value = JSON.stringify(value, null, 2);
      t.rows = Math.min(10, Math.max(2, t.value.split('\n').length));
      t.spellcheck = false;
      t.setAttribute('aria-label', label);
      t.oninput = () => {
        let v;
        try { v = JSON.parse(t.value); } catch { this.mark(path, t, true); return; }
        onval(v);
        this.mark(path, t, false);
      };
      return t;
    };

    switch (kind) {
    case 'Relationship': {
      const i = textIn(a.object || '', 'Target entity id', (x) => { a.object = x.value.trim(); this.mark(path, x, !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(a.object)); });
      cell.append(i, button('btn small', 'pick in graph', 'Click the target entity in the graph or on the map', () => {
        this.pick('Click the target entity…', (id) => { if (id) { i.value = id; i.oninput(); } });
      }));
      return cell;
    }

    case 'GeoProperty': {
      const g = a.value;
      if (isObject(g) && g.type === 'Point' && Array.isArray(g.coordinates)) {
        const lon = textIn(String(g.coordinates[0]), 'Longitude', (x) => num(x, 0));
        const lat = textIn(String(g.coordinates[1]), 'Latitude', (x) => num(x, 1));
        const num = (x, at) => {
          const n = Number(x.value);
          const ok = x.value.trim() !== '' && Number.isFinite(n) && (at === 0 ? Math.abs(n) <= 180 : Math.abs(n) <= 90);
          if (ok) g.coordinates[at] = n;
          this.mark(path + '@' + at, x, !ok);
        };
        lon.classList.add('short');
        lat.classList.add('short');
        cell.append(el('span', 'elab', 'lon'), lon, el('span', 'elab', 'lat'), lat);
        if (this.pickPointFn) {
          cell.append(button('btn small', 'pick on map', 'Click the point on the map', () => {
            this.pointPick((ll) => { if (ll) { lon.value = String(ll[0]); lat.value = String(ll[1]); lon.oninput(); lat.oninput(); } });
          }));
        }
        return cell;
      }
      cell.append(jsonArea(g, 'GeoJSON geometry', (v) => { a.value = v; }));
      return cell;
    }

    case 'LanguageProperty': {
      const map = isObject(a.languageMap) ? a.languageMap : (a.languageMap = {});
      const list = el('div', 'elist');
      const draw = () => {
        list.textContent = '';
        for (const lang of Object.keys(map)) {
          const r = el('div', 'eitem');
          const l = textIn(lang, 'Language', (x) => {
            const nl = x.value.trim();
            if (!nl || (nl !== lang && nl in map)) { this.mark(path + '@' + lang, x, true); return; }
            const val = map[lang];
            delete map[lang];
            map[nl] = val;
            this.mark(path + '@' + lang, x, false);
            draw();
          });
          l.classList.add('short');
          l.onchange = l.oninput;
          l.oninput = null;
          const t = textIn(map[lang], 'Text in ' + lang, (x) => { map[lang] = x.value; this.refresh(); });
          r.append(l, t, button('ebin', '✕', 'Remove ' + lang, () => { delete map[lang]; draw(); this.refresh(); }));
          list.append(r);
        }
        list.append(button('eplus', '＋ language', 'Add a language', () => {
          let n = 'xx';
          for (let i = 1; n in map; i++) n = 'xx' + i;
          map[n] = '';
          draw();
          this.refresh();
        }));
      };
      draw();
      cell.append(list);
      return cell;
    }

    case 'ListProperty':
    case 'ListRelationship': {
      const rel = kind === 'ListRelationship';
      const arr = Array.isArray(a[member]) ? a[member] : (a[member] = []);
      const list = el('div', 'elist');
      const draw = () => {
        list.textContent = '';
        arr.forEach((item, i) => {
          const r = el('div', 'eitem');
          const shown = rel ? (isObject(item) ? item.object || '' : String(item)) : (typeof item === 'string' ? item : JSON.stringify(item));
          const input = textIn(shown, `Item ${i + 1}`, (x) => {
            if (rel) arr[i] = { object: x.value.trim() };
            else { try { arr[i] = JSON.parse(x.value); } catch { arr[i] = x.value; } }
            this.refresh();
          });
          r.append(input, button('ebin', '✕', `Remove item ${i + 1}`, () => { arr.splice(i, 1); draw(); this.refresh(); }));
          if (rel) r.insertBefore(button('btn small', 'pick', 'Click the target in the graph', () => {
            this.pick('Click the target entity…', (id) => { if (id) { input.value = id; input.oninput(); } });
          }), r.lastChild);
          list.append(r);
        });
        list.append(button('eplus', '＋ item', 'Add an item', () => { arr.push(rel ? { object: '' } : ''); draw(); this.refresh(); }));
      };
      draw();
      cell.append(list);
      return cell;
    }

    case 'JsonProperty':
      cell.append(jsonArea(a.json, 'JSON', (v) => { a.json = v; }));
      return cell;

    case 'VocabProperty':
      cell.append(textIn(a.vocab || '', 'Vocabulary term', (x) => { a.vocab = x.value; this.refresh(); }));
      return cell;

    default: {
      //
      // A Property: its value with its JSON type
      //
      const sel = el('select', 'etype');
      sel.setAttribute('aria-label', 'JSON type');
      for (const t of ['number', 'text', 'boolean', 'json']) {
        const o = el('option', null, t);
        o.value = t;
        sel.append(o);
      }
      sel.value = jsonType(a.value);
      const holder = el('span', 'eholder');
      const draw = () => {
        holder.textContent = '';
        this.bad.delete(path);
        const t = sel.value;
        if (t === 'boolean') {
          const b = el('select');
          b.setAttribute('aria-label', 'Value');
          for (const x of ['true', 'false']) { const o = el('option', null, x); o.value = x; b.append(o); }
          b.value = a.value === false ? 'false' : 'true';
          b.onchange = () => { a.value = b.value === 'true'; this.refresh(); };
          holder.append(b);
        } else if (t === 'json') {
          holder.append(jsonArea(isObject(a.value) || Array.isArray(a.value) ? a.value : {}, 'Value (JSON)', (v) => { a.value = v; }));
        } else {
          const i = textIn(a.value === undefined || isObject(a.value) || Array.isArray(a.value) ? '' : String(a.value), 'Value', (x) => {
            if (t === 'number') {
              const n = Number(x.value);
              const ok = x.value.trim() !== '' && Number.isFinite(n);
              if (ok) a.value = n;
              this.mark(path, x, !ok);
            } else {
              a.value = x.value;
              this.refresh();
            }
          });
          holder.append(i);
        }
      };
      sel.onchange = () => {
        //
        // Another JSON type: the value converted where it can be
        //
        const t = sel.value;
        if (t === 'number') a.value = Number.isFinite(Number(a.value)) ? Number(a.value) : 0;
        else if (t === 'text') a.value = isObject(a.value) || Array.isArray(a.value) ? JSON.stringify(a.value) : String(a.value ?? '');
        else if (t === 'boolean') a.value = a.value === true || a.value === 'true';
        else if (!isObject(a.value) && !Array.isArray(a.value)) a.value = {};
        draw();
        this.refresh();
      };
      draw();
      cell.append(sel, holder);
      return cell;
    }
    }
  }

  //
  // addForm - ＋ attribute (inst null), or ＋ sub-attribute of 'inst' at 'path'
  //
  addForm(inst, path) {
    const wrap = el('div', inst ? 'eadd sub' : 'eadd');
    const opener = button('eplus', inst ? '＋ sub-attribute' : '＋ attribute', inst ? 'Add a sub-attribute' : 'Add an attribute', () => {
      wrap.textContent = '';
      const name = el('input', 'mono');
      name.placeholder = 'name';
      name.spellcheck = false;
      name.setAttribute('aria-label', 'Name');
      const listId = 'ed-names-' + Math.random().toString(36).slice(2);
      const dl = el('datalist');
      dl.id = listId;
      for (const n of inst ? ['observedAt', 'unitCode', 'objectType'] : this.names) { const o = el('option'); o.value = n; dl.append(o); }
      name.setAttribute('list', listId);
      const kind = el('select');
      kind.setAttribute('aria-label', 'Kind');
      for (const k of inst ? ['Property', 'Relationship', 'text'] : KINDS) { const o = el('option', null, k); o.value = k; kind.append(o); }
      const ds = el('input', 'mono');
      ds.placeholder = 'datasetId (optional)';
      ds.spellcheck = false;
      ds.setAttribute('aria-label', 'datasetId');
      const go = button('btn small primary', 'Add', 'Add it', () => {
        const n = name.value.trim();
        if (!n || /[\s"<>]/.test(n)) { name.classList.add('bad'); name.focus(); return; }
        if (inst) {
          if (n in inst) { name.classList.add('bad'); this.toast(`${n} is there already`); return; }
          inst[n] = STRINGS.has(n) || kind.value === 'text' ? (n === 'observedAt' ? nowIso() : '') : fresh(kind.value);
          this.render();
          return;
        }
        const d = ds.value.trim();
        const list = this.work[n] || [];
        if (list.some((i) => instanceKey(i) === (d || '@none'))) {
          name.classList.add('bad');
          this.toast(d ? `${n} has an instance ${d} already` : `${n} is there already - give the new instance a datasetId`);
          return;
        }
        const i = fresh(kind.value);
        if (d) i.datasetId = d;
        list.push(i);
        this.work[n] = list;
        const p = n + '#' + (list.length - 1);
        this.added.add(p);
        this.render();
        const row = this.body.querySelector(`[data-path="${CSS.escape(p)}"]`);
        const first = row && (row.querySelector('.ecell input, .ecell textarea') || row.querySelector('.ecell select'));
        if (first) first.focus();
      });
      const cancel = button('btn small', 'Cancel', 'Cancel', () => { wrap.textContent = ''; wrap.append(opener); opener.focus(); });
      name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
      wrap.append(dl, name, kind);
      if (!inst) wrap.append(ds);
      wrap.append(go, cancel);
      name.focus();
    });
    wrap.append(opener);
    return wrap;
  }

  //
  // pick - the next entity clicked in the graph or on the map, for a target
  //
  pick(prompt, done) {
    this.picking = done;
    this.root.classList.add('picking');
    this.toast(prompt + ' (Esc cancels)');
    this.pickFn(prompt, (id) => {
      const d = this.picking;
      this.picking = null;
      this.root.classList.remove('picking');
      if (d) d(id);
    });
  }

  pointPick(done) {
    this.picking = done;
    this.root.classList.add('picking');
    this.toast('Click the point on the map… (Esc cancels)');
    this.pickPointFn((ll) => {
      const d = this.picking;
      this.picking = null;
      this.root.classList.remove('picking');
      if (d) d(ll);
    });
  }

  pickCancel() {
    if (!this.picking) return;
    const d = this.picking;
    this.picking = null;
    this.root.classList.remove('picking');
    this.pickFn(null, null);
    d(null);
  }

  //
  // save - the request, and its answer: closed on success, the broker's errors shown otherwise
  //
  async save() {
    if (this.saveBtn.disabled) return;
    const r = this.request();
    this.saveBtn.disabled = true;
    this.err.hidden = true;
    this.err.textContent = '';

    //
    // One request after the other (a partial update's are one per instance): the first that fails ends it,
    // what was sent before it stays done
    //
    let done = 0;
    let partly = false;
    for (const q of r.requests) {
      const a = await brokerWrite(this.broker, q.method, q.path, q.body);
      const what = r.requests.length > 1 ? decodeURIComponent(q.path.slice(q.path.lastIndexOf('/') + 1)) + ' - ' : '';
      if (a.ok && a.status !== 207) { ++done; continue; }
      if (a.status === 207 && a.body) {
        partly = true;
        this.err.append(el('strong', null, what + 'Partly done (207):'));
        for (const x of [].concat(a.body.notUpdated || [], a.body.errors || [])) {
          this.err.append(el('div', null, `${shortName(x.attributeName || (x.entityId || ''))}: ${(x.reason || (x.error && (x.error.title + ' - ' + (x.error.detail || ''))) || JSON.stringify(x))}`));
        }
        ++done;
        continue;
      }
      const b = a.body || {};
      const head = a.reached === false ? 'c³ could not send it' : `The broker answered ${a.status}`;
      if (done > 0) this.err.append(el('div', 'muted', `${done} of ${r.requests.length} requests done before it.`));
      this.err.append(el('strong', null, what + head + ':'), el('div', null, [b.title, b.detail].filter(Boolean).join(' - ') || ''));
      if (a.status === 401) this.err.append(el('div', 'muted', 'The broker wants an access token - Token, beside Connect.'));
      if (a.status === 403) this.err.append(el('div', 'muted', 'The broker does not allow this request with the token sent.'));
      if (done > 0) this.onSaved(this.id, this.mode);
      this.err.hidden = false;
      this.refresh();
      return;
    }

    if (!partly) {
      const id = this.id;
      this.close();
      this.toast({ edit: 'Saved', replace: 'Replaced', create: 'Created' }[this.mode] + ' - ' + id);
      this.onSaved(id, this.mode);
      return;
    }
    this.onSaved(this.id, this.mode);
    this.err.hidden = false;
    this.refresh();
  }
}
