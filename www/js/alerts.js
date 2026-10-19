//
// alerts.js - Connect's alerts: rules (a type and a q, a title, a severity) per broker, and the alarms they raise
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Each rule is a subscription the backend makes on the broker (live.js setAlerts); its notification raises
// an alarm for each entity in it: a toast, a row in the alarm list, the entity ringed on the map. An alarm
// already raised is not raised again while it lasts. It clears when the live values show the entity no
// longer matching the rule's q - evaluated here for the simple forms: terms joined by ';' (and), each
// <attribute><op><value> (an attribute's name, not a path), op one of == != > < >= <=, value a "string", a number, true or false. A rule
// whose q is beyond that clears by hand (Clear).
//
// The entities loaded that already match a rule are alarms from the start, without a toast.
//
// The rules are kept in the configuration, per broker (PUT /api/brokers/connect {"alerts"}); a named demo's
// descriptor gives a broker its first ones.
//
import * as api from './api.js';
import { shortId } from './ngsild.js';
import { nameOf } from './map.js';

export const SEVERITY = { critical: '#FF4D5E', warning: '#F2B84B', info: '#5FB4E8' };
const TOAST_MS = 7000;
const TOASTS_MAX = 4;

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// parseQ - the simple forms of a q, as [{attr, op, value}]; null: not one of them
//
export function parseQ(q) {
  if (!q) return [];
  const terms = [];
  for (const part of q.split(';')) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/.exec(part);
    if (!m) return null;
    const raw = m[3];
    let value;
    if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) value = JSON.parse(raw);
    else if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) value = Number(raw);
    else if (raw === 'true' || raw === 'false') value = raw === 'true';
    else return null;
    terms.push({ attr: m[1], op: m[2], value });
  }
  return terms;
}

const valueOf = (v) => {
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') return 'value' in v ? v.value : 'vocab' in v ? v.vocab : 'object' in v ? v.object : undefined;
  return v;
};

//
// matches - an entity against parsed terms; an attribute it does not have matches nothing
//
export function matches(e, terms) {
  for (const t of terms) {
    const v = valueOf(e[t.attr]);
    if (v === undefined) return false;
    let ok;
    if (t.op === '==') ok = v === t.value;
    else if (t.op === '!=') ok = v !== t.value;
    else if (typeof v !== typeof t.value || (typeof v !== 'number' && typeof v !== 'string')) ok = false;
    else if (t.op === '>') ok = v > t.value;
    else if (t.op === '<') ok = v < t.value;
    else if (t.op === '>=') ok = v >= t.value;
    else ok = v <= t.value;
    if (!ok) return false;
  }
  return true;
}

const typeName = (t) => {
  const m = String(t).match(/[#/]([^#/]+)$/);
  return m && /^https?:/.test(t) ? m[1] : String(t);
};
const isOfType = (e, type) => (Array.isArray(e.type) ? e.type : [e.type]).some((t) => t === type || typeName(t) === type);

export class Alerts {
  //
  // live: the Live (setAlerts); entity(id): the loaded entity; onJump(id): show it; onChange(): the map's rings
  //
  constructor({ live, entity, onJump, onChange }) {
    this.live = live;
    this.entity = entity;
    this.onJump = onJump;
    this.onChange = onChange;
    this.broker = null;
    this.tenant = '';
    this.rules = [];                             // [{id, title, severity, type, q}]
    this.parsed = new Map();                     // rule id -> terms, null: not evaluable here
    this.failed = new Map();                     // rule id -> why the broker refused its subscription
    this.alarms = new Map();                     // rule|entity -> {rule, id, at, last, acked}

    $('alarm-btn').onclick = () => ($('alarmpop').hidden ? this.open() : this.close());
    $('al-close').onclick = () => this.close();
    $('al-rules-btn').onclick = () => { $('al-rules').hidden = !$('al-rules').hidden; this.render(); };
    $('al-ackall').onclick = () => { for (const a of this.alarms.values()) a.acked = true; this.changed(); };
    $('al-form').onsubmit = (e) => { e.preventDefault(); this.addRule(); };
    $('alarmpop').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  //
  // setBroker - the broker connected to and its rules: the alarms of another one forgotten
  //
  setBroker(broker, tenant, rules) {
    if (broker !== this.broker || tenant !== this.tenant) this.alarms.clear();
    this.broker = broker;
    this.tenant = tenant || '';
    this.setRules(rules || [], false);
  }

  setRules(rules, save) {
    this.rules = rules.map((r) => ({ id: r.id, title: r.title || r.id, severity: SEVERITY[r.severity] ? r.severity : 'warning', type: r.type, q: r.q || '' }));
    this.parsed = new Map(this.rules.map((r) => [r.id, parseQ(r.q)]));
    this.failed = new Map();
    const ids = new Set(this.rules.map((r) => r.id));
    for (const [k, a] of this.alarms) if (!ids.has(a.rule)) this.alarms.delete(k);
    if (this.broker) this.live.setAlerts(this.broker, this.tenant, this.rules);
    if (save && this.broker) api.brokerConnect(this.broker, { alerts: this.rules }).catch((e) => console.warn('c3: the alert rules were not saved:', e.message));
    this.changed();
  }

  //
  // installed - the backend's word on the rules' subscriptions
  //
  installed(m) {
    this.failed = new Map((m.failed || []).map((f) => [f.rule, f.detail]));
    this.render();
  }

  //
  // scan - the entities loaded: those that match a rule are alarms, quietly (they were before c³ looked)
  //
  scan(entities) {
    for (const r of this.rules) {
      const terms = this.parsed.get(r.id);
      if (!terms) continue;
      for (const e of entities) if (isOfType(e, r.type) && matches(e, terms)) this.raise(r, e, { quiet: true });
    }
    this.changed();
  }

  //
  // notified - an alert rule's notification: an alarm for each entity in it that matches (as far as can be told)
  //
  notified(ruleId, entities) {
    const r = this.rules.find((x) => x.id === ruleId);
    if (!r) return;
    const terms = this.parsed.get(r.id);
    for (const n of entities) {
      const e = { ...(this.entity(n.id) || {}), ...n };
      if (n.deletedAt) continue;
      if (terms && !matches(e, terms)) continue;
      this.raise(r, e, { quiet: false });
    }
    this.changed();
  }

  raise(r, e, { quiet }) {
    const key = r.id + '|' + e.id;
    const now = new Date();
    const a = this.alarms.get(key);
    if (a) { a.last = now; return; }
    this.alarms.set(key, { rule: r.id, id: e.id, at: now, last: now, acked: false, label: nameOf(e) || shortId(e) });
    if (!quiet) this.toast(r, e);
  }

  //
  // changedEntities - live values: an alarm whose entity no longer matches clears; a deleted entity's too
  //
  changedEntities(entities) {
    let any = false;
    for (const e of entities) {
      for (const [k, a] of this.alarms) {
        if (a.id !== e.id) continue;
        const terms = this.parsed.get(a.rule);
        if (e.deletedAt || (terms && !matches(e, terms))) { this.alarms.delete(k); any = true; }
      }
    }
    if (any) this.changed();
  }

  list() {
    const sev = { critical: 0, warning: 1, info: 2 };
    return [...this.alarms.values()].map((a) => ({ ...a, r: this.rules.find((x) => x.id === a.rule) }))
      .filter((a) => a.r)
      .sort((a, b) => (a.acked - b.acked) || (sev[a.r.severity] - sev[b.r.severity]) || (b.at - a.at));
  }

  //
  // mapAlarms - for the map: [{id, color, acked}], an entity with several alarms in the gravest one's colour
  //
  mapAlarms() {
    const out = new Map();
    for (const a of this.list()) {
      const cur = out.get(a.id);
      if (!cur) out.set(a.id, { id: a.id, color: SEVERITY[a.r.severity], acked: a.acked });
      else if (!a.acked) cur.acked = false;
    }
    return [...out.values()];
  }

  changed() {
    this.render();
    this.onChange();
  }

  //
  // The toasts: the gravest first, at most a few; a click shows the entity
  //
  toast(r, e) {
    const box = $('alarm-toasts');
    const t = el('button', 'atoast ' + r.severity);
    t.type = 'button';
    t.style.setProperty('--sev', SEVERITY[r.severity]);
    t.append(el('span', 'sev', r.severity), el('span', 'at', r.title), el('span', 'ae', nameOf(e) || shortId(e)));
    t.title = `${e.id} - show it`;
    t.onclick = () => { t.remove(); this.onJump(e.id); };
    box.prepend(t);
    while (box.children.length > TOASTS_MAX) box.lastElementChild.remove();
    setTimeout(() => t.remove(), TOAST_MS);
  }

  open() {
    $('alarmpop').hidden = false;
    $('alarm-btn').setAttribute('aria-expanded', 'true');
    this.render();
    $('al-close').focus();
  }

  close() {
    if ($('alarmpop').hidden) return;
    $('alarmpop').hidden = true;
    $('alarm-btn').setAttribute('aria-expanded', 'false');
    $('alarm-btn').focus({ preventScroll: true });
  }

  //
  // render - the bell's badge, the alarm list, the rules
  //
  render() {
    const list = this.list();
    const open = list.filter((a) => !a.acked);
    const btn = $('alarm-btn');
    btn.hidden = !this.broker;
    const badge = $('alarm-badge');
    badge.textContent = String(open.length || list.length || '');
    badge.hidden = !list.length;
    badge.className = 'badge' + (open.length ? '' : ' acked');
    const worst = open[0] || null;
    badge.style.background = worst ? SEVERITY[worst.r.severity] : '';
    btn.title = list.length ? `${list.length} alarm${list.length === 1 ? '' : 's'}${open.length < list.length ? `, ${list.length - open.length} acknowledged` : ''}` : 'Alarms - none';
    if ($('alarmpop').hidden) return;

    $('al-ackall').disabled = !open.length;
    const box = $('al-list');
    box.textContent = '';
    if (!list.length) box.append(el('p', 'dim', this.rules.length ? 'No alarms.' : 'No alert rules for this broker - add one below.'));
    for (const a of list) {
      const row = el('div', 'arow' + (a.acked ? ' acked' : ''));
      row.style.setProperty('--sev', SEVERITY[a.r.severity]);
      const main = el('button', 'amain');
      main.type = 'button';
      main.title = `${a.id} - show it`;
      main.append(el('span', 'adot'), el('span', 'at', a.r.title), el('span', 'ae', a.label), el('span', 'atime', a.at.toLocaleTimeString()));
      main.onclick = () => this.onJump(a.id);
      row.append(main);
      if (!a.acked) {
        const ack = el('button', 'btn small', 'Ack');
        ack.type = 'button';
        ack.title = 'Acknowledge - it stays listed until the entity no longer matches';
        ack.onclick = () => { this.alarms.get(a.rule + '|' + a.id).acked = true; this.changed(); };
        row.append(ack);
      }
      if (!this.parsed.get(a.rule)) {
        const clr = el('button', 'btn small', 'Clear');
        clr.type = 'button';
        clr.title = 'c³ cannot evaluate this rule\'s q - clear the alarm by hand';
        clr.onclick = () => { this.alarms.delete(a.rule + '|' + a.id); this.changed(); };
        row.append(clr);
      }
      box.append(row);
    }

    const rules = $('al-rule-list');
    rules.textContent = '';
    if ($('al-rules').hidden) return;
    for (const r of this.rules) {
      const row = el('div', 'rrow');
      row.style.setProperty('--sev', SEVERITY[r.severity]);
      const what = el('div', 'rwhat');
      what.append(el('span', 'adot'), el('span', 'at', r.title));
      const how = el('div', 'rhow mono', `${r.type}${r.q ? ' · ' + r.q : ''}`);
      row.append(what, how);
      const why = this.failed.get(r.id);
      if (why) row.append(el('div', 'rfail', 'The broker refused it: ' + why));
      else if (!this.parsed.get(r.id)) row.append(el('div', 'rnote', 'c³ cannot evaluate this q: its alarms clear by hand.'));
      const del = el('button', 'btn small', 'Remove');
      del.type = 'button';
      del.onclick = () => this.setRules(this.rules.filter((x) => x.id !== r.id), true);
      row.append(del);
      rules.append(row);
    }
  }

  addRule() {
    const title = $('al-title').value.trim();
    const type = $('al-type').value.trim();
    const q = $('al-q').value.trim();
    const severity = $('al-sev').value;
    const say = (t) => { $('al-err').textContent = t; };
    if (!type) { say('The entity type the rule watches'); $('al-type').focus(); return; }
    if (q && parseQ(q) === null) say('c³ cannot evaluate this q itself - the broker still can; its alarms will clear by hand.');
    else say('');
    let base = (title || type + (q ? '-' + q : '')).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
    let id = base;
    for (let n = 2; this.rules.some((r) => r.id === id); n++) id = `${base}-${n}`;
    this.setRules([...this.rules, { id, title: title || id, severity, type, q }], true);
    $('al-title').value = '';
    $('al-q').value = '';
  }
}
