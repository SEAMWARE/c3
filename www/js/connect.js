//
// connect.js - Connect, read-only: what a broker holds (discovery), the types picked as a graph or on a
// map, and a menu on each entity
//
// A name in the broker field instead of a URL is a named demo (GET /api/demos/<name>): its descriptor names
// the broker, and gives the view, the types to watch and the alert rules - for a broker that has none of
// its own in the configuration yet.
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
import * as api from './api.js';
import {
  loadEntities, discover, setLocal, entityGet, entitiesQuery, relationshipNames, linked, typeParam,
  edgesOf, typesOf, attributes, kindOf, relationshipTargets, valueText, shortId, boxAttrs, ENTITY_CAP,
} from './ngsild.js';
import { PALETTE, typeColors, typeLabel } from './entity.js';
import { layout } from './layout.js';
import { Graph } from './graph.js';
import { openMenu, closeMenu } from './menu.js';
import { EntityMap, geometries, nameOf } from './map.js';
import { OfflinePanel } from './offline.js';
import { Live, isNullAttr } from './live.js';
import { EntityEditor, NULL } from './editor.js';
import { Alerts } from './alerts.js';
import { Temporal, deleteEntityHistory } from './temporal.js';
import { t, plural } from './i18n.js';


const $ = (id) => document.getElementById(id);

//
// A broker with this many entities or fewer is loaded whole on the first connect; a larger one waits
// for the types to be picked
//
const SMALL_BROKER = 300;

//
// The neighbourhood of an entity: at most this many entities pointing at it
//
const HOOD_IN_MAX = 300;

//
// Type colours - by the type's place in the sorted list of the broker's types (discovery), or of the
// graph's types when the broker has no discovery: the same broker, the same colours, whatever is picked
// (entity.js typeColors - the Dashboard's graph and map widgets colour the same way).
//
let colors = new Map();
let ownColors = new Map();                       // the types given a colour of their own (AI Assist), per broker

function setTypeColors(types) {
  colors = typeColors(types);
}

export function typeColor(type) {
  return ownColors.get(type) || colors.get(type) || PALETTE[0];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


//
// targetLabel - an entity id that is not loaded, as shown: urn:ngsi-ld:Dock:dock3 -> Dock:dock3
//
function targetLabel(id) {
  return shortId({ id, type: [] });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const entityCount = (n) => plural(n, '{n} entity', '{n} entities');
const typeCount = (n) => plural(n, '{n} type', '{n} types');
const relCount = (n) => plural(n, '{n} relationship', '{n} relationships');

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

//
// relSignature - an entity's Relationships, as one string: what the arrows depend on
//
function relSignature(e) {
  return attributes(e).filter(([, v]) => relationshipTargets(v).length).map(([n, v]) => n + '>' + relationshipTargets(v).join(',')).join('|');
}

//
// applyChange - a notified state of an entity onto the one held: every attribute in it replaces the
// held one, an attribute notified as deleted (urn:ngsi-ld:null) goes
//
function applyChange(e, n) {
  for (const [k, v] of Object.entries(n)) {
    if (k === 'id' || k === '@context') continue;
    if (isNullAttr(v)) delete e[k];
    else e[k] = v;
  }
}

function withoutNulls(n) {
  const e = {};
  for (const [k, v] of Object.entries(n)) if (k !== '@context' && !isNullAttr(v)) e[k] = v;
  return e;
}

//
// validRules - alert rules as the backend takes them: an id of [A-Za-z0-9._-], a type; at most 32
//
function validRules(rules) {
  const seen = new Set();
  return rules.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(r.id) && !seen.has(r.id) && seen.add(r.id) &&
    typeof r.type === 'string' && r.type && (r.q === undefined || r.q === null || typeof r.q === 'string')).slice(0, 32);
}

export class Connect {
  constructor() {
    this.broker = null;
    this.tenant = '';                            // the tenant everything is read from ('': the default one)
    this.local = false;                          // the broker's own entities only (local=true) - the user's choice, per broker
    this.brokers = [];                           // the configuration's brokers
    this.disc = null;                            // discover()'s answer, null when the broker has none
    this.picks = [];                             // the types ticked, sorted
    this.loadedPicks = null;                     // the types the loaded entities are of (null: all)
    this.loaded = [];                            // the entities of the picked types
    this.loadedById = new Map();
    this.entities = [];                          // the entities shown: the loaded ones, or a neighbourhood
    this.byId = new Map();
    this.mode = null;                            // null, or { kind: 'hood', id, text }
    this.hidden = new Set();
    this.open = new Set();                       // types whose attribute list is open
    this.typeRels = [];                          // [{from, name, to, n}] from the loaded entities
    this.unresolved = 0;                         // Relationships to entities not loaded
    this.loadedKinds = new Map();                // type -> attribute -> Set(kind), from the loaded entities
    this.loading = 0;                            // the load in progress; a newer one makes it stale
    this.view = 'graph';                         // 'graph' or 'map' - kept per broker
    this.mapView = null;                         // the map's view kept for the broker: {center, zoom, ...}
    this.colourBy = 'type';                      // the map's markers: by type, or by a Relationship's target
    this.highlighted = new Set();                // entities ringed (AI Assist)
    this.edges = [];

    this.graph = new Graph({
      viewport: $('viewport'), world: $('world'), svg: $('edges'),
      lines: $('edge-lines'), labels: $('edge-labels'), boxes: $('boxes'), pct: $('zoom-pct'),
    });
    this.graph.onSelect = (id) => {
      if (this.picking && id) { this.picked(id); return; }
      if (id) this.entityPanel(true);              // closed: a selection brings it back
      this.showEntity(id);
      this.emap.select(id);
    };
    this.graph.onMenu = (id, at, target) => this.menu(id, at, target);
    this.graph.onCollapse = (id) => {
      const n = this.graph.nodes.get(id);
      if (n) n.el.focus({ preventScroll: true });
    };

    //
    // The map
    //
    this.emap = new EntityMap({ container: $('mapview') });
    this.emap.onSelect = (id) => {
      if (this.picking && id) { this.picked(id); return; }
      this.graph.select(id);
    };
    this.emap.onMenu = (id, at, target) => this.menu(id, at, target);
    this.emap.onView = (v) => {
      this.mapView = v;
      clearTimeout(this.viewTimer);
      const url = this.broker;
      this.viewTimer = setTimeout(() => url && api.brokerConnect(url, { map: v }).catch(() => {}), 800);
    };
    this.emap.onOnline = (ok) => { $('map-offline').hidden = ok; };

    //
    // Live values: one subscription for the types loaded, its notifications applied in batches
    //
    this.live = new Live({
      onBatch: (batch) => this.applyLive(batch),
      onStatus: (st) => { this.liveStatus(st); if (st && st.mode === 'off' && this.watchTick) this.watchTick(); },
      onAlert: (rule, entities) => this.alerts.notified(rule, entities),
      onAlerts: (m) => this.alerts.installed(m),
    });

    //
    // Alerts: a rule's notification is an alarm - a toast, the alarm list, the entity ringed on the map
    //
    this.demo = null;                            // the named demo connected to: {name, url, broker, view, watch, alerts}
    this.alerts = new Alerts({
      live: this.live,
      entity: (id) => this.loadedById.get(id),
      onJump: (id) => this.follow(id),
      onChange: () => this.emap.setAlarms(this.alerts.mapAlarms()),
    });

    //
    // History: the selected entity's numeric Properties, the last minutes
    //

    //
    // The History panel: an attribute's history over a time range, from the temporal API
    //
    this.temporal = new Temporal(this, $('histpanel'));

    this.relMode = 'all';
    $('rel-mode').onchange = () => {
      this.relMode = $('rel-mode').value;
      this.emap.setRelationships(this.relMode);
      if (this.broker) api.brokerConnect(this.broker, { relationships: this.relMode }).catch(() => {});
    };

    //
    // The entity editor - Save sends one request; a target can be picked in the graph or on the map
    //
    this.picking = null;
    this.editor = new EntityEditor({
      root: $('editor'),
      toast: (t) => this.toast(t),
      onSaved: (id) => this.refetch(id),
      pick: (prompt, done) => {
        if (!done) { this.picking = null; this.pickSel = null; this.emap.onPoint = null; return; }
        this.picking = done;
        this.pickSel = this.graph.sel;
      },
      pickPoint: async (done) => {
        if (this.view !== 'map') await this.setView('map', true);
        this.emap.onPoint = done;
      },
    });

    //
    // Right-click where there is no entity: create one - on the map, at that point
    //
    this.graph.onBackMenu = (at) => {
      if (!this.broker) return;
      openMenu({ x: at.x, y: at.y, label: t('The graph'), items: [{ label: t('Create entity…'), action: () => this.create() }] });
    };
    this.emap.onBackMenu = (ll, at) => {
      if (!this.broker) return;
      openMenu({ x: at.x, y: at.y, label: t('The map'), items: [
        { label: t('Create entity here…'), hint: `${ll[0]}, ${ll[1]}`, action: () => this.create({ location: { type: 'GeoProperty', value: { type: 'Point', coordinates: ll } } }) },
      ] });
    };
    this.offline = new OfflinePanel({ map: this.emap, toast: (t) => this.toast(t), onAreas: (areas, fonts) => this.emap.setAreas(areas, fonts) });
    $('view-graph').onclick = () => this.setView('graph', true);
    $('view-map').onclick = () => this.setView('map', true);
    $('map-in').onclick = () => this.emap.zoomBy(1);
    $('map-out').onclick = () => this.emap.zoomBy(-1);
    $('map-fit').onclick = () => this.emap.fit();
    {
      // the zoom from which the map labels its entities - kept in this browser
      let z = 14.5;
      try { z = parseFloat(localStorage.getItem('c3.labelZoom')) || 14.5; } catch (e) { /* no storage */ }
      const show = (v) => { $('label-zoom').value = v; $('label-zoom-v').textContent = v; this.emap.setLabelZoom(v); };
      show(z);
      $('label-zoom').oninput = () => {
        const v = parseFloat($('label-zoom').value);
        show(v);
        try { localStorage.setItem('c3.labelZoom', String(v)); } catch (e) { /* no storage */ }
      };
    }
    $('map-download').onclick = () => (this.offline.isOpen() ? this.offline.close() : this.offline.open());
    $('colour-by').onchange = () => {
      this.colourBy = $('colour-by').value;
      this.renderMapChrome();
      if (this.broker) api.brokerConnect(this.broker, { colourBy: this.colourBy }).catch(() => {});
    };

    $('zoom-in').onclick = () => this.graph.zoomCenter(1.25);
    $('zoom-out').onclick = () => this.graph.zoomCenter(0.8);
    $('zoom-fit').onclick = () => this.graph.fit();
    $('connform').onsubmit = (e) => { e.preventDefault(); this.connect($('broker-url').value, $('tenant').value); };
    $('reload-btn').onclick = () => this.broker && this.connect(this.broker, this.tenant);
    $('local-only').onchange = () => { if (this.broker) this.connect($('broker-url').value, $('tenant').value, { local: $('local-only').checked }); };
    $('tenant').onchange = () => { if (this.broker && $('tenant').value.trim() !== this.tenant) this.connect($('broker-url').value, $('tenant').value); };
    $('broker-url').onchange = () => {
      //
      // Another broker picked: the tenant it was worked on in last time
      //
      const b = this.brokers.find((x) => x.url === $('broker-url').value.trim().replace(/\/+$/, ''));
      $('tenant').value = b && typeof b.tenant === 'string' ? b.tenant : '';
      $('local-only').checked = !!(b && b.connect && b.connect.local === true);
    };

    //
    // The access token
    //
    $('token-btn').onclick = () => ($('tokenpop').hidden ? this.tokenOpen() : this.tokenClose());
    $('tp-close').onclick = () => this.tokenClose();
    $('tp-form').onsubmit = (e) => { e.preventDefault(); this.tokenSet(); };
    $('tp-forget').onclick = () => this.tokenForget();
    $('tp-hdrs').onsubmit = (e) => { e.preventDefault(); this.headersSet(); };
    $('tp-hdr-add').onclick = () => { this.headerRow({ name: '', value: '', secret: false }); $('tp-hdr-rows').lastChild.querySelector('input').focus(); };
    $('tp-hdr-forget').onclick = () => this.headersForget();
    $('tp-login').onsubmit = (e) => { e.preventDefault(); this.login(); };
    $('tp-logout').onclick = () => this.logout();
    $('tp-vc-on').onchange = () => { $('tp-vc').hidden = !$('tp-vc-on').checked; };
    window.addEventListener('message', (e) => {
      if ((e.origin !== location.origin) || !e.data || (e.data.c3 !== 'oidc')) return;
      this.loginDone(e.data.broker, e.data.ok);
    });
    $('tokenpop').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.tokenClose(); }
    });
    $('pick-all').onclick = () => this.setPicks(this.disc ? this.disc.types.map((t) => t.name) : []);
    $('pick-none').onclick = () => this.setPicks([]);
    $('load-btn').onclick = () => this.loadPicks(true);

    //
    // IDs: idPattern on every load, until cleared
    //
    this.idPattern = '';
    const idApply = (pattern) => {
      this.idPattern = pattern.trim();
      $('id-pattern').value = this.idPattern;
      $('ids-on').hidden = !this.idPattern;
      $('ids-on').textContent = this.idPattern;
      if (!this.broker) return;
      if (this.picks && this.picks.length) this.loadPicks(false); else this.load(null, false);
    };
    $('idform').onsubmit = (ev) => { ev.preventDefault(); idApply($('id-pattern').value); };
    $('id-clear').onclick = () => idApply('');
    $('mode-back').onclick = () => this.back();
    $('json-close').onclick = () => this.closeJson();
    this.entityResize();
    $('entity-close').title = t('Close the entity panel - selecting an entity brings it back');
    $('entity-close').setAttribute('aria-label', t('Close the entity panel'));
    $('entity-close').onclick = () => this.entityPanel(false);
    $('json-copy').onclick = () => this.copy($('json-pre').textContent, t('the JSON'));
    $('jsonpanel').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeJson(); }
    });

    //
    // The graph's keys also work when nothing in particular has the focus
    //
    document.addEventListener('keydown', (e) => {
      if (e.target === document.body && !$('app').hidden && this.view === 'graph') this.graph.onKey(e);
    });

    this.empty(t('Connect to a broker'), t('Enter its URL above - for example http://localhost:1026. c³ reads its entities with ordinary NGSI-LD queries, through the backend.'));
  }

  //
  // brokers - the configuration's brokers, for the URL field's list
  //
  setBrokers(brokers) {
    this.brokers = brokers || [];
    const list = $('broker-list');
    list.textContent = '';
    for (const b of brokers || []) {
      const o = document.createElement('option');
      o.value = b.url;
      o.label = b.name && b.name !== b.url.replace(/^https?:\/\//, '') ? b.name : '';
      list.append(o);
    }
  }

  setState(kind, label) {
    $('state').className = 'state ' + kind;
    $('state-label').textContent = label;
    if (kind === 'ok') this.watchBroker(this.broker); else this.watchBroker(null);
  }

  //
  // watchBroker - while Explore is connected, the broker asked every 5 s whether it is there (GET /version: any
  // answer is one; only the proxy's "not reached" is not), and at once when the live connection says it lost the
  // broker's WebSocket. Gone - twice, 1.5 s apart: brokerLost
  //
  watchBroker(url) {
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watchUrl = url;
    if (!url) return;
    const tick = async () => {
      if (this.watchUrl !== url) return;
      let r = await api.brokerGet(url, '/version');
      if (r.reached === false && this.watchUrl === url) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if (this.watchUrl === url) r = await api.brokerGet(url, '/version');
      }
      if (this.watchUrl !== url) return;
      if (r.reached === false) { this.brokerLost(url, r); return; }
      this.watchTimer = setTimeout(tick, 5000);
    };
    this.watchTick = () => { clearTimeout(this.watchTimer); tick(); };
    this.watchTimer = setTimeout(tick, 5000);
  }

  //
  // brokerLost - the broker of Explore stopped answering: Explore goes back to "The broker cannot be reached"
  // (its panels closed), a popup says so on the pages that use the broker (Explore, Dashboard, Operate), and the
  // broker is asked every 5 s - answering again, Explore connects to it again
  //
  brokerLost(url, r) {
    if (this.broker !== url) return;
    const at = new Date().toLocaleTimeString();
    this.editor.close();
    if (this.temporal.isOpen) this.temporal.close();
    this.closeJson();
    closeMenu(false);
    this.failed(url, { reached: false, title: t('It stopped answering at {time}', { time: at }), detail: (r.body && (r.body.detail || r.body.title)) || '' });
    $('state-label').textContent = t('Lost');
    if (['page-connect', 'page-dashboard', 'page-run'].some((id) => !$(id).hidden)) this.lostPopup(url, at);
    const again = async () => {
      if (this.broker !== url || this.watchUrl) return;                 // another broker, or connected again
      const a = await api.brokerGet(url, '/version');
      if (this.broker !== url || this.watchUrl) return;
      if (a.reached !== false) {
        this.toast(t('The broker answers again - connecting'));
        const pop = document.querySelector('.brokerlost');
        if (pop) pop.remove();
        this.connect(url);
        return;
      }
      this.lostTimer = setTimeout(again, 5000);
    };
    clearTimeout(this.lostTimer);
    this.lostTimer = setTimeout(again, 5000);
  }

  //
  // lostPopup - over whichever page is shown: the broker is gone; OK closes it (Explore keeps saying so)
  //
  lostPopup(url, at) {
    const old = document.querySelector('.brokerlost');
    if (old) old.remove();
    const ov = el('div', 'overlay brokerlost');
    ov.setAttribute('role', 'alertdialog');
    ov.setAttribute('aria-modal', 'true');
    const card = el('div', 'card bad');
    const ok = el('button', 'btn primary', t('OK'));
    ok.type = 'button';
    const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); };
    const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
    ok.onclick = close;
    const actions = el('div', 'actions');
    actions.append(ok);
    const h = el('h3', null, t('The broker stopped answering'));
    h.id = 'brokerlost-title';
    ov.setAttribute('aria-labelledby', h.id);
    card.append(h, el('p', 'mono', url), el('p', null, t('At {time}. Explore shows nothing of it now; when it answers again, c³ connects to it again.', { time: at })), actions);
    ov.append(card);
    document.body.append(ov);
    document.addEventListener('keydown', key, true);
    ok.focus();
  }

  overlay(card) {
    const o = $('overlay');
    if (!card) { o.hidden = true; return; }
    const c = $('overlay-card');
    c.className = 'card ' + (card.cls || '');
    c.textContent = '';
    c.append(...card.children);
    o.hidden = false;
  }

  empty(title, text) {
    this.overlay({ children: [el('h3', null, title), el('p', null, text)] });
  }

  progressCard(title, url, text) {
    const bar = el('div');
    const line = el('p', null, text);
    const progress = el('div', 'progress');
    progress.append(bar);
    this.overlay({ children: [el('h3', null, title), el('p', 'mono', url), line, progress] });
    return {
      set(t, frac) { line.textContent = t; bar.style.width = frac === null ? '50%' : Math.round(100 * frac) + '%'; },
    };
  }

  //
  // tenantText - "the default tenant", or "tenant <name>"
  //
  tenantText() {
    return this.tenant ? t('tenant {tenant}', { tenant: this.tenant }) : t('the default tenant');
  }

  //
  // tenantsOffer - the tenant field's list: the ones used before at this broker, and the ones coraine
  // names (GET /admin/tenants, with the admin plugin)
  //
  async tenantsOffer(url, b) {
    const names = new Set(b && Array.isArray(b.tenants) ? b.tenants.filter((t) => typeof t === 'string') : []);
    const r = await api.brokerGet(url, '/admin/tenants');
    if (r.ok && Array.isArray(r.body)) for (const t of r.body) if (typeof t === 'string' && t) names.add(t);
    if (url !== this.broker) return;
    const list = $('tenant-list');
    list.textContent = '';
    for (const t of names) {
      const o = document.createElement('option');
      o.value = t;
      list.append(o);
    }
  }

  //
  // The access token: the backend keeps it; the page shows where it comes from and its last characters
  //
  async tokenState(broker) {
    let t, s;
    try { [t, s] = await Promise.all([api.brokerTokens(), api.oidcSessions()]); } catch (e) { return null; }
    const url = broker || this.tokenUrl || this.broker;
    const own = url && t.brokers ? t.brokers[url] : null;
    const login = url && s ? s[url] : null;
    return { own, def: t.default, tokenFile: t.tokenFile, login };
  }

  tokenText(st) {
    if (!st) return t('c³ could not say.');
    const tail = (i) => (i.tail ? ' ' + t('(…{tail}, {n} characters)', { tail: i.tail, n: i.length }) : '');
    if (st.login) {
      const user = st.login.user;
      const issuer = st.login.issuer;
      const error = st.login.error ? ` ${st.login.error}.` : '';
      if (st.login.credential) {
        const until = new Date(st.login.credential.expiresAt * 1000).toLocaleString();
        const v = { user, issuer, credential: st.login.credential.type, until, holder: st.login.credential.holder.slice(0, 20) };
        return (user
          ? t('Logged in as {user} at {issuer}, with the credential {credential} (until {until}) - c³ presents it to the verifier, held by {holder}…, and renews the token.', v)
          : t('Logged in at {issuer}, with the credential {credential} (until {until}) - c³ presents it to the verifier, held by {holder}…, and renews the token.', v)) + error;
      }
      if (st.login.refreshes) {
        return (user
          ? t('Logged in as {user} at {issuer} - its token renewed by c³ until the provider ends the session.', { user, issuer })
          : t('Logged in at {issuer} - its token renewed by c³ until the provider ends the session.', { issuer })) + error;
      }
      return (user
        ? t('Logged in as {user} at {issuer} - its token not renewable - log in again when it expires.', { user, issuer })
        : t('Logged in at {issuer} - its token not renewable - log in again when it expires.', { issuer })) + error;
    }
    if (st.own) return st.own.source === 'remembered' ? t('Its own token, remembered on this machine{tail}.', { tail: tail(st.own) }) : t('Its own token, for as long as c³ runs{tail}.', { tail: tail(st.own) });
    if (st.def) return st.def.source === 'file' ? t("c³'s default, from {file}{tail} - read again when the file changes.", { file: st.tokenFile, tail: tail(st.def) }) : t("c³'s default, from $C3_TOKEN{tail}.", { tail: tail(st.def) });
    return st.tokenFile ? t('None - {file} holds no token. Requests go without one.', { file: st.tokenFile }) : t('None - requests go without one.');
  }

  async tokenShow() {
    const st = await this.tokenState();
    const set = !!(st && (st.login || st.own || st.def));
    $('token-btn').classList.toggle('set', set);
    $('token-btn').title = set ? t('An access token is sent to this broker') : t('No access token is sent to this broker');
    if (!$('tokenpop').hidden) {
      $('tp-state').textContent = this.tokenText(st);
      $('tp-forget').disabled = !(st && st.own);
      $('tp-remember').checked = !!(st && st.own && st.own.source === 'remembered');
      $('tp-logout').disabled = !(st && st.login);
      $('tp-redirect').textContent = location.origin + '/api/oidc/callback';
      if (!this.loginFieldsFor || this.loginFieldsFor !== this.tokenUrl) {
        const said = (this.security && this.security.url === this.tokenUrl && this.security.md.coraine_auth === 'oidc' && Array.isArray(this.security.md.authorization_servers))
          ? { issuer: this.security.md.authorization_servers[0] } : {};
        const kept = (this.brokers.find((b) => b.url === this.tokenUrl) || {}).login || (st && st.login) || said;
        $('tp-issuer').value = kept.issuer || '';
        $('tp-client').value = kept.clientId || '';
        $('tp-scope').value = kept.scope || '';
        const md = (this.security && this.security.url === this.tokenUrl) ? this.security.md : {};
        const live = (st && st.login && st.login.credential) ? { credentialType: st.login.credential.type } : null;
        const vc = kept.fdsc || live || (md.coraine_auth === 'fdsc' ? { verifier: md.fdsc_discovery || '' } : null);
        $('tp-vc-on').checked = !!vc;
        $('tp-vc').hidden = !vc;
        $('tp-verifier').value = (vc && vc.verifier) || '';
        $('tp-cred').value = (vc && vc.credentialType) || '';
        $('tp-vpscope').value = (vc && vc.scope) || '';
        this.loginFieldsFor = this.tokenUrl;
      }
    }
    return st;
  }

  async tokenOpen(why) {
    let url = $('broker-url').value.trim().replace(/\/+$/, '') || this.broker;
    if (!url) { this.toast(t("Enter the broker's URL first")); $('broker-url').focus(); return; }
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    this.tokenUrl = url;                         // the broker in the URL field - connected to or not yet
    $('tp-broker').textContent = url;
    $('tokenpop').hidden = false;
    $('token-btn').setAttribute('aria-expanded', 'true');
    $('tp-token').value = '';
    await Promise.all([this.tokenShow(), this.headersShow()]);
    if (why) $('tp-state').textContent = why + ' ' + $('tp-state').textContent;
    $('tp-token').focus();
  }

  tokenClose() {
    if ($('tokenpop').hidden) return;
    $('tokenpop').hidden = true;
    $('token-btn').setAttribute('aria-expanded', 'false');
    $('tp-token').value = '';
    $('token-btn').focus({ preventScroll: true });
  }

  async tokenSet() {
    const token = $('tp-token').value.trim();
    if (!token) { $('tp-token').focus(); return; }
    try {
      await api.brokerTokenSet(this.tokenUrl, token, $('tp-remember').checked);
    } catch (e) {
      $('tp-state').textContent = t('Not taken: {error}', { error: e.message });
      return;
    }
    $('tp-token').value = '';
    this.tokenClose();
    this.toast(t('The token is sent to {url} from now on', { url: this.tokenUrl }));
    this.connect(this.tokenUrl, this.tokenUrl === this.broker ? this.tenant : undefined);
  }

  //
  // securityOf - what the broker says of its security (RFC 9728, coraine's /.well-known/oauth-protected-resource):
  // which auth plugin, and where its tokens come from; null when it says nothing
  //
  async securityOf(url) {
    const r = await api.brokerGet(url, '/.well-known/oauth-protected-resource');
    return (r.ok && r.body && typeof r.body === 'object') ? r.body : null;
  }

  //
  // securityShow - on a 401: the broker's own word on how to log in, added to the card once it is known - an
  // OpenID provider: Log in, its issuer filled in; the Data Space Connector's verifier: what it is
  //
  async securityShow(url, children, actions) {
    const md = await this.securityOf(url);
    if (!md) return;
    this.security = { url, md };
    const issuer = Array.isArray(md.authorization_servers) ? md.authorization_servers[0] : null;
    const card = actions.parentElement;
    if (!card) return;
    if (md.coraine_auth === 'oidc' && issuer) {
      card.insertBefore(el('p', null, t('It takes the tokens of the OpenID provider {issuer} - log in there.', { issuer })), actions);
      const login = el('button', 'btn primary', t('Log in…'));
      login.type = 'button';
      login.onclick = () => this.tokenOpen(t('The broker takes the tokens of {issuer}.', { issuer }));
      actions.prepend(login);
      for (const b of actions.querySelectorAll('.btn.primary')) if (b !== login) b.classList.remove('primary');
    } else if (md.coraine_auth === 'fdsc') {
      card.insertBefore(el('p', null, t("It takes the Data Space Connector's tokens - from the verifier {verifier}, for a Verifiable Credential.", { verifier: issuer || t('(not named)') })), actions);
      const login = el('button', 'btn primary', t('Log in with a credential…'));
      login.type = 'button';
      login.onclick = () => this.tokenOpen(t("The broker takes the verifier's tokens: log in at the consumer's Keycloak, c³ gets the credential and presents it."));
      actions.prepend(login);
      for (const b of actions.querySelectorAll('.btn.primary')) if (b !== login) b.classList.remove('primary');
    }
  }

  //
  // login - the provider's login page in a window of its own (opened at the click: a popup blocker lets that
  // one through), c3's callback tells this page when it is back (loginDone)
  //
  async login() {
    const issuer = $('tp-issuer').value.trim().replace(/\/+$/, '');
    const clientId = $('tp-client').value.trim();
    const scope = $('tp-scope').value.trim() || 'openid';
    if (!/^https?:\/\//.test(issuer)) { $('tp-state').textContent = t("The issuer: the provider's URL, e.g. https://keycloak.example.org/realms/city"); $('tp-issuer').focus(); return; }
    if (!clientId) { $('tp-state').textContent = t("The client id: the provider's client c³ logs in as - a public one"); $('tp-client').focus(); return; }
    const login = { issuer, clientId, scope };
    if ($('tp-vc-on').checked) {
      const verifier = $('tp-verifier').value.trim();
      const credentialType = $('tp-cred').value.trim();
      if (!/^https?:\/\//.test(verifier)) { $('tp-state').textContent = t('The verifier: its discovery document, e.g. https://verifier.example.org/services/data-service/.well-known/openid-configuration'); $('tp-verifier').focus(); return; }
      if (!credentialType) { $('tp-state').textContent = t('The credential: its type at the issuer (credential_configuration_id), e.g. user-credential'); $('tp-cred').focus(); return; }
      login.fdsc = { verifier, credentialType, scope: $('tp-vpscope').value.trim() || 'default' };
    }
    const w = window.open('', 'c3-login', 'popup,width=520,height=720');
    try {
      await api.brokerLoginSet(this.tokenUrl, login).catch(() => {});    // kept for next time - a broker not in the list yet keeps none
      const r = await api.oidcStart(this.tokenUrl, login);
      if (w) w.location = r.authorize; else location.href = r.authorize;
      $('tp-state').textContent = t("Log in in the provider's window - this one hears when it is done.");
    } catch (e) {
      if (w) w.close();
      $('tp-state').textContent = t('Not begun: {error}', { error: e.message });
    }
  }

  async loginDone(broker, ok) {
    if (!ok) { this.tokenShow(); return; }
    const st = await this.tokenShow();
    if (st && st.login) this.toast(st.login.user ? t('Logged in as {user} - its token goes to {broker} from now on', { user: st.login.user, broker }) : t('Logged in - its token goes to {broker} from now on', { broker }));
    this.tokenClose();
    this.connect(broker, broker === this.broker ? this.tenant : undefined);
  }

  async logout() {
    try {
      await api.oidcLogout(this.tokenUrl);
    } catch (e) {
      $('tp-state').textContent = t('Not logged out: {error}', { error: e.message });
      return;
    }
    await this.tokenShow();
    this.toast(t("Logged out - c³ forgot the tokens (the provider's session ends on its own)"));
  }

  //
  // ask - a question in a box of its own, answered by a button: true for the first
  //
  ask(text, yes, no = t('Cancel')) {
    return new Promise((resolve) => {
      const pop = document.createElement('div');
      pop.className = 'askpop';
      pop.setAttribute('role', 'alertdialog');
      pop.setAttribute('aria-modal', 'true');
      const box = document.createElement('div');
      box.className = 'askbox';
      const p = document.createElement('p');
      p.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const done = (v) => { pop.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
      const bNo = document.createElement('button');
      bNo.className = 'btn'; bNo.type = 'button'; bNo.textContent = no; bNo.onclick = () => done(false);
      const bYes = document.createElement('button');
      bYes.className = 'btn primary'; bYes.type = 'button'; bYes.textContent = yes; bYes.onclick = () => done(true);
      actions.append(bNo, bYes);
      box.append(p, actions);
      pop.append(box);
      pop.addEventListener('pointerdown', (e) => { if (e.target === pop) done(false); });
      document.addEventListener('keydown', key, true);
      document.body.append(pop);
      bNo.focus();
    });
  }

  //
  // confirmDelete - every delete in Explore asks first, in a box of its own (Cancel focused): on a broker c³ sends
  // no credentials to - it answered without any, so anyone who can reach it can delete too - the question says so
  //
  async confirmDelete(what) {
    const st = await this.tokenState(this.broker);
    if (!st || st.login || st.own || st.def) return this.ask(t('Delete {what} at the broker? It cannot be undone.', { what }), t('Delete'));
    return this.ask(t('{broker} has no security that c³ knows of: c³ sends it no token, and it answers without one - anyone who can reach it can delete. Delete {what}?', { broker: this.broker, what }), t('Delete'));
  }

  //
  // The headers of the broker's own: a row each - name, value, secret; a secret one comes without its value,
  // and its field left empty keeps it
  //
  headerRow(h) {
    const row = el('div', 'tp-hdr');
    const name = el('input', 'tp-field tp-hdr-name');
    const value = el('input', 'tp-field');
    const secretBox = el('input');
    const secret = el('label', null);
    const remove = el('button', 'iconbtn', '✕');

    name.placeholder = t('name - X-API-Key');
    name.value = h.name || '';
    name.setAttribute('aria-label', t('Header name'));
    value.type = h.secret ? 'password' : 'text';
    value.value = h.secret ? '' : (h.value || '');
    value.placeholder = (h.secret && h.kept) ? (h.tail ? t('kept - …{tail}', { tail: h.tail }) : t('kept - {n} characters', { n: h.length })) : t('value');
    value.setAttribute('aria-label', t('Header value'));
    secretBox.type = 'checkbox';
    secretBox.checked = !!h.secret;
    secretBox.onchange = () => { value.type = secretBox.checked ? 'password' : 'text'; };
    secret.append(secretBox, t('secret'));
    secret.title = t("A secret header's value stays in c³'s backend");
    remove.type = 'button';
    remove.setAttribute('aria-label', t('Remove the header'));
    remove.onclick = () => row.remove();
    for (const i of [name, value]) { i.autocomplete = 'off'; i.spellcheck = false; }
    row.kept = !!h.kept;                         // a secret value the backend has: an empty field keeps it
    row.append(name, value, secret, remove);
    $('tp-hdr-rows').append(row);
  }

  async headersShow() {
    let r;
    try { r = await api.brokerHeaders(); } catch (e) { $('tp-hdr-state').textContent = t('c³ could not say: {error}', { error: e.message }); return; }
    const own = (r.brokers && r.brokers[this.tokenUrl]) || null;
    $('tp-hdr-rows').textContent = '';
    for (const h of own ? own.headers : []) this.headerRow({ ...h, kept: h.secret });
    $('tp-hdr-remember').checked = !!(own && own.remembered);
    $('tp-hdr-forget').disabled = !own;
    $('tp-hdr-state').textContent = !own ? t('None.') : own.remembered ? t('{n} sent with every request, remembered on this machine.', { n: own.headers.length }) : t('{n} sent with every request, for as long as c³ runs.', { n: own.headers.length });
  }

  async headersSet() {
    const headers = [];
    for (const row of $('tp-hdr-rows').children) {
      const [name, value, box] = row.querySelectorAll('input');
      const n = name.value.trim();
      if (!n && !value.value) continue;          // an empty row
      const h = { name: n, secret: box.checked };
      if (value.value || !(box.checked && row.kept)) h.value = value.value;
      headers.push(h);
    }
    try {
      await api.brokerHeadersSet(this.tokenUrl, headers, $('tp-hdr-remember').checked);
    } catch (e) {
      $('tp-hdr-state').textContent = t('Not taken: {error}', { error: e.message });
      return;
    }
    await this.headersShow();
    this.toast(headers.length ? plural(headers.length, '{n} header sent to {url} from now on', '{n} headers sent to {url} from now on', { url: this.tokenUrl }) : t('No headers of its own'));
    this.connect(this.tokenUrl, this.tokenUrl === this.broker ? this.tenant : undefined);
  }

  async headersForget() {
    try {
      await api.brokerHeadersForget(this.tokenUrl);
    } catch (e) {
      $('tp-hdr-state').textContent = t('Not forgotten: {error}', { error: e.message });
      return;
    }
    await this.headersShow();
    this.toast(t('The headers are forgotten'));
  }

  async tokenForget() {
    try {
      await api.brokerTokenForget(this.tokenUrl);
    } catch (e) {
      $('tp-state').textContent = t('Not forgotten: {error}', { error: e.message });
      return;
    }
    await this.tokenShow();
    this.toast(t('The token is forgotten'));
  }

  toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  //
  // connect - what the broker holds, then the entities of the types picked
  //
  // 'tenant': the tenant to work in ('': the default one); not given, the one this broker was worked on in
  // last time. 'local': the broker's own entities only (local=true); not given, as last time - off for a
  // broker never connected to
  //
  async connect(input, tenant, { demo = null, local } = {}) {
    let url = String(input || '').trim();
    if (!url) { $('broker-url').focus(); return; }

    //
    // A bare name: a named demo, if the backend knows one by that name - else a host name (localhost)
    //
    if (!demo && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(url) && await this.connectDemo(url)) return;

    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    url = url.replace(/\/+$/, '');
    $('broker-url').value = url;
    if (!demo && this.demo && this.demo.broker === url) demo = this.demo;              // Reload, Retry
    this.demo = demo;

    const stored = this.brokers.find((x) => x.url === url);
    if (tenant === undefined) tenant = url === this.broker ? this.tenant : (stored && typeof stored.tenant === 'string' ? stored.tenant : '');
    tenant = String(tenant).trim();
    $('tenant').value = tenant;
    if (local === undefined) local = url === this.broker ? this.local : !!(stored && stored.connect && stored.connect.local === true);
    $('local-only').checked = local;

    const ticket = ++this.loading;
    if (url !== this.broker) this.tokenClose();
    if (url !== this.broker || tenant !== this.tenant) { this.editor.close(); if (this.temporal.isOpen) this.temporal.close(); }
    this.broker = url;
    this.tokenUrl = url;
    this.tenant = tenant;
    api.setTenant(url, tenant);
    this.local = local;
    setLocal(url, local);
    this.mode = null;
    $('modebar').hidden = true;
    this.closeJson();
    closeMenu(false);
    window.dispatchEvent(new CustomEvent('c3-explore-broker', { detail: { url, tenant, demo: demo ? demo.name : null } }));   // Operate's list shows it
    $('reload-btn').disabled = false;
    $('notice').hidden = true;
    $('counts').textContent = '';
    this.setState('busy', t('Discovering'));

    const card = this.progressCard(t('Discovering'), tenant ? t('{url} - tenant {tenant}', { url, tenant }) : url, t('Asking for the entity types…'));
    this.tokenShow();

    let disc;
    try {
      disc = await discover(url, (n, of) => {
        if (ticket === this.loading) card.set(plural(of, '{done} of {n} type', '{done} of {n} types', { done: n }), n / Math.max(of, 1));
      });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.disc = null;
      this.failed(url, err);
      return;
    }
    if (ticket !== this.loading) return;
    this.disc = disc;

    //
    // The broker answered: it goes into the configuration, which also holds the types picked last time
    //
    let saved;
    try {
      let config = await api.brokerTouch(url);
      const was = (config.brokers || []).find((x) => x.url === url);
      if (!was || (was.tenant || '') !== tenant || (tenant && !(Array.isArray(was.tenants) && was.tenants[0] === tenant)) ||
          ((was.connect && was.connect.local === true) !== local))
        config = await api.brokerConnect(url, { tenant, local });
      this.setBrokers(config.brokers);
      const b = (config.brokers || []).find((x) => x.url === url);
      const c = (b && b.connect) || {};
      const types = tenant ? (c.tenantTypes || {})[tenant] : c.types;
      if (Array.isArray(types)) saved = types.map(String);
      this.tenantsOffer(url, b);
      this.mapView = c.map && Array.isArray(c.map.center) ? c.map : null;
      this.colourBy = typeof c.colourBy === 'string' ? c.colourBy : 'type';
      this.relMode = c.relationships === 'selected' ? 'selected' : 'all';
      let view = c.view;
      let rules = Array.isArray(c.alerts) ? c.alerts : null;

      //
      // A demo's descriptor: what this broker has not been given in c³ yet
      //
      if (demo) {
        const v = demo.view && typeof demo.view === 'object' ? demo.view : {};
        if (!this.mapView && Array.isArray(v.center) && v.center.length === 2) this.mapView = { center: v.center, zoom: Number.isFinite(v.zoom) ? v.zoom : 12 };
        if (!c.relationships && (v.relationships === 'selected' || v.relationships === 'all')) this.relMode = v.relationships;
        if (view !== 'map' && view !== 'graph') view = v.mode;
        if (saved === undefined && Array.isArray(demo.watch)) saved = demo.watch.filter((t) => typeof t === 'string');
        if (!rules && Array.isArray(demo.alerts)) rules = demo.alerts;
      }
      this.pendingView = this.mapView;
      if (view === 'map' || view === 'graph') this.setView(view, false);
      $('rel-mode').value = this.relMode;
      this.emap.setRelationships(this.relMode);
      this.alerts.setBroker(url, tenant, validRules(rules || []));
      ownColors = new Map(c.typeColours && typeof c.typeColours === 'object' ? Object.entries(c.typeColours) : []);
      this.highlighted = new Set();
      this.graph.setHighlight([]);
      this.emap.highlight([]);
    } catch (e) {
      console.warn('c3: the configuration was not saved:', e.message);
    }
    if (ticket !== this.loading) return;

    this.loadedPicks = undefined;
    this.loaded = [];
    this.loadedById = new Map();

    if (!disc) {
      //
      // No discovery (no /types): every entity, as milestone 1 did
      //
      this.picks = [];
      setTypeColors([]);
      this.renderDiscovery();
      await this.load(null, false, ticket);
      return;
    }

    const names = disc.types.map((t) => t.name);
    setTypeColors(names);
    if (saved !== undefined) this.picks = saved.filter((t) => names.includes(t)).sort(cmp);
    else if (disc.total <= SMALL_BROKER) this.picks = [...names];
    else this.picks = [];

    this.renderDiscovery();

    if (this.picks.length) {
      await this.load(this.picks, false, ticket);
      return;
    }

    this.draw([]);
    this.loadedPicks = [];
    this.liveWatch();
    this.renderDiscovery();
    this.setState('ok', t('Connected'));
    $('counts').textContent = `${typeCount(disc.types.length)} · ${entityCount(disc.total)}`;
    const why = saved !== undefined
      ? t('No types are picked for this broker.')
      : t('{url} holds {entities} of {types} - more than c³ loads without asking ({max}).', { url, entities: entityCount(disc.total), types: typeCount(disc.types.length), max: SMALL_BROKER });
    if (disc.types.length === 0) this.empty(t('No entities'), t('{url} answered, and has no entities (in {tenant}).', { url, tenant: this.tenantText() }));
    else this.overlay({ children: [el('h3', null, t('Choose what to see')), el('p', null, why), el('p', null, t('Tick the types on the left and press Load. The choice is kept for this broker.'))] });
  }

  //
  // connectDemo - a named demo: its descriptor from the backend, then its broker connected to as it says;
  // false when there is no demo of that name (the name is a host, then)
  //
  async connectDemo(name) {
    const ticket = ++this.loading;
    this.setState('busy', t('Demo'));
    this.progressCard(t('Demo {name}', { name }), '', t('Asking for its descriptor…')).set(t('Asking for its descriptor…'), null);
    let d;
    try {
      d = await api.demo(name);
    } catch (e) {
      if (ticket !== this.loading) return true;
      if (e.status === 404) return false;
      this.live.unwatch();
      this.liveStatus(null);
      this.setState('bad', t('Demo not running'));
      const retry = el('button', 'btn primary', t('Retry'));
      retry.type = 'button';
      retry.onclick = () => this.connect(name);
      const actions = el('div', 'actions');
      actions.append(retry);
      this.overlay({ cls: 'bad', children: [el('h3', null, t('{name} is not running', { name })), el('p', null, e.message), actions] });
      return true;
    }
    if (ticket !== this.loading) return true;
    const desc = d.descriptor;
    const broker = desc.broker.replace(/\/+$/, '');
    const demo = { name: d.name, url: d.url, title: typeof desc.name === 'string' ? desc.name : d.name, broker, view: desc.view, watch: desc.watch, alerts: desc.alerts };
    this.connect(broker, typeof desc.tenant === 'string' ? desc.tenant : '', { demo });
    return true;
  }

  //
  // load - the entities of 'types' (null: all of them), drawn; 'save' keeps the choice in the configuration
  //
  async load(types, save, ticket = ++this.loading) {
    const url = this.broker;
    this.mode = null;
    $('modebar').hidden = true;
    $('notice').hidden = true;
    this.setState('busy', t('Loading'));
    const card = this.progressCard(t('Loading'), url, types ? plural(types.length, 'Asking for the entities of {n} type…', 'Asking for the entities of {n} types…') : t('Asking for the entities…'));

    let result;
    try {
      result = await loadEntities(url, (n, total) => {
        if (ticket !== this.loading) return;
        const of = total !== null ? Math.min(total, ENTITY_CAP) : null;
        card.set(of ? plural(of, '{done} of {n} entity', '{done} of {n} entities', { done: n }) : entityCount(n), of ? n / Math.max(of, 1) : null);
      }, types, this.idPattern ? '&idPattern=' + encodeURIComponent(this.idPattern) : '');
    } catch (err) {
      if (ticket !== this.loading) return;
      this.failed(url, err);
      return;
    }
    if (ticket !== this.loading) return;

    this.loadedPicks = types ? [...types] : null;
    this.loaded = result.entities;
    this.loadedById = new Map(this.loaded.map((e) => [e.id, e]));
    if (!this.disc) setTypeColors(this.loaded.flatMap((e) => typesOf(e)));
    this.summarise();
    this.draw(this.loaded);
    this.alerts.scan(this.loaded);
    this.renderDiscovery();
    this.setState('ok', t('Connected'));

    const edges = this.graph.edges.length;
    const shown = types && this.disc ? t('{entities} of {types}', { entities: entityCount(result.entities.length), types: typeCount(types.length) }) : entityCount(result.entities.length);
    $('counts').textContent = `${shown} · ${relCount(edges)}`;
    if (result.truncated) {
      $('notice').hidden = false;
      $('notice').textContent = t('showing the first {n} of {total} - c³ loads at most {max}', { n: result.entities.length, total: result.total, max: ENTITY_CAP });
    }

    this.liveWatch();

    if (result.entities.length === 0) {
      if (types && types.length === 0) this.empty(t('Nothing picked'), t('Tick the types to see on the left and press Load.'));
      else if (types) this.empty(t('No entities'), t('{url} answered, and has no entities of the types picked (in {tenant}).', { url, tenant: this.tenantText() }));
      else this.empty(t('No entities'), t('{url} answered, and has no entities (in {tenant}).', { url, tenant: this.tenantText() }));
    } else this.overlay(null);

    if (save) {
      try {
        await api.brokerTypes(url, types || [], this.tenant);
      } catch (e) {
        console.warn('c3: the types picked were not saved:', e.message);
      }
    }
  }

  loadPicks(save) {
    if (!this.broker) return Promise.resolve();
    return this.load([...this.picks], save);
  }

  setPicks(types) {
    this.picks = [...new Set(types)].sort(cmp);
    this.renderDiscovery();
  }

  failed(url, err) {
    this.live.unwatch();
    this.liveStatus(null);
    this.setState('bad', err.reached === false ? t('Not reachable') : t('Error'));
    this.draw([]);
    this.renderDiscovery();
    const retry = el('button', 'btn primary', t('Retry'));
    retry.type = 'button';
    retry.onclick = () => this.connect(url);
    const actions = el('div', 'actions');
    actions.append(retry);
    const children = [
      el('h3', null, err.reached === false ? t('The broker cannot be reached') : err.status ? t('The broker answered {status}', { status: err.status }) : t('The broker answered')),
      el('p', 'mono', url),
      el('p', null, [err.title, err.detail].filter(Boolean).join(' - ') || String(err.message || err)),
    ];
    if (err.reached === false && this.demo && this.demo.broker === url) children.push(el('p', null, t('It is the broker of the demo {name} - start it there (Start broker + populate), then Retry.', { name: this.demo.name })));
    else if (err.reached === false) children.push(el('p', null, t('Is it running, and is the URL right? c³ reaches the broker from the machine c³ runs on.')));
    if (err.status === 401) {
      children.push(el('p', null, t('The broker wants an access token - or did not accept the one c³ sent.')));
      const tok = el('button', 'btn', t('Token…'));
      tok.type = 'button';
      tok.onclick = () => this.tokenOpen(t('The broker answered 401.'));
      actions.append(tok);
      this.securityShow(url, children, actions);
    } else if (err.status === 403) {
      children.push(el('p', null, t('The broker knows who is asking, and does not allow it - for {tenant}.', { tenant: this.tenantText() })));
    }
    children.push(actions);
    this.overlay({ cls: 'bad', children });
  }

  //
  // summarise - from the loaded entities: the Relationships between types, and the attribute kinds
  //
  summarise() {
    const rels = new Map();
    const kinds = new Map();
    let unresolved = 0;
    for (const e of this.loaded) {
      const from = typesOf(e);
      for (const [name, v] of attributes(e)) {
        const kind = kindOf(v);
        for (const t of from) {
          if (!kinds.has(t)) kinds.set(t, new Map());
          const m = kinds.get(t);
          if (!m.has(name)) m.set(name, new Set());
          m.get(name).add(kind);
        }
        for (const to of relationshipTargets(v)) {
          const target = this.loadedById.get(to);
          if (!target) { ++unresolved; continue; }
          for (const f of from) for (const t of typesOf(target)) {
            const key = f + '\n' + name + '\n' + t;
            rels.set(key, (rels.get(key) || 0) + 1);
          }
        }
      }
    }
    this.typeRels = [...rels].map(([k, n]) => { const [from, name, to] = k.split('\n'); return { from, name, to, n }; })
      .sort((a, b) => cmp(typeLabel(a.from), typeLabel(b.from)) || cmp(a.name, b.name) || cmp(typeLabel(a.to), typeLabel(b.to)));
    this.unresolved = unresolved;
    this.loadedKinds = kinds;
  }

  //
  // draw - entities as the graph
  //
  draw(entities) {
    this.graph.collapse();
    const sorted = [...entities].sort((a, b) => cmp(a.id, b.id));
    this.entities = sorted;
    this.byId = new Map(sorted.map((e) => [e.id, e]));
    const edges = edgesOf(sorted, this.byId);
    this.edges = edges;

    const nodes = sorted.map((e) => this.nodeOf(e));
    const positions = layout(nodes.map((n) => ({ id: n.id, type: n.types[0] })), edges);

    this.graph.set(nodes, edges, positions);
    this.graph.setHidden(this.hidden);
    this.graph.fit();
    this.emap.select(null);
    this.emap.set(sorted, edges, (e) => this.mapColor(e));
    this.renderMapChrome();
    this.showEntity(null);
    this.mapPlaced = false;
    this.mapPlace();
  }

  nodeOf(e) {
    const types = typesOf(e);
    return {
      id: e.id, types,
      color: typeColor(types[0]),
      label: types.map(typeLabel).join(', '),
      short: shortId(e),
      attrs: boxAttrs(e),
    };
  }

  //
  // liveWatch - the types loaded watched on the broker (the types of the loaded entities when the broker
  // has no discovery)
  //
  liveWatch() {
    if (!this.broker) return;
    const types = this.loadedPicks ? this.loadedPicks : [...new Set(this.loaded.flatMap((e) => typesOf(e)))];
    this.live.watch(this.broker, types, this.tenant);
  }

  //
  // liveStatus - the Live chip: how the changes arrive, or why they do not
  //
  liveStatus(st) {
    const chip = $('live');
    if (!st) { chip.hidden = true; return; }
    chip.hidden = false;
    const ok = (st.mode === 'ws' || st.mode === 'http') && (st.subscription || !(st.types || []).length);
    const how = st.mode === 'ws' ? 'WebSocket' : 'HTTP';
    let label, title;
    if (ok && st.subscription) {
      label = t('Live · {how}', { how });
      const sub = t('Subscription {id}', { id: st.subscription });
      title = st.mode === 'ws'
        ? [t("Changes arrive over the broker's WebSocket transport (GET /ngsi-ld/v1/ws)."), sub].join('\n')
        : [t('Changes arrive as HTTP notifications to the c³ backend.'), sub, t('Why not the WebSocket: {why}', { why: st.why })].join('\n');
    } else if (ok) {
      label = t('Live · {how}', { how });
      title = t('Nothing to watch: no types loaded');
    } else {
      label = st.retrying ? t('Live · reconnecting') : t('Not live');
      title = st.detail || t('No subscription');
      if (st.why) title += `\n(${st.why})`;
    }
    chip.className = 'live ' + (ok ? 'ok' : st.retrying ? 'busy' : 'bad');
    $('live-label').textContent = label;
    chip.title = title;
  }

  //
  // applyLive - a batch of changes: values written into the boxes, the panel and the map; an entity of the
  // loaded types created or deleted is added or removed; a changed Relationship redraws the arrows
  //
  applyLive(batch) {
    if (!this.broker || this.loadedPicks === undefined) return;
    const picks = this.loadedPicks ? new Set(this.loadedPicks) : null;
    const changed = new Set();
    let structural = false;
    let rels = false;

    for (const n of batch) {
      const cur = this.loadedById.get(n.id);
      if (n.deletedAt) {
        if (!cur) continue;
        this.loaded = this.loaded.filter((e) => e.id !== n.id);
        this.loadedById.delete(n.id);
        structural = true;
        continue;
      }
      if (cur) {
        const before = relSignature(cur);
        applyChange(cur, n);
        if (relSignature(cur) !== before) rels = true;
        changed.add(n.id);
        const shown = this.byId.get(n.id);                  // a neighbourhood's copy
        if (shown && shown !== cur) applyChange(shown, n);
        continue;
      }
      if (picks && !typesOf(n).some((t) => picks.has(t))) continue;
      if (this.loaded.length >= ENTITY_CAP) continue;
      const e = withoutNulls(n);
      this.loaded.push(e);
      this.loadedById.set(e.id, e);
      structural = true;
      changed.add(e.id);
    }
    if (!changed.size && !structural) return;

    this.summarise();

    if (this.mode) {
      //
      // A neighbourhood: its boxes' values only - what was created or deleted shows on Back
      //
      for (const id of changed) if (this.byId.has(id)) this.graph.update(id, boxAttrs(this.byId.get(id)));
      this.emap.set(this.entities, this.edges, (e) => this.mapColor(e), { live: true });
      this.emap.flash([...changed].filter((id) => this.byId.has(id)));
    } else if (structural || rels) {
      this.redrawLive(structural);
      for (const id of changed) if (this.graph.nodes.has(id)) this.graph.update(id, boxAttrs(this.byId.get(id)));
      this.emap.flash([...changed]);
      this.renderDiscovery();
      const shown = this.loadedPicks && this.disc ? t('{entities} of {types}', { entities: entityCount(this.loaded.length), types: typeCount(this.loadedPicks.length) }) : entityCount(this.loaded.length);
      $('counts').textContent = `${shown} · ${relCount(this.graph.edges.length)}`;
      if (this.loaded.length) this.overlay(null);
    } else {
      for (const id of changed) this.graph.update(id, boxAttrs(this.byId.get(id)));
      this.emap.set(this.entities, this.edges, (e) => this.mapColor(e), { live: true });
      this.emap.flash([...changed]);
    }

    this.alerts.changedEntities([...[...changed].map((id) => this.loadedById.get(id)).filter(Boolean), ...batch.filter((n) => n.deletedAt)]);

    const sel = this.graph.sel;
    if (sel && changed.has(sel)) this.refreshPanel();
  }

  //
  // refreshPanel - the Entity panel drawn again for the selected entity, its scroll and open JSON kept
  //
  refreshPanel() {
    const sel = this.graph.sel;
    if (sel) {
      const panel = $('entity-body');
      const top = panel.parentElement ? panel.parentElement.scrollTop : 0;
      const raw = panel.querySelector('details.raw');
      const rawOpen = raw && raw.open;
      this.showEntity(sel);
      const raw2 = panel.querySelector('details.raw');
      if (raw2 && rawOpen) raw2.open = true;
      if (panel.parentElement) panel.parentElement.scrollTop = top;
    }
  }

  //
  // redrawLive - the loaded entities drawn again after a live change: the graph patched (the view, the
  // selection and boxes moved by hand kept - laid out again when entities came or went), the map set again
  //
  redrawLive(relayout) {
    const sorted = [...this.loaded].sort((a, b) => cmp(a.id, b.id));
    this.entities = sorted;
    this.byId = new Map(sorted.map((e) => [e.id, e]));
    const edges = edgesOf(sorted, this.byId);
    this.edges = edges;
    const nodes = sorted.map((e) => this.nodeOf(e));
    const positions = layout(nodes.map((n) => ({ id: n.id, type: n.types[0] })), edges);
    this.graph.patch(nodes, edges, relayout ? positions : null, positions);
    this.emap.set(sorted, edges, (e) => this.mapColor(e), { live: true });
    this.renderMapChrome();
  }

  //
  // setView - the graph or the map; 'save' keeps the choice for the broker
  //
  async setView(view, save) {
    this.view = view;
    $('view-graph').setAttribute('aria-pressed', view === 'graph' ? 'true' : 'false');
    $('view-map').setAttribute('aria-pressed', view === 'map' ? 'true' : 'false');
    $('viewport').hidden = view !== 'graph';
    $('graphbar').hidden = view !== 'graph';
    $('mapview').hidden = view !== 'map';
    $('mapbar').hidden = view !== 'map';
    $('mapfoot').hidden = view !== 'map';
    if (view !== 'map') this.offline.close();
    if (save && this.broker) api.brokerConnect(this.broker, { view }).catch(() => {});
    if (view !== 'map') return;

    if (!this.emap.ready) {
      const st = await this.offline.refresh();
      this.emap.areas = st.areas || [];
      this.emap.fonts = !!st.fonts;
      await this.emap.open(this.mapView);
      if (st.job && ['planning', 'tiles', 'fonts'].includes(st.job.state)) this.offline.open();
    } else {
      await this.emap.ready;
      this.emap.resize();
    }
    this.mapPlace();
    if (this.graph.sel) this.emap.select(this.graph.sel);
  }

  //
  // mapPlace - the map's view for entities just drawn: the view kept for the broker the first time after
  // a connect, else fitted to them; once per set of entities (switching views keeps where the map is)
  //
  mapPlace() {
    if (this.view !== 'map' || !this.emap.map || !this.emap.boxes.size || this.mapPlaced) return;
    this.mapPlaced = true;
    const v = this.pendingView;
    this.pendingView = null;
    if (v) this.emap.map.jumpTo({ center: v.center, zoom: v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 });
    else this.emap.fit(false);
  }

  //
  // Colour by - the type (as the graph), or the target of a Relationship: each target its colour, the
  // entities pointing at it in the same one, the target itself too
  //
  colourOptions() {
    const counts = new Map();
    for (const e of this.entities) {
      for (const [name, v] of attributes(e)) {
        const k = kindOf(v);
        if ((k === 'Relationship' || k === 'ListRelationship') && relationshipTargets(v).length) counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts].sort((a, b) => cmp(a[0], b[0]));
  }

  targetsOf(rel) {
    const t = new Map();
    for (const e of this.entities) {
      for (const [name, v] of attributes(e)) {
        if (name !== rel) continue;
        const first = relationshipTargets(v)[0];
        if (first) { t.set(first, (t.get(first) || 0) + 1); break; }
      }
    }
    return new Map([...t.keys()].sort(cmp).map((id, i) => [id, { color: PALETTE[i % PALETTE.length], n: t.get(id) }]));
  }

  mapColor(e) {
    if (this.colourBy === 'type' || !this.colourTargets) return typeColor(typesOf(e)[0]);
    for (const [name, v] of attributes(e)) {
      if (name !== this.colourBy) continue;
      const first = relationshipTargets(v)[0];
      if (first && this.colourTargets.has(first)) return this.colourTargets.get(first).color;
    }
    if (this.colourTargets.has(e.id)) return this.colourTargets.get(e.id).color;
    return '#5A616E';
  }

  //
  // renderMapChrome - the colour-by choices, the legend, how many entities are not on the map
  //
  renderMapChrome() {
    const opts = this.colourOptions();
    const known = this.colourBy !== 'type' && opts.some(([n]) => n === this.colourBy);
    this.colourTargets = known ? this.targetsOf(this.colourBy) : null;
    const sel = $('colour-by');
    sel.textContent = '';
    const o = el('option', null, t('type'));
    o.value = 'type';
    sel.append(o);
    for (const [name] of opts) {
      const x = el('option', null, name + ' →');
      x.value = name;
      sel.append(x);
    }
    sel.value = this.colourTargets ? this.colourBy : 'type';
    this.emap.setColors((e) => this.mapColor(e));

    const legend = $('legend');
    legend.textContent = '';
    legend.hidden = !this.colourTargets;
    if (this.colourTargets) {
      legend.append(el('span', 'lt', `${this.colourBy} →`));
      for (const [id, { color, n }] of this.colourTargets) {
        const sw = el('span', 'sw');
        sw.style.background = color;
        const t = this.byId.get(id);
        const ln = el('span', 'ln', t ? nameOf(t) || shortId(t) : targetLabel(id));
        ln.title = id;
        legend.append(sw, ln, el('span', 'lc', String(n)));
      }
    }

    const off = this.emap.notOnMap.length;
    const shownCount = this.entities.filter((e) => this.emap.visible(e)).length;
    const nm = $('not-on-map');
    nm.textContent = shownCount ? t('on the map: {on} · not on the map: {off}', { on: shownCount - off, off }) : '';
    const byType = new Map();
    for (const e of this.emap.notOnMap) for (const t of typesOf(e)) byType.set(typeLabel(t), (byType.get(typeLabel(t)) || 0) + 1);
    nm.title = off ? t('No GeoProperty: {types}', { types: [...byType].map(([ty, n]) => `${ty} ${n}`).join(', ') }) : '';
  }

  //
  // shownCounts - type -> how many of the shown entities are of it
  //
  shownCounts() {
    const counts = new Map();
    for (const e of this.entities) for (const t of typesOf(e)) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  }

  //
  // The types' own colours: {type: '#rrggbb'} - the whole set; 'save' keeps it for the broker
  //
  typeColours() {
    return Object.fromEntries(ownColors);
  }

  colourOf(type) {
    return typeColor(type);
  }

  saveConnect(patch) {
    if (this.broker) api.brokerConnect(this.broker, patch).catch(() => {});
  }

  setTypeColours(own, save) {
    ownColors = new Map(Object.entries(own));
    this.repaint();
    if (save && this.broker) api.brokerConnect(this.broker, { typeColours: this.typeColours() }).catch(() => {});
  }

  //
  // highlight - entities ringed in the graph and on the map until another highlight replaces them
  //
  highlight(ids) {
    this.highlighted = new Set(ids);
    this.graph.setHighlight(this.highlighted);
    this.emap.highlight([...this.highlighted]);
  }

  //
  // repaint - everything drawn in the types' colours, drawn again: the boxes (where they are), the map,
  // the side panels
  //
  repaint() {
    const nodes = this.entities.map((e) => this.nodeOf(e));
    const at = new Map([...this.graph.nodes.values()].map((n) => [n.id, { x: n.x, y: n.y, pinned: n.pinned }]));
    this.graph.patch(nodes, this.edges, null, at);
    this.renderMapChrome();
    this.renderDiscovery();
    this.renderRels();
    if (this.shownId) this.showEntity(this.shownId);
  }

  setHidden(types) {
    this.hidden = new Set(types);
    this.graph.setHidden(this.hidden);
    this.emap.setHidden(this.hidden);
    this.renderMapChrome();
    this.renderDiscovery();
  }

  //
  // renderDiscovery - the panel on the left: the types (picked, shown, their attributes), the
  // Relationships between them
  //
  renderDiscovery() {
    const list = $('typelist');
    list.textContent = '';
    const shown = this.shownCounts();
    const disc = this.disc;
    const loadedSet = new Set(this.loadedPicks || []);

    let rows;
    if (disc) rows = disc.types.map((t) => ({ name: t.name, count: t.count, attrs: t.attrs }));
    else rows = [...shown].map(([name, n]) => ({ name, count: n, attrs: [] }));
    const extra = [...shown.keys()].filter((t) => !rows.some((r) => r.name === t));
    rows.push(...extra.map((name) => ({ name, count: null, attrs: [] })));
    rows.sort((a, b) => cmp(typeLabel(a.name), typeLabel(b.name)) || cmp(a.name, b.name));

    $('disc-sum').textContent = !this.broker ? '' : disc
      ? `${typeCount(disc.types.length)} · ${entityCount(disc.total)}`
      : (this.loadedPicks === null ? t('no discovery - every entity loaded') : '');
    $('typeall').hidden = !disc || disc.types.length < 2;

    for (const r of rows) {
      const row = el('div', 'trow');
      row.setAttribute('role', 'listitem');
      const isShown = shown.has(r.name);

      if (disc) {
        const pick = el('input');
        pick.type = 'checkbox';
        pick.checked = this.picks.includes(r.name);
        pick.setAttribute('aria-label', t('Load {type}', { type: typeLabel(r.name) }));
        pick.title = t('Load this type');
        pick.onchange = () => {
          const p = new Set(this.picks);
          if (pick.checked) p.add(r.name); else p.delete(r.name);
          this.setPicks([...p]);
        };
        row.append(pick);
      }

      const b = el('button', 'type');
      b.type = 'button';
      b.title = !isShown ? t('{type} - none shown', { type: r.name })
        : this.hidden.has(r.name) ? t('{type} - {n} shown; click to show', { type: r.name, n: shown.get(r.name) })
          : t('{type} - {n} shown; click to hide', { type: r.name, n: shown.get(r.name) });
      b.disabled = !isShown;
      b.setAttribute('aria-pressed', isShown && !this.hidden.has(r.name) ? 'true' : 'false');
      if (!isShown) b.classList.add('unloaded');
      const sw = el('span', 'swatch');
      sw.style.background = typeColor(r.name);
      sw.style.color = typeColor(r.name);
      const n = r.count === null ? (isShown ? String(shown.get(r.name)) : '–') : String(r.count);
      b.append(sw, el('span', 'name', typeLabel(r.name)), el('span', 'n', n));
      b.onclick = () => {
        const h = new Set(this.hidden);
        if (h.has(r.name)) h.delete(r.name); else h.add(r.name);
        this.setHidden(h);
      };
      row.append(b);

      const more = el('button', 'more', '▸');
      more.type = 'button';
      more.setAttribute('aria-expanded', this.open.has(r.name) ? 'true' : 'false');
      more.setAttribute('aria-label', t('Attributes of {type}', { type: typeLabel(r.name) }));
      more.onclick = () => {
        if (this.open.has(r.name)) this.open.delete(r.name); else this.open.add(r.name);
        this.renderDiscovery();
        const again = [...$('typelist').querySelectorAll('.more')].find((x) => x.getAttribute('aria-label') === more.getAttribute('aria-label'));
        if (again) again.focus();
      };
      row.append(more);
      list.append(row);

      if (this.open.has(r.name)) list.append(this.attrList(r));
    }

    //
    // The Load button: enabled when the ticks differ from what is loaded
    //
    const lb = $('load-btn');
    lb.hidden = !disc || !this.broker;
    if (disc) {
      const counts = new Map(disc.types.map((t) => [t.name, t.count || 0]));
      const sum = this.picks.reduce((s, t) => s + (counts.get(t) || 0), 0);
      const dirty = this.loadedPicks === undefined || this.loadedPicks === null || !sameList(this.picks, this.loadedPicks);
      lb.disabled = !dirty;
      lb.textContent = !dirty ? t('Loaded') : this.picks.length === 0 ? t('Load nothing')
        : plural(this.picks.length, 'Load {n} type · {sum}', 'Load {n} types · {sum}', { sum }) + (sum > ENTITY_CAP ? ' ' + t('(first {max})', { max: ENTITY_CAP }) : '');
    }

    this.renderRels();

    const notes = $('disc-notes');
    notes.textContent = '';
    if (this.broker && !disc && this.loadedPicks === null) notes.append(el('p', null, t('The broker did not answer GET /ngsi-ld/v1/types: every entity is loaded (up to {max}), with no picking.', { max: ENTITY_CAP })));
    for (const n of (disc && disc.notes) || []) notes.append(el('p', null, n));
  }

  //
  // attrList - a type's attributes with their kinds; a Relationship with the types it points to, as far as
  // the loaded entities tell
  //
  attrList(r) {
    const box = el('div', 'tattrs');
    const loadedK = this.loadedKinds.get(r.name) || new Map();
    const names = new Set(r.attrs.map((a) => a.name));
    const attrs = [...r.attrs];
    for (const [name, ks] of loadedK) if (!names.has(name)) attrs.push({ name, kinds: [...ks] });
    attrs.sort((a, b) => cmp(a.name, b.name));
    if (!attrs.length) box.append(el('div', 'dim', t('no attributes')));

    for (const a of attrs) {
      const line = el('div', 'tattr');
      const kinds = a.kinds.length ? a.kinds : [...(loadedK.get(a.name) || [])];
      line.append(el('span', 'an', a.name));
      const k = el('span', 'ak', kinds.length ? kinds.join(', ') : '–');
      if (kinds.some((x) => x === 'Relationship' || x === 'ListRelationship')) {
        k.classList.add('rel');
        const to = [...new Set(this.typeRels.filter((x) => x.from === r.name && x.name === a.name).map((x) => typeLabel(x.to)))];
        if (to.length) k.textContent += ' → ' + to.join(', ');
      }
      line.append(k);
      const info = this.disc && this.disc.attributes.get(a.name);
      if (info && info.typeNames.length > 1) {
        const others = info.typeNames.filter((t) => t !== r.name).map(typeLabel);
        line.append(el('span', 'also', t('also in {types}', { types: others.join(', ') })));
      }
      box.append(line);
    }
    return box;
  }

  renderRels() {
    const box = $('rels');
    box.textContent = '';
    if (!this.broker) return;
    if (!this.loaded.length) {
      box.append(el('p', 'dim', t('Which types a Relationship points to is known from the entities: load some types to see.')));
      return;
    }
    if (!this.typeRels.length) box.append(el('p', 'dim', t('No Relationship between the loaded entities.')));
    for (const r of this.typeRels) {
      const line = el('div', 'trel');
      const f = el('span', 'tf', typeLabel(r.from));
      f.style.color = typeColor(r.from);
      const to = el('span', 'tt', typeLabel(r.to));
      to.style.color = typeColor(r.to);
      line.append(f, el('span', 'tn', r.name + ' →'), to, el('span', 'n', String(r.n)));
      line.title = plural(r.n, '{n} {name} Relationship from {from} to {to}', '{n} {name} Relationships from {from} to {to}', { name: r.name, from: r.from, to: r.to });
      box.append(line);
    }
    if (this.unresolved) box.append(el('p', 'dim', plural(this.unresolved, '{n} Relationship to entities not loaded - their types show once those are loaded.', '{n} Relationships to entities not loaded - their types show once those are loaded.')));
  }

  //
  // follow - a Relationship's target: shown (its type switched on), selected, centred; a target that is
  // not loaded opens its neighbourhood
  //
  follow(id) {
    const e = this.byId.get(id);
    if (!e) { this.neighbourhood(id); return; }
    const types = typesOf(e);
    if (types.every((t) => this.hidden.has(t))) {
      const h = new Set(this.hidden);
      types.forEach((t) => h.delete(t));
      this.setHidden(h);
    }
    if (this.view === 'map') {
      this.graph.select(id);
      if (this.emap.has(id)) this.emap.centerOn(id);
      else this.toast(t('{entity} has no location - not on the map', { entity: shortId(e) }));
      return;
    }
    this.graph.select(id, { center: true });
    const n = this.graph.nodes.get(id);
    if (n) (n.xel || n.el).focus({ preventScroll: true });
  }

  //
  // menu - the context menu of an entity's box
  //
  menu(id, at, target) {
    const e = this.byId.get(id);
    if (!e) return;
    const types = typesOf(e);

    const follows = [];
    for (const [name, v] of attributes(e)) {
      for (const to of relationshipTargets(v)) {
        const here = this.byId.get(to);
        follows.push({
          label: `${name} → ${here ? shortId(here) : targetLabel(to)}`,
          hint: here ? '' : t('not loaded'),
          action: () => this.follow(to),
        });
      }
    }

    const items = [];
    if (this.graph.expanded === id) items.push({ label: t('Close linked entities'), action: () => this.collapse(id) });
    if (follows.length) {                          // linked = its Relationships' targets: none, nothing to embed
      items.push({
        label: t('With linked entities'),
        items: [1, 2, 3].map((l) => ({ label: t('Level {level}', { level: l }), hint: l === 1 ? t('its targets') : t('{n} Relationships deep', { n: l }), action: () => this.expandLinked(id, l) })),
      });
    }
    if (this.mode && this.mode.id === id) items.push({ label: t('Back to the picked types'), action: () => this.back() });
    else items.push({ label: t('Neighbourhood'), hint: t('one Relationship away'), action: () => this.neighbourhood(id) });
    if (follows.length) items.push({ label: t('Follow'), items: follows });
    items.push({ separator: true });
    for (const ty of types) items.push({ label: t('Hide type {type}', { type: typeLabel(ty) }), action: () => this.setHidden([...this.hidden, ty]) });
    if (this.view === 'map') items.push({ label: t('Show in the graph'), action: () => { this.setView('graph', true); this.graph.select(id, { center: true }); } });
    else if (geometries(e).length) items.push({ label: t('Show on the map'), action: async () => { await this.setView('map', true); this.graph.select(id); this.emap.centerOn(id); } });
    items.push({ label: t('Copy id'), action: () => this.copy(id) });
    items.push({ label: t('Show JSON'), action: () => this.showJson(id) });
    items.push({ separator: true });
    items.push({ label: t('Edit…'), hint: t('attributes, as rows'), action: () => this.edit(id) });
    items.push({ label: t('Replace…'), hint: t('the whole entity'), action: () => this.edit(id, null, 'replace') });
    items.push({ label: t('History…'), hint: t('the temporal API'), action: () => this.temporal.openEntity(e) });
    items.push({ label: t('Delete its history…'), hint: t('the temporal API'), action: () => this.deleteHistory(id) });
    items.push({ label: t('Delete entity…'), action: () => this.deleteEntity(id) });

    openMenu({ x: at.x, y: at.y, items, label: `${types.map(typeLabel).join(', ')} ${shortId(e)}`, returnFocus: target });
  }

  //
  // copy - text to the clipboard
  //
  // 'what': what is copied, as said in the toast - none: the text itself (an id)
  //
  async copy(text, what = null) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) { this.toast(t('Could not copy {what}', { what: what || t('the id') })); return; }
    }
    this.toast(t('Copied {what}', { what: what || text }));
  }

  //
  // edit - the entity, as the broker has it now, in the editor ('focus': an attribute to open)
  //
  // mode 'replace': the same rows, Save sends the whole entity (PUT)
  //
  async edit(id, focus = null, mode = 'edit') {
    let e;
    try {
      e = await entityGet(this.broker, id);
    } catch (err) {
      this.toast(t('The broker answered {status}: {detail}', { status: err.status || '', detail: [err.title, err.detail].filter(Boolean).join(' - ') }));
      return;
    }
    this.closeJson();
    const names = new Set();
    for (const t of typesOf(e)) for (const n of (this.loadedKinds.get(t) || new Map()).keys()) names.add(n);
    this.editor.open({ broker: this.broker, entity: e, mode, focus, names: [...names].sort(cmp) });
  }

  //
  // create - a new entity in the editor; 'start': attributes it begins with (a map point: its location)
  //
  create(start = {}) {
    this.closeJson();
    const types = this.disc ? this.disc.types.map((t) => t.name) : [...this.loadedKinds.keys()];
    //
    // A type's attributes: name, kind, and a loaded entity's value - the JSON type a new one starts with
    //
    const typeAttrs = (t) => {
      const sample = this.loaded.find((e) => typesOf(e).includes(t)) || {};
      return [...(this.loadedKinds.get(t) || new Map()).entries()]
        .map(([n, kinds]) => [n, [...kinds][0] || 'Property', sample[n] && !Array.isArray(sample[n]) ? sample[n].value : undefined])
        .sort((a, b) => cmp(a[0], b[0]));
    };
    const names = new Set();
    for (const m of this.loadedKinds.values()) for (const n of m.keys()) names.add(n);
    this.editor.open({ broker: this.broker, entity: { id: '', type: '', ...start }, mode: 'create', names: [...names].sort(cmp), types: types.sort(cmp), typeAttrs });
  }

  //
  // picked - an entity clicked while the editor waits for a target
  //
  // The click picks; it does not move the selection - the entity being edited stays selected
  //
  picked(id) {
    const done = this.picking;
    const sel = this.pickSel;
    this.picking = null;
    this.pickSel = null;
    if (done) done(id);
    if (sel && sel !== this.graph.sel) this.graph.select(sel);
  }

  //
  // refetch - an entity as the broker has it after a write, into what Connect shows: the attributes it
  // no longer has deleted, as a notification would report them; gone (404): deleted
  //
  async refetch(id) {
    let e;
    try {
      e = await entityGet(this.broker, id);
    } catch (err) {
      if (err.status === 404) this.applyLive([{ id, deletedAt: new Date().toISOString() }]);
      return;
    }
    const n = { ...e };
    const cur = this.loadedById.get(id);
    if (cur) for (const k of Object.keys(cur)) if (!(k in e) && k !== 'id' && k !== 'type') n[k] = { type: 'Property', value: NULL };
    this.applyLive([n]);
    if (this.shownId === id) this.showEntity(id);
    if (!this.loadedById.has(id) && !this.byId.has(id)) this.toast(t('Saved {id} - not shown: its type is not among the types loaded', { id }));
  }

  async deleteEntity(id) {
    if (!(await this.confirmDelete(id))) return;
    const r = await api.brokerWrite(this.broker, 'DELETE', '/ngsi-ld/v1/entities/' + encodeURIComponent(id));
    if (!r.ok) {
      this.toast(t('Not deleted - the broker answered {status}: {detail}', { status: r.status, detail: [r.body && r.body.title, r.body && r.body.detail].filter(Boolean).join(' - ') }));
      return;
    }
    if (this.editor.isOpen && this.editor.id === id) this.editor.close();
    this.toast(t('Deleted {what}', { what: id }));
    this.applyLive([{ id, deletedAt: new Date().toISOString() }]);
  }

  //
  // deleteHistory - the entity's history (DELETE /temporal/entities/{id}); an open History of it read again
  //
  async deleteHistory(id) {
    if (!(await deleteEntityHistory(this, id))) return;
    if (this.temporal.isOpen && this.temporal.ctx && this.temporal.ctx.id === id) this.temporal.read();
  }

  //
  // attrMenu - an attribute's menu, from the entity panel: its History, Edit it, Delete it (one instance, or all)
  //
  attrMenu(id, name, v, at, target) {
    const ds = v && typeof v === 'object' && typeof v.datasetId === 'string' ? v.datasetId : null;
    const e = this.byId.get(id);
    const several = e && Array.isArray(e[name]) && e[name].length > 1;
    const what = ds ? `${name} (${ds})` : (several ? t('{name} - the default instance', { name }) : name);
    const del = async (query, asked) => {
      if (!(await this.confirmDelete(asked))) return;
      const r = await api.brokerWrite(this.broker, 'DELETE', '/ngsi-ld/v1/entities/' + encodeURIComponent(id) + '/attrs/' + encodeURIComponent(name) + query);
      if (!r.ok) {
        this.toast(t('Not deleted - the broker answered {status}: {detail}', { status: r.status, detail: [r.body && r.body.title, r.body && r.body.detail].filter(Boolean).join(' - ') }));
        return;
      }
      this.toast(t('Deleted {what}', { what }));
      this.refetch(id);
    };
    const items = [
      { label: t('History…'), hint: t('the temporal API'), action: () => { if (e) this.temporal.open(e, name); } },
      { separator: true },
      { label: t('Edit {name}…', { name }), action: () => this.edit(id, name) },
      { separator: true },
      { label: t('Delete {what}…', { what }), action: () => del(ds ? '?datasetId=' + encodeURIComponent(ds) : '', what) },
    ];
    if (several) items.push({ label: t('Delete every instance of {name}…', { name }), action: () => del('?deleteAll=true', t('every instance of {name}', { name })) });
    openMenu({ x: at.x, y: at.y, items, label: name, returnFocus: target });
  }

  //
  // showJson - the entity as the broker returned it, in a panel over the graph
  //
  showJson(id) {
    const e = this.byId.get(id);
    if (!e) return;
    this.jsonReturn = document.activeElement;
    $('json-title').textContent = `${typesOf(e).map(typeLabel).join(', ')} ${shortId(e)}`;
    $('json-pre').textContent = JSON.stringify(e, null, 2);
    $('jsonpanel').hidden = false;
    $('json-close').focus();
  }

  closeJson() {
    if ($('jsonpanel').hidden) return;
    $('jsonpanel').hidden = true;
    if (this.jsonReturn && document.contains(this.jsonReturn)) this.jsonReturn.focus({ preventScroll: true });
    this.jsonReturn = null;
  }

  //
  // expandLinked - the entity with its linked entities embedded (join=inline, joinLevel), as one box
  //
  async expandLinked(id, level) {
    if (this.view !== 'graph') this.setView('graph', true);         // the linked entities open in the graph
    const ticket = this.linkTicket = (this.linkTicket || 0) + 1;
    const e = this.byId.get(id);
    this.toast(t('Asking for {entity} with its linked entities, level {level}…', { entity: e ? shortId(e) : id, level }));
    let full;
    try {
      full = await entityGet(this.broker, id, `join=inline&joinLevel=${level}`);
    } catch (err) {
      if (ticket === this.linkTicket) this.toast(t('The broker answered {status}: {detail}', { status: err.status || '', detail: [err.title, err.detail].filter(Boolean).join(' - ') }));
      return;
    }
    if (ticket !== this.linkTicket || !this.graph.nodes.has(id)) return;
    $('toast').hidden = true;

    const box = this.linkedCard(full, 0, level);
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('{entity} with its linked entities, level {level}', { entity: `${typesOf(full).map(typeLabel).join(', ')} ${full.id}`, level }));
    const head = box.querySelector('.lhead');
    head.append(el('span', 'lv', t('linked · level {level}', { level })));
    const close = el('button', 'lclose', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('Close linked entities'));
    close.onclick = () => this.collapse(id);
    head.append(close);
    this.graph.expand(id, box);
    this.graph.select(id);
    this.graph.reveal(id);
    box.focus({ preventScroll: true });
  }

  collapse(id) {
    this.graph.collapse();
    const n = this.graph.nodes.get(id);
    if (n) n.el.focus({ preventScroll: true });
  }

  //
  // linkedCard - an entity and, inside it, the entities its Relationships embed, level by level
  //
  linkedCard(e, depth, level) {
    const types = typesOf(e);
    const card = el('div', depth === 0 ? 'lcard root' : 'lcard');
    card.style.setProperty('--c', typeColor(types[0]));
    const head = el('div', 'lhead');
    const tl = el('span', 't', types.map(typeLabel).join(', '));
    tl.style.color = typeColor(types[0]);
    head.append(tl, el('span', 'id', shortId(e)));
    head.title = e.id;
    card.append(head);

    const body = el('div', 'body');
    for (const a of boxAttrs(e, 3)) {
      const row = el('div', 'a');
      row.append(el('span', 'k', a.k), el('span', 'v', a.v));
      body.append(row);
    }
    for (const [name, v] of attributes(e)) {
      const kind = kindOf(v);
      if (kind !== 'Relationship' && kind !== 'ListRelationship') continue;
      const rel = el('div', 'lrel');
      const embedded = linked(v);
      rel.append(el('div', 'rn', name + ' →'));
      if (embedded.length) {
        for (const x of embedded) rel.append(this.linkedCard(x, depth + 1, level));
      } else {
        //
        // A Relationship of a card at depth d is at level d + 1: past joinLevel it is not embedded; within
        // it, the target was not there to embed
        //
        const why = depth + 1 > level ? t('deeper than level {level}', { level }) : t('not embedded by the broker');
        const ids = relationshipTargets(v).map(targetLabel).join(', ');
        const miss = el('div', 'miss');
        miss.append(el('span', 'mono', ids), el('span', 'why', ' ' + why));
        rel.append(miss);
      }
      body.append(rel);
    }
    card.append(body);
    return card;
  }

  //
  // neighbourhood - only this entity and the entities one Relationship away, out or in
  //
  // Out: its targets - the loaded ones, the others asked for by id. In: the loaded entities pointing at it,
  // and the broker's (q=<every Relationship name>=="<id>", from discovery), up to HOOD_IN_MAX.
  //
  async neighbourhood(id) {
    closeMenu(false);
    const ticket = ++this.loading;
    const url = this.broker;
    this.setState('busy', t('Loading'));
    const card = this.progressCard(t('Neighbourhood'), id, t('Asking for the entity…'));

    try {
      const have = new Map();
      const center = this.loadedById.get(id) || this.byId.get(id) || await entityGet(url, id);
      if (ticket !== this.loading) return;
      have.set(center.id, center);

      const outIds = [...new Set(attributes(center).flatMap(([, v]) => relationshipTargets(v)))].filter((t) => t !== id).sort(cmp);
      const missing = [];
      for (const t of outIds) {
        const known = this.loadedById.get(t) || this.byId.get(t);
        if (known) have.set(t, known); else missing.push(t);
      }
      card.set(plural(outIds.length, '{n} target…', '{n} targets…'), 0.3);
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        const r = await entitiesQuery(url, 'id=' + typeParam(chunk), 50);
        for (const x of r.entities) have.set(x.id, x);
      }
      if (ticket !== this.loading) return;
      const outFound = outIds.filter((t) => have.has(t)).length;

      card.set(t('the entities pointing at it…'), 0.6);
      const incoming = new Set();
      for (const x of [...this.loaded, ...this.entities]) {
        if (x.id === id) continue;
        if (attributes(x).some(([, v]) => relationshipTargets(v).includes(id))) { have.set(x.id, x); incoming.add(x.id); }
      }
      let inTotal = null;
      let inNote = '';
      const names = relationshipNames(this.disc);
      if (names.length) {
        //
        // One q per group of names, each URL kept short: q=a=="<id>"|b=="<id>"|...
        //
        const terms = names.map((n) => encodeURIComponent(`${n}==${JSON.stringify(id)}`));
        const groups = [];
        for (const t of terms) {
          const g = groups[groups.length - 1];
          if (g && g.join('%7C').length + t.length < 1500) g.push(t); else groups.push([t]);
        }
        try {
          inTotal = 0;
          for (const g of groups) {
            if (incoming.size >= HOOD_IN_MAX) break;
            const r = await entitiesQuery(url, 'q=' + g.join('%7C'), HOOD_IN_MAX);
            for (const x of r.entities) {
              if (x.id === id || incoming.size >= HOOD_IN_MAX) continue;
              if (!have.has(x.id)) have.set(x.id, x);
              incoming.add(x.id);
            }
            inTotal += r.total;
          }
        } catch (err) {
          const why = err.reached === false ? t('c³ could not send it: {error}', { error: err.detail || err.title }) : t('the broker answered {status}', { status: err.status });
          inNote = ' ' + t('(the q query for the entities pointing at it failed - {why}; only the loaded ones are shown)', { why });
        }
      } else if (this.disc === null) {
        inNote = ' ' + t('(no discovery: only the loaded entities pointing at it)');
      }
      if (ticket !== this.loading) return;

      this.mode = { kind: 'hood', id };
      this.draw([...have.values()]);
      this.renderDiscovery();
      this.overlay(null);
      this.setState('ok', t('Connected'));
      const types = typesOf(center).map(typeLabel).join(', ');
      const more = inTotal !== null && inTotal > HOOD_IN_MAX ? ' ' + t('(the first {max} of {total})', { max: HOOD_IN_MAX, total: inTotal }) : '';
      const notFound = missing.length && outFound < outIds.length ? ' · ' + plural(outIds.length - outFound, '{n} target not found', '{n} targets not found') : '';
      $('mode-text').textContent = t('Neighbourhood of {entity} · {out} out · {incoming} in', { entity: `${types} ${shortId(center)}`, out: outFound, incoming: incoming.size }) + more + inNote + notFound;
      $('modebar').hidden = false;
      $('counts').textContent = `${entityCount(have.size)} · ${relCount(this.graph.edges.length)}`;
      this.graph.select(id);
      const n = this.graph.nodes.get(id);
      if (n) n.el.focus({ preventScroll: true });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.setState('ok', t('Connected'));
      this.overlay(null);
      this.toast(t('The broker answered {status}: {detail}', { status: err.status || '', detail: [err.title, err.detail].filter(Boolean).join(' - ') }));
    }
  }

  //
  // back - from a neighbourhood to the entities of the picked types
  //
  back() {
    if (!this.mode) return;
    const id = this.mode.id;
    this.mode = null;
    $('modebar').hidden = true;
    this.draw(this.loaded);
    this.renderDiscovery();
    const edges = this.graph.edges.length;
    $('counts').textContent = `${entityCount(this.loaded.length)} · ${relCount(edges)}`;
    if (this.byId.has(id)) this.graph.select(id);
    if (!this.loaded.length) this.empty(t('Nothing loaded'), t('Tick the types to see on the left and press Load.'));
  }

  //
  // sysAttrsOn - the entity panel's sysAttrs tick, kept in the browser
  //
  sysAttrsOn() {
    try { return localStorage.getItem('c3.entity.sysAttrs') === '1'; } catch (e) { return false; }
  }

  //
  // readSysAttrs - the entity again, with options=sysAttrs: its createdAt and modifiedAt and its attributes'.
  // The panel is drawn again with them when it still shows that entity and they changed
  //
  async readSysAttrs(id) {
    const broker = this.broker;
    const r = await api.brokerGet(broker, '/ngsi-ld/v1/entities/' + encodeURIComponent(id) + '?options=sysAttrs');
    if (broker !== this.broker || this.shownId !== id || !this.sysAttrsOn()) return;
    const why = !r.reached ? t('the broker is not reachable') : `${r.status} ${(r.body && (r.body.title || r.body.detail)) || ''}`.trim();
    const got = r.ok && r.body && typeof r.body === 'object' ? r.body : { id, failed: why };
    const before = this.sysEntity && this.sysEntity.id === id ? JSON.stringify(this.sysEntity) : null;
    this.sysEntity = got;
    if (JSON.stringify(got) !== before) this.showEntity(id);
  }

  //
  // entityResize - the handle left of the entity panel: dragged (or ←/→), the panel's width, kept in the
  // browser; a double-click, the default width
  //
  entityResize() {
    const h = $('entity-resize');
    const panel = $('entity');
    h.title = t('Drag to resize - a double-click: the default width');
    h.setAttribute('aria-label', t('The entity panel\'s width'));
    const set = (w, keep = true) => {
      if (!w) { panel.style.flex = ''; panel.style.maxWidth = ''; } else {
        w = Math.round(Math.max(280, Math.min(w, window.innerWidth * 0.7)));
        panel.style.flex = `0 0 ${w}px`;
        panel.style.maxWidth = 'none';
      }
      if (keep) try { if (w) localStorage.setItem('c3.entity.width', String(w)); else localStorage.removeItem('c3.entity.width'); } catch (e) { /* no storage */ }
    };
    try { const w = parseInt(localStorage.getItem('c3.entity.width'), 10); if (w) set(w, false); } catch (e) { /* no storage */ }
    h.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      h.setPointerCapture(ev.pointerId);
      h.classList.add('drag');
      const x0 = ev.clientX, w0 = panel.getBoundingClientRect().width;
      const move = (m) => set(w0 + (x0 - m.clientX));
      const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => set(0));
    h.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      set(panel.getBoundingClientRect().width + (ev.key === 'ArrowLeft' ? 24 : -24));
    });
  }

  //
  // entityPanel - the entity panel shown or not: closed, the graph and the map take its room; the selection stays
  // (the panel shows it again when it comes back), and only a selection by the user brings it back - a live
  // change of the shown entity does not
  //
  entityPanel(on) {
    if ($('entity').hidden === !on) return;
    $('entity').hidden = !on;
    $('entity-resize').hidden = !on;
    if (!on && $('entity').contains(document.activeElement)) $('viewport').focus({ preventScroll: true });
    requestAnimationFrame(() => this.emap.resize());   // the map's canvas to its new width
  }

  //
  // showEntity - the attribute panel
  //
  showEntity(id) {
    this.shownId = id;
    const body = $('entity-body');
    const e = id ? this.byId.get(id) : null;
    $('entity-empty').hidden = !!e;
    body.hidden = !e;
    body.textContent = '';
    $('entity-tools').textContent = '';
    if (!e) return;

    //
    // Up to the right: the system attributes (createdAt, modifiedAt - the broker's, read again with
    // options=sysAttrs while ticked)
    //
    const tools = $('entity-tools');
    tools.textContent = '';
    const sysOn = this.sysAttrsOn();
    const sysBox = el('label', 'esys');
    const sysTick = el('input');
    sysTick.type = 'checkbox';
    sysTick.checked = sysOn;
    sysTick.onchange = () => {
      try { localStorage.setItem('c3.entity.sysAttrs', sysTick.checked ? '1' : '0'); } catch (err) { /* no storage */ }
      this.showEntity(this.shownId);
    };
    sysBox.title = t('The system attributes - createdAt, modifiedAt - of the entity and its attributes');
    sysBox.append(sysTick, 'sysAttrs');
    tools.append(sysBox);

    const sys = sysOn && this.sysEntity && this.sysEntity.id === e.id ? this.sysEntity : null;
    if (sysOn) this.readSysAttrs(e.id);

    //
    // The entity: id (a click - its menu, as a right-click on its box), type, scope; createdAt and modifiedAt while sysAttrs is ticked
    //
    const meta = el('table', 'emeta');
    const metaRow = (k, v, cls) => {
      const tr = el('tr');
      const td = el('td', cls || null);
      if (v instanceof Node) td.append(v); else td.textContent = v;
      tr.append(el('th', null, k), td);
      meta.append(tr);
      return td;
    };
    const eid = el('span', 'eid', e.id);
    eid.tabIndex = 0;
    eid.setAttribute('role', 'button');
    eid.title = t('Its menu: History, Edit, Delete, ...');
    eid.setAttribute('aria-haspopup', 'menu');
    eid.onclick = (ev) => { if (!String(window.getSelection() || '')) this.menu(id, { x: ev.clientX, y: ev.clientY }, eid); };
    eid.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      const r = eid.getBoundingClientRect();
      this.menu(id, { x: r.left, y: r.bottom }, eid);
    };
    metaRow('id', eid);
    const types = el('div', 'etypes');
    for (const t of typesOf(e)) {
      const s = el('span', 'etype', typeLabel(t));
      s.style.color = typeColor(t);
      s.title = t;
      types.append(s);
    }
    metaRow('type', types);
    if (e.scope !== undefined) metaRow('scope', [].concat(e.scope).join(', '));
    if (sysOn) {
      const src = sys || e;
      if (sys && sys.failed) metaRow('sysAttrs', t('not read - {why}', { why: sys.failed }), 'dim');
      else for (const k of ['createdAt', 'modifiedAt']) metaRow(k, src[k] || (sys ? '-' : '…'), src[k] ? null : 'dim');
    }
    body.append(meta);

    for (const [name, v] of attributes(e)) {
      const row = el('div', 'attr');
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.attrMenu(id, name, v, { x: ev.clientX, y: ev.clientY }, row);
      });
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button, input, a') || String(window.getSelection() || '')) return;
        this.attrMenu(id, name, v, { x: ev.clientX, y: ev.clientY }, row);
      });
      row.title = t('Its menu: History, Edit, Delete');
      const kind = kindOf(v);
      const ah = el('span', 'ah');
      if (kind !== 'Relationship' && kind !== 'ListRelationship') {
        //
        // The one attribute shown on the map: its value as every entity's label; clicked again, the names
        //
        const pick = el('input', 'maplabel');
        pick.type = 'radio';
        pick.name = 'maplabel';
        pick.checked = this.emap.labelAttr === name;
        pick.title = t('Show this attribute on the map');
        pick.setAttribute('aria-label', t('Show {name} on the map', { name }));
        pick.addEventListener('click', () => {
          const on = this.emap.labelAttr !== name;
          this.emap.setLabelAttr(on ? name : null);
          pick.checked = on;
        });
        ah.append(pick);
      }
      ah.append(el('span', 'k', name));
      row.append(ah, el('span', 'kind', kind));

      if (kind === 'Relationship' || kind === 'ListRelationship') {
        for (const target of relationshipTargets(v)) {
          const b = el('button', 'rel', target);
          b.type = 'button';
          b.onclick = () => this.follow(target);
          if (!this.byId.has(target)) {
            b.classList.add('missing');
            b.title = t('Not loaded - opens its neighbourhood');
          }
          row.append(b);
        }
      } else {
        row.append(el('span', 'v', valueText(v, 400)));
      }

      const sysV = sys && sys[name] && typeof sys[name] === 'object' && !Array.isArray(sys[name]) ? sys[name] : null;
      const subs = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : null;
      if (subs) {
        delete subs.createdAt;
        delete subs.modifiedAt;
        if (sysV) { if (sysV.createdAt) subs.createdAt = sysV.createdAt; if (sysV.modifiedAt) subs.modifiedAt = sysV.modifiedAt; }
        //
        // Its sub-attributes and timestamps (observedAt, datasetId, createdAt, ...): a table, key and value
        //
        const tbl = el('table', 'esub');
        for (const [sk, sv] of Object.entries(subs)) {
          if (['type', 'value', 'object', 'objectList', 'languageMap', 'valueList', 'vocab', 'json', 'unitCode', 'entity', 'entityList'].includes(sk)) continue;
          const tr = el('tr');
          tr.append(el('th', null, sk), el('td', null, typeof sv === 'object' && sv !== null && 'type' in sv ? valueText(sv, 120) : (typeof sv === 'string' ? sv : JSON.stringify(sv))));
          tbl.append(tr);
        }
        if (tbl.rows.length) row.append(tbl);
      }
      body.append(row);
    }

    const raw = el('details', 'raw');
    raw.append(el('summary', null, 'JSON'), el('pre', null, JSON.stringify(e, null, 2)));
    body.append(raw);
  }
}
