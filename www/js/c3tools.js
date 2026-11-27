//
// c3tools.js - the c3 commands: what the AI Assist model may do to c³'s own page, and how each is done
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Each command is one entry of COMMANDS: its MCP definition (name, description, inputSchema) - sent with
// every question, so the backend's MCP server lists exactly these - and run(args), which carries it out and
// returns the text the model gets back. A command that changes the view ('changes: true') is recorded with
// the view as it was before it: undo puts that view back. A command with effects beyond the view (a build,
// a broker started) asks the user first (ctx.confirm) and returns {text, undo}: its own undo - cancel the
// build, stop the broker. A new c3 service = a new entry here.
//
// The view a change is undone to: the types' own colours, the types loaded and hidden, graph or map, the
// highlighted entities, the selected one, the map's label attribute and colour-by.
//

import * as api from './api.js';
import { t, plural } from './i18n.js';
import { populateGenerate, POPULATE_MAX_ENTITIES, POPULATE_MAX_VALUES } from './populate.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

//
// A type as the user or the model names it -> the type as Explore has it: exact, then the short name
// (the IRI's last part), any case, a plural 's' allowed
//
function typeResolver(connect) {
  const known = () => {
    const all = new Set(connect.disc ? connect.disc.types.map((t) => t.name) : []);
    for (const t of connect.loadedKinds.keys()) all.add(t);
    for (const e of connect.entities) for (const t of [].concat(e.type || [])) all.add(t);
    return [...all].sort();
  };
  const label = (t) => { const m = t.match(/[#/]([^#/]+)$/); return m && /^https?:/.test(t) ? m[1] : t; };

  return {
    known,
    label,
    resolve(name) {
      const types = known();
      if (types.includes(name)) return name;
      const n = String(name).toLowerCase();
      for (const t of types) if (label(t).toLowerCase() === n) return t;
      for (const t of types) if (label(t).toLowerCase() + 's' === n || label(t).toLowerCase() === n + 's') return t;
      return null;
    },
  };
}

//
// A CSS colour (a name, #rgb, rgb(...)) -> '#rrggbb'; null if it is none
//
function colourHex(c) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#010203';
  ctx.fillStyle = String(c);
  const v = ctx.fillStyle;
  if (v === '#010203' && String(c).toLowerCase() !== '#010203') return null;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

const TYPES = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Entity types - the short names as get_view lists them (Store, Vehicle) or the full IRIs' };

//
// ctx: {compile, run, confirm({title, lines}) -> Promise<bool>, onExploreMoved(), progress(text) - what a long command does now,
//       report({title, body, labels}) -> Promise<'opened' | 'dismissed'>}
//
export function c3Tools(connect, ctx = {}) {
  const types = typeResolver(connect);
  const history = [];                            // [{n, name, args, at, before | undo}]
  const undone = [];                             // [{n, command, args, at, undoneAt, by}] - by "user" or "assistant"
  let counter = 0;

  const resolveAll = (names) => {
    const out = [];
    const bad = [];
    for (const n of names || []) { const t = types.resolve(n); if (t) out.push(t); else bad.push(n); }
    if (bad.length) throw new Error(`no type ${bad.join(', ')} in Explore - it has: ${types.known().map(types.label).join(', ') || 'none'}`);
    return out;
  };

  const snapshot = () => ({
    colours: connect.typeColours(),
    picks: [...connect.picks],
    hidden: [...connect.hidden].sort(),
    view: connect.view,
    highlighted: [...connect.highlighted].sort(),
    selected: connect.graph.sel || null,
    label: connect.emap.labelAttr || null,
    colourBy: connect.colourBy || 'type',
  });

  const setColourBy = (v) => {
    connect.colourBy = v;
    connect.renderMapChrome();
    if (connect.broker) connect.saveConnect({ colourBy: v });
  };

  const restore = async (st) => {
    const now = snapshot();
    if (!same(now.colours, st.colours)) connect.setTypeColours(st.colours, true);
    if (!same(now.picks, st.picks)) { connect.setPicks(st.picks); await connect.loadPicks(true); }
    if (!same(snapshot().hidden, st.hidden)) connect.setHidden(st.hidden);
    if (now.view !== st.view) await connect.setView(st.view, true);
    if (!same(now.highlighted, st.highlighted)) connect.highlight(st.highlighted);
    if (now.label !== st.label) { connect.emap.setLabelAttr(st.label); if (connect.shownId) connect.showEntity(connect.shownId); }
    if (now.colourBy !== st.colourBy) setColourBy(st.colourBy);
    if ((connect.graph.sel || null) !== st.selected) {
      if (st.selected) connect.follow(st.selected); else connect.graph.select(null);
    }
  };

  const shown = (id) => connect.byId.has(id);

  //
  // The broker of this conversation: a read, a write (an error the model reads, unless 'soft'), a subscription's
  // dry run - the entities it matches now
  //
  const short = (id) => String(id).split(':').pop();
  const plain = (p) => decodeURIComponent(p);                  // a path as the user reads it
  const brokerError = (r) => new Error(`the broker answered ${r.status}: ${(r.body && (r.body.title || '')) || ''}${r.body && r.body.detail ? ' - ' + r.body.detail : ''}`);
  const read = async (path) => { const r = await api.brokerGet(connect.broker, path); if (!r.ok) throw brokerError(r); return r.body; };
  const write = async (method, path, body, soft = false) => {
    const ct = body && body['@context'] ? 'application/ld+json' : 'application/json';
    const r = await api.brokerWrite(connect.broker, method, path, body, ct);
    if (!r.ok && !soft) throw brokerError(r);
    return r;
  };
  const SYSTEM = ['createdAt', 'modifiedAt', 'status', 'notification.timesSent', 'notification.timesFailed', 'notification.lastNotification', 'notification.lastFailure', 'notification.lastSuccess', 'notification.status', 'notification.lastErrorReason', 'notification.consecutiveErrors'];
  const clean = (sub) => {
    const c = JSON.parse(JSON.stringify(sub));
    for (const k of SYSTEM) { const [a, b] = k.split('.'); if (b) { if (c[a]) delete c[a][b]; } else delete c[a]; }
    return c;
  };
  const recreate = async (path, sub) => { await write('DELETE', path); await write('POST', '/ngsi-ld/v1/subscriptions', clean(sub)); };
  const undoCreate = (ids) => (ids.length ? async () => { for (const id of ids) await write('DELETE', '/ngsi-ld/v1/entities/' + encodeURIComponent(id), undefined, true); return `${ids.length} deleted`; } : null);
  const matchesNow = async (sub) => {
    const out = [];
    for (const e of sub.entities || []) {
      if (!e.type) continue;
      const q = new URLSearchParams({ type: e.type, count: 'true', limit: '0' });
      if (e.id) q.set('id', e.id);
      if (e.idPattern) q.set('idPattern', e.idPattern);
      if (sub.q) q.set('q', sub.q);
      try {
        const r = await api.brokerGet(connect.broker, '/ngsi-ld/v1/entities?' + q);
        const n = r.ok ? r.headers.get('NGSILD-Results-Count') : null;
        if (n !== null) {
          out.push(sub.q
            ? plural(Number(n), 'dry run: {n} {type} entity matches (with its q) now', 'dry run: {n} {type} entities match (with its q) now', { type: e.type })
            : plural(Number(n), 'dry run: {n} {type} entity matches now', 'dry run: {n} {type} entities match now', { type: e.type }));
        } else {
          out.push(sub.q
            ? t('dry run: the broker answered {status} to the query of {type} with its q', { status: r.status, type: e.type })
            : t('dry run: the broker answered {status} to the query of {type}', { status: r.status, type: e.type }));
        }
      } catch { /* no dry run */ }
    }
    return out;
  };

  const COMMANDS = [
    {
      name: 'get_view',
      description: 'What c³\'s Explore page shows now: the broker and tenant, graph or map, every type Explore knows (with its count, colour, whether it is loaded and hidden), the highlighted and the selected entity. Use it before naming types in another command.',
      inputSchema: { type: 'object', properties: {} },
      run() {
        const counts = new Map((connect.disc ? connect.disc.types : []).map((t) => [t.name, t.count]));
        const own = connect.typeColours();
        const loaded = new Map();
        for (const e of connect.entities) for (const t of [].concat(e.type || [])) loaded.set(t, (loaded.get(t) || 0) + 1);
        return JSON.stringify({
          broker: connect.broker, tenant: connect.tenant || null, view: connect.view,
          types: types.known().map((t) => ({
            type: types.label(t), iri: t !== types.label(t) ? t : undefined,
            entities: counts.get(t), shown: loaded.get(t) || 0, colour: connect.colourOf(t), ownColour: !!own[t],
            loaded: connect.picks.length === 0 || connect.picks.includes(t), hidden: connect.hidden.has(t),
          })),
          entitiesShown: connect.entities.length,
          highlighted: [...connect.highlighted], selected: connect.graph.sel || null,
          mapLabel: connect.emap.labelAttr || null, colourBy: connect.colourBy || 'type', changes: history.length,
        });
      },
    },
    {
      name: 'set_type_colour',
      description: 'Paint the entities of some types in a colour - in the graph, on the map, in the lists. Kept for the broker. colour "default" gives the types their usual colour back.',
      inputSchema: { type: 'object', properties: { types: TYPES, colour: { type: 'string', description: 'A CSS colour: green, #2e7d32, rgb(46,125,50) - or "default"' } }, required: ['types', 'colour'] },
      changes: true,
      run({ types: names, colour }) {
        const ts = resolveAll(names);
        const own = connect.typeColours();
        const reset = /^(default|reset|none|original)$/i.test(String(colour));
        const hex = reset ? null : colourHex(colour);
        if (!reset && !hex) throw new Error(`"${colour}" is not a colour`);
        for (const t of ts) { if (reset) delete own[t]; else own[t] = hex; }
        connect.setTypeColours(own, true);
        return reset ? `${ts.map(types.label).join(', ')}: the usual colour again` : `${ts.map(types.label).join(', ')} painted ${hex}`;
      },
    },
    {
      name: 'show_types',
      description: 'Show the entities of some types again (they are loaded but were hidden). only: true hides every other type.',
      inputSchema: { type: 'object', properties: { types: TYPES, only: { type: 'boolean', description: 'Hide all other types (default false)' } }, required: ['types'] },
      changes: true,
      run({ types: names, only }) {
        const ts = resolveAll(names);
        const hidden = only ? new Set(types.known().filter((t) => !ts.includes(t))) : new Set(connect.hidden);
        for (const t of ts) hidden.delete(t);
        connect.setHidden([...hidden]);
        const notLoaded = connect.picks.length ? ts.filter((t) => !connect.picks.includes(t)) : [];
        return `shown: ${ts.map(types.label).join(', ')}` + (only ? ' - every other type hidden' : '') +
          (notLoaded.length ? `. Not loaded, so not drawn: ${notLoaded.map(types.label).join(', ')} - load_types does that` : '');
      },
    },
    {
      name: 'hide_types',
      description: 'Hide the entities of some types (they stay loaded; show_types brings them back).',
      inputSchema: { type: 'object', properties: { types: TYPES }, required: ['types'] },
      changes: true,
      run({ types: names }) {
        const ts = resolveAll(names);
        connect.setHidden([...new Set([...connect.hidden, ...ts])]);
        return `hidden: ${ts.map(types.label).join(', ')}`;
      },
    },
    {
      name: 'load_types',
      description: 'Load the entities of some types from the broker into Explore (the types ticked in its list). add: false loads only these, dropping the others.',
      inputSchema: { type: 'object', properties: { types: TYPES, add: { type: 'boolean', description: 'Keep the types loaded already (default true)' } }, required: ['types'] },
      changes: true,
      async run({ types: names, add }) {
        if (!connect.disc) throw new Error('this broker has no type discovery - Explore loads all its entities already');
        const ts = resolveAll(names);
        const picks = add === false ? ts : [...new Set([...connect.picks, ...ts])];
        connect.setPicks(picks);
        await connect.loadPicks(true);
        return `loaded: ${connect.picks.map(types.label).join(', ')} - ${connect.entities.length} entities shown`;
      },
    },
    {
      name: 'highlight',
      description: 'Ring entities in the graph and on the map, to point them out - e.g. the ones an answer is about. Replaces the highlight before (add: true keeps it); ids [] clears it.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Entity ids, in full' }, add: { type: 'boolean' } }, required: ['ids'] },
      changes: true,
      run({ ids, add }) {
        const all = add ? [...new Set([...connect.highlighted, ...ids])] : [...new Set(ids)];
        connect.highlight(all);
        const off = ids.filter((id) => !shown(id));
        return all.length === 0 ? 'highlight cleared' :
          `${all.length} highlighted` + (off.length ? `; not shown in Explore (their types are not loaded): ${off.join(', ')}` : '');
      },
    },
    {
      name: 'select_entity',
      description: 'Select an entity in Explore: centred, its attributes in the Entity panel. One not shown is brought in with its neighbourhood.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The entity id, in full' } }, required: ['id'] },
      changes: true,
      run({ id }) {
        if (location.hash !== '#connect') location.hash = '#connect';
        connect.follow(id);
        return `selected ${id}`;
      },
    },
    {
      name: 'show_history',
      description: 'Open Explore\'s History panel: an entity\'s history over a time range, for the user to see - a graph per attribute, '
        + 'or a table. One attribute in attrs: that attribute\'s History (its instances, to edit or delete); several, or none: the '
        + 'entity\'s, those attributes ticked (none: those with a number, a boolean or a text). The range: preset (1h, 24h, 7d, 30d), '
        + 'or from and to (ISO 8601); left out, the range the user had. Read the values themselves with the temporal tool; this shows them.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The entity id, in full' },
          attrs: { type: 'array', items: { type: 'string' }, description: 'The attributes - one: that attribute\'s History' },
          preset: { type: 'string', enum: ['1h', '24h', '7d', '30d'] },
          from: { type: 'string', description: 'ISO 8601 - with to, instead of preset' },
          to: { type: 'string', description: 'ISO 8601 - with from' },
          view: { type: 'string', enum: ['graph', 'table'], description: 'graph (default) or table' },
        },
        required: ['id'],
      },
      async run({ id, attrs, preset, from, to, view }) {
        if (!connect.broker) throw new Error('Explore is connected to no broker');
        let e = connect.byId.get(id);
        if (!e) {
          const r = await api.brokerGet(connect.broker, '/ngsi-ld/v1/entities/' + encodeURIComponent(id));
          if (!r.ok || !r.body || typeof r.body !== 'object') throw new Error(r.status === 404 ? `no entity ${id} in the broker` : `the broker answered ${r.status} for ${id}`);
          e = r.body;
        }
        const has = (a) => a in e && a !== 'id' && a !== 'type';
        const want = (attrs || []).filter(has);
        const unknown = (attrs || []).filter((a) => !has(a));
        if (attrs && attrs.length && !want.length) throw new Error(`${id} has none of ${attrs.join(', ')} - it has ${Object.keys(e).filter(has).join(', ')}`);
        const tp = connect.temporal;
        let range;
        if (from || to) {
          const f = Date.parse(from), u = to ? Date.parse(to) : Date.now();
          if (!(f < u)) throw new Error('from and to: ISO 8601, from before to');
          tp.saveRange({ preset: 'custom', from: f, to: u });
          range = `${new Date(f).toISOString()} - ${new Date(u).toISOString()}`;
        } else if (preset) {
          tp.saveRange({ preset });
          range = `the last ${preset}`;
        } else range = 'the range the user had';
        if (location.hash !== '#connect') location.hash = '#connect';
        if (want.length === 1) tp.open(e, want[0]);
        else {
          if (want.length) tp.ticks = { id, attrs: want };
          tp.openEntity(e);
        }
        if (view === 'table') { tp.view = 'table'; tp.render(); }
        const what = want.length === 1 ? `the History of ${want[0]} of ${id}` : `the History of ${id}` + (want.length ? ` (${want.join(', ')})` : '');
        return `opened ${what}, ${range}, as a ${view === 'table' ? 'table' : 'graph'}` + (unknown.length ? `; ${id} has no ${unknown.join(', ')}` : '');
      },
    },
    {
      name: 'set_view',
      description: 'Explore as the graph (entities as boxes, Relationships as arrows) or on the map (entities with a location).',
      inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['graph', 'map'] } }, required: ['view'] },
      changes: true,
      async run({ view }) {
        if (view !== 'graph' && view !== 'map') throw new Error('view: graph or map');
        if (location.hash !== '#connect') location.hash = '#connect';
        await connect.setView(view, true);
        return `the ${view}`;
      },
    },
    {
      name: 'focus',
      description: 'Zoom and pan the view the user is on - the graph or the map, whichever it is - to show some entities '
        + '(all the shown ones when ids is left out): "zoom out", "show me all", "fit". It never switches between graph '
        + 'and map; to switch, use set_view first.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
      async run({ ids }) {
        if (location.hash !== '#connect') location.hash = '#connect';
        const some = ids && ids.length;
        if (connect.view === 'map') {
          await connect.emap.ready;
          const on = (ids || []).filter((id) => connect.emap.has(id));
          if (some && !on.length) return 'the map: none of them is on it (no location, or not shown) - nothing moved';
          connect.emap.fit(true, some ? on : null);
          return some ? `the map shows ${on.length} of them` : 'the map shows every shown entity with a location';
        }
        const on = (ids || []).filter((id) => connect.graph.nodes.has(id));
        if (some && !on.length) return 'the graph: none of them is in it (not loaded, or hidden) - nothing moved';
        connect.graph.fit(some ? on : null);
        return some ? `the graph shows ${on.length} of them` : 'the graph shows every shown entity';
      },
    },
    {
      name: 'map_label',
      description: 'The attribute whose value labels each entity on the map (null: the entities\' names again).',
      inputSchema: { type: 'object', properties: { attribute: { type: ['string', 'null'] } }, required: ['attribute'] },
      changes: true,
      run({ attribute }) {
        connect.emap.setLabelAttr(attribute || null);
        if (connect.shownId) connect.showEntity(connect.shownId);
        return attribute ? `the map labels show ${attribute}` : 'the map labels show the names';
      },
    },
    {
      name: 'colour_by',
      description: 'The map\'s markers coloured by type, or by the target of a Relationship (each target its colour, the entities pointing at it the same).',
      inputSchema: { type: 'object', properties: { by: { type: 'string', description: '"type", or a Relationship\'s name' } }, required: ['by'] },
      changes: true,
      run({ by }) {
        const names = connect.colourOptions().map(([n]) => n);
        if (by !== 'type' && !names.includes(by)) throw new Error(`no Relationship ${by} among the shown entities - there are: ${names.join(', ') || 'none'}`);
        setColourBy(by);
        return `the map coloured by ${by}`;
      },
    },
    // ---------------------------------------------------------------- Compile and Operate
    {
      name: 'compile_options',
      description: 'What Compile can build on this machine: the feature switches (COR_FEATURE_*, each with its default, group, description and what it requires), the bridges (mqtt, modbus, dds, ckan - default and available), the modes (release, debug, pgo, tune) and the builds kept. corDB, the built-in store, is always built; MONGOC adds MongoDB.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const caps = await api.capabilities();
        if (!caps.compile.available) throw new Error('Compile is not available here: ' + caps.compile.why);
        const f = await api.compileFeatures();
        const builds = await api.builds();
        return JSON.stringify({
          version: f.version, pgo: caps.compile.pgo, pgoWhy: caps.compile.pgoWhy || undefined,
          features: (f.features || []).map((x) => ({ name: x.name, default: x.default, group: x.group, description: x.description, requires: x.requires && x.requires.length ? x.requires : undefined })),
          bridges: f.bridges || [],
          builds: (Array.isArray(builds) ? builds : builds.builds || []).slice(0, 10).map((b) => ({ name: b.name, state: b.state, mode: b.mode, started: b.started })),
        });
      },
    },
    {
      name: 'start_build',
      description: 'Build a coraine with Compile (coraine-build): the user is shown the command and asked first. Give only the switches that differ from their defaults. A build takes minutes - it is started and shown in Compile; build_status follows it. Undo cancels it.',
      inputSchema: { type: 'object', properties: {
        name: { type: 'string', description: 'The build\'s name (default: one made up from the options)' },
        mode: { type: 'string', enum: ['release', 'debug', 'pgo', 'tune'], description: 'release (default), debug, pgo (profile-guided) or tune (pgo on a workload)' },
        httpServer: { type: 'string', enum: ['mhd', 'builtin'] },
        features: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Switches by name (without COR_FEATURE_): {"MONGOC": false}' },
        bridges: { type: 'array', items: { type: 'string' }, description: 'The bridges to build: ["mqtt", "dds"] - the whole list; leave out for the default (mqtt, modbus)' },
      } },
      async run(args) {
        const body = { mode: args.mode || 'release', features: args.features || {} };
        if (args.name) body.name = args.name;
        if (args.httpServer) body.httpServer = args.httpServer;
        if (args.bridges) body.bridges = args.bridges;
        const plan = await api.buildCommand(body);
        body.name = plan.name;
        if (!(await ctx.confirm({ title: t('Start this build?'), lines: [plan.argv.join(' ')] }))) return { text: 'the user declined - not started', declined: true };
        const build = await api.buildStart(body);
        location.hash = '#compile';
        if (ctx.compile) { ctx.compile.open(build); ctx.compile.loadBuilds(); }
        return {
          text: `build ${build.name} started (${body.mode}) - Compile shows its log; build_status follows it`,
          undo: async () => {
            const b = await api.build(build.name);
            if (b.state !== 'running') return `${build.name} had ended already (${b.state}) - nothing cancelled`;
            await api.buildDelete(build.name);
            return `${build.name} cancelled`;
          },
        };
      },
    },
    {
      name: 'build_status',
      description: 'One build of Compile (by name; the newest when left out): its state (running, done, failed, cancelled), the phase it is in, how long it ran, the size of what it made, the built broker\'s version.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      async run({ name }) {
        const list = await api.builds();
        const all = Array.isArray(list) ? list : list.builds || [];
        const b = name ? await api.build(name) : all[0];
        if (!b) return 'no builds';
        const keep = ['name', 'state', 'mode', 'phase', 'phases', 'started', 'ended', 'exitStatus', 'error', 'size', 'version', 'features', 'bridges'];
        return JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => keep.includes(k))));
      },
    },
    {
      name: 'cancel_build',
      description: 'Cancel the build that runs (the user is asked first).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run({ name }) {
        const b = await api.build(name);
        if (b.state !== 'running') return `${name} is not running (${b.state})`;
        if (!(await ctx.confirm({ title: t('Cancel the build {name}?', { name }), lines: [] }))) return { text: 'the user declined - still running', declined: true };
        await api.buildDelete(name);
        if (ctx.compile) ctx.compile.loadBuilds();
        return `${name} cancelled`;
      },
    },
    {
      name: 'operate_status',
      description: 'Operate: the brokers c³ keeps (name, state, where it listens, from a build, the installed coraine or an image, native or in a container, its store) and the services they use (MongoDB, TimescaleDB, Mosquitto).',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const r = await api.run();
        const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
        return JSON.stringify({
          brokers: (r.brokers || []).map((b) => pick(b, ['name', 'state', 'url', 'port', 'from', 'build', 'image', 'where', 'store', 'history', 'bridges', 'health', 'error'])),
          services: (r.services || []).map((x) => pick(x, ['container', 'label', 'state', 'port', 'usedBy'])),
          containers: r.containers !== undefined ? r.containers : undefined,
        });
      },
    },
    {
      name: 'start_broker',
      description: 'Start a broker with Operate (the user is shown the command and asked first): from one of Compile\'s builds, the installed coraine, or an image; native or in a container; its store corDB or mongoc (MongoDB, started as a container). Undo stops it.',
      inputSchema: { type: 'object', properties: {
        name: { type: 'string', description: 'The broker\'s name in Operate' },
        from: { type: 'string', enum: ['build', 'installed', 'image'] },
        build: { type: 'string', description: 'from build: the build\'s name' },
        image: { type: 'string', description: 'from image: the tag' },
        where: { type: 'string', enum: ['native', 'container'], description: 'default native (a build runs natively)' },
        store: { type: 'string', enum: ['corDB', 'mongoc'], description: 'default corDB' },
        history: { type: 'string', enum: ['none', 'corDB', 'timescale'], description: 'temporal history, default none' },
        port: { type: 'integer', description: 'default: the first free one from 1026' },
        bridges: { type: 'array', items: { type: 'string' }, description: 'bridges to load: ["dds"]' },
        websocket: { type: 'boolean', description: 'the WebSocket transport (live values without HTTP subscriptions)' },
        bridgeConfig: { type: 'string', description: 'A bridge configuration file of the user\'s (absolute path); without one c³ writes the defaults for mqtt and dds' },
      }, required: ['name', 'from'] },
      async run(args) {
        const st = await api.run();
        const used = new Set((st.brokers || []).map((b) => b.port));
        let port = args.port;
        for (port = port || 1026; !args.port && used.has(port); port++);
        const def = {
          name: args.name, set: args.store === 'mongoc' ? 'mongoc-timescale' : 'cordb', from: args.from, where: args.where || 'native',
          store: args.store || 'corDB', history: args.history || 'none', port, healthPort: 0, grace: 30,
          transports: args.websocket ? ['ws'] : [], admin: true, verbose: false, bridges: args.bridges || [], args: '',
        };
        if (args.from === 'build') def.build = args.build;
        if (args.from === 'image') def.image = args.image;
        if (args.bridgeConfig) def.bridgeConfig = args.bridgeConfig;
        const plan = await api.runCommand(def);
        if (!plan.argv.length) throw new Error(plan.problem || 'Operate cannot start it');
        const lines = [plan.argv.join(' '), ...plan.services.map((s) => t('first: {container} - {label}, {image}', { container: s.container, label: s.label, image: s.image }))];
        if (!(await ctx.confirm({ title: t('Start the broker {name}?', { name: args.name }), lines }))) return { text: 'the user declined - not started', declined: true };
        await api.runStart(def);
        location.hash = '#run';
        if (ctx.run) { await ctx.run.refresh(); ctx.run.select('broker', args.name); }
        const url = 'http://localhost:' + port;
        const undo = async () => { await api.runStop(args.name); if (ctx.run) ctx.run.refresh(); return `${args.name} stopped`; };

        //
        // Up, or not: at most 30 s - the answer says which, a failure with the end of its log
        //
        let b = null;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          b = ((await api.run()).brokers || []).find((x) => x.name === args.name);
          if (!b || (b.state === 'running' && b.ready !== false) || ['failed', 'stopped'].includes(b.state)) break;
        }
        if (ctx.run) ctx.run.refresh();
        if (b && b.state === 'running') return { text: `${args.name} runs on ${url} - connect_explore opens it in Explore`, undo };
        let tail = '';
        try {
          const r = await fetch('/api/run/brokers/' + encodeURIComponent(args.name) + '/log');
          tail = (await r.text()).trim().split('\n').slice(-6).join('\n');
        } catch { /* no log */ }
        if (b && ['failed', 'stopped'].includes(b.state)) throw new Error(`${args.name} did not start (${b.state}${b.why ? ': ' + b.why : ''}). The end of its log:\n${tail}`);
        return { text: `${args.name} is still starting after 30 s (${b ? b.state : 'unknown'}) - operate_status follows it. Its log so far:\n${tail}`, undo };
      },
    },
    {
      name: 'stop_broker',
      description: 'Stop a broker of Operate (the user is asked first). Undo starts it again.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run({ name }) {
        if (!(await ctx.confirm({ title: t('Stop the broker {name}?', { name }), lines: [] }))) return { text: 'the user declined - still running', declined: true };
        await api.runStop(name);
        if (ctx.run) ctx.run.refresh();
        return { text: `${name} stopping`, undo: async () => { await api.runStartKept(name); if (ctx.run) ctx.run.refresh(); return `${name} started again`; } };
      },
    },
    //
    // Writes to the broker - each one shown to the user as the exact request, with what it would do now (the
    // dry run: the entities a subscription matches, an index's cost), and done only on "Do it"; undo takes it back
    //
    {
      name: 'create_subscription',
      description: 'Create a subscription on the broker of this conversation. The user sees the exact request, and how many entities it matches now, and says yes or no. Names as in the broker\'s data: the short names of the core @context, or full IRIs, or the body\'s own "@context". Undo deletes it.',
      inputSchema: { type: 'object', properties: { subscription: { type: 'object', description: 'The NGSI-LD Subscription (type "Subscription"; an id is given when it has none)' } }, required: ['subscription'] },
      async run({ subscription }) {
        const sub = { type: 'Subscription', ...subscription };
        if (!sub.id) sub.id = 'urn:ngsi-ld:Subscription:' + Math.random().toString(36).slice(2, 10);
        const lines = ['POST /ngsi-ld/v1/subscriptions' + (connect.tenant ? '   ' + t('(tenant {tenant})', { tenant: connect.tenant }) : ''), JSON.stringify(sub, null, 2), ...(await matchesNow(sub))];
        if (!(await ctx.confirm({ title: t('Create this subscription?'), lines }))) return { text: 'the user declined - not created', declined: true };
        await write('POST', '/ngsi-ld/v1/subscriptions', sub);
        return { text: `created: ${sub.id}`, undo: async () => { await write('DELETE', '/ngsi-ld/v1/subscriptions/' + encodeURIComponent(sub.id)); return `${sub.id} deleted`; } };
      },
    },
    {
      name: 'update_subscription',
      description: 'Change a subscription: a fix (the watched attribute, the q, the entity type, the endpoint), isActive true or false, a new expiresAt. Only the members given change. The user sees the subscription before and after and says yes or no. Undo puts the old members back.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, changes: { type: 'object', description: 'The members to change, e.g. {"watchedAttributes": ["temperature"]}' } }, required: ['id', 'changes'] },
      async run({ id, changes }) {
        const path = '/ngsi-ld/v1/subscriptions/' + encodeURIComponent(id);
        const was = await read(path);
        const before = {};
        for (const k of Object.keys(changes)) before[k] = k in was ? was[k] : null;
        const lines = [`PATCH ${plain(path)}`, t('now:') + '   ' + JSON.stringify(before), t('after:') + ' ' + JSON.stringify(changes), ...(await matchesNow({ ...was, ...changes }))];
        if (!(await ctx.confirm({ title: t('Change the subscription {id}?', { id: short(id) }), lines }))) return { text: 'the user declined - unchanged', declined: true };
        await write('PATCH', path, changes);
        const back = {};
        const gone = [];
        for (const [k, v] of Object.entries(before)) { if (v === null) gone.push(k); else back[k] = v; }
        return {
          text: `${short(id)} changed`,
          undo: async () => {
            if (Object.keys(back).length) await write('PATCH', path, back);
            if (gone.length) { const now = await read(path); for (const k of gone) delete now[k]; await recreate(path, now); }
            return `${short(id)} as it was`;
          },
        };
      },
    },
    {
      name: 'delete_subscription',
      description: 'Delete a subscription (the user is asked first). Undo creates it again, as it was.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const path = '/ngsi-ld/v1/subscriptions/' + encodeURIComponent(id);
        const was = await read(path);
        if (!(await ctx.confirm({ title: t('Delete the subscription {id}?', { id: short(id) }), lines: [`DELETE ${plain(path)}`, JSON.stringify(was, null, 2)] }))) return { text: 'the user declined - not deleted', declined: true };
        await write('DELETE', path);
        return { text: `${short(id)} deleted`, undo: async () => { await write('POST', '/ngsi-ld/v1/subscriptions', clean(was)); return `${short(id)} created again`; } };
      },
    },
    {
      name: 'create_index',
      description: 'Declare an index on an attribute (coraine\'s admin API, POST /admin/indexes) - after you have read when one pays off (search_docs "declared index"). The user sees the request and its cost and says yes or no. On corDB a change rebuilds every declared index while writes wait: for a permanent one, advise --dbValueIndexes at start as well. Undo drops it.',
      inputSchema: { type: 'object', properties: { attribute: { type: 'string' }, type: { type: 'string', description: 'Only this entity type\'s queries (optional)' }, tenant: { type: 'string', description: 'Only this tenant (optional; default: every tenant)' } }, required: ['attribute'] },
      async run({ attribute, type, tenant }) {
        const body = { attribute };
        if (type) body.type = type;
        if (tenant) body.tenant = tenant;
        const have = await read('/admin/indexes').catch(() => null);
        const n = Array.isArray(have) ? have.length : null;
        const lines = ['POST /admin/indexes', JSON.stringify(body),
          t('The index is built now, in every tenant it covers; a large store takes a while.') + (n ? ' ' + t('On corDB the {n} declared already are rebuilt with it, writes waiting meanwhile.', { n }) : '')];
        if (!(await ctx.confirm({ title: t('Declare an index on {attribute}?', { attribute }), lines }))) return { text: 'the user declined - not declared', declined: true };
        const r = await write('POST', '/admin/indexes', body);
        const loc = r.location || '';
        return { text: `declared${loc ? ': ' + loc : ''} - GET /admin/indexes (list_indexes) shows its accesses`, undo: loc ? async () => { await write('DELETE', loc.replace(/^https?:\/\/[^/]+/, '')); return `the index on ${attribute} dropped`; } : null };
      },
    },
    {
      name: 'update_entity',
      description: 'Change attributes of one entity (PATCH its attrs) - e.g. a value set right, an attribute added. The user sees the values before and after and says yes or no. Undo writes the old values back (an added attribute is deleted).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, attrs: { type: 'object', description: 'NGSI-LD attributes: {"temperature": {"type": "Property", "value": 21}}' } }, required: ['id', 'attrs'] },
      async run({ id, attrs }) {
        const path = '/ngsi-ld/v1/entities/' + encodeURIComponent(id);
        const was = await read(path + '?attrs=' + Object.keys(attrs).map(encodeURIComponent).join(','));
        const before = {};
        for (const k of Object.keys(attrs)) before[k] = k in was ? was[k] : null;
        const lines = [`PATCH ${plain(path)}/attrs`, t('now:') + '   ' + JSON.stringify(before), t('after:') + ' ' + JSON.stringify(attrs)];
        if (!(await ctx.confirm({ title: t('Change {id}?', { id: short(id) }), lines }))) return { text: 'the user declined - unchanged', declined: true };
        await write('PATCH', path + '/attrs', attrs);
        return {
          text: `${short(id)} changed`,
          undo: async () => {
            const back = Object.fromEntries(Object.entries(before).filter(([, v]) => v !== null));
            if (Object.keys(back).length) await write('PATCH', path + '/attrs', back);
            for (const [k, v] of Object.entries(before)) if (v === null) await write('DELETE', path + '/attrs/' + encodeURIComponent(k));
            return `${short(id)} as it was`;
          },
        };
      },
    },
    {
      name: 'create_entities',
      description: 'Create entities (up to 100) - e.g. after modelling the user\'s data on a Smart Data Model. The user sees them and says yes or no. Undo deletes them.',
      inputSchema: { type: 'object', properties: { entities: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 100 } }, required: ['entities'] },
      async run({ entities }) {
        const lines = ['POST /ngsi-ld/v1/entityOperations/create - ' + plural(entities.length, '{n} entity', '{n} entities'), JSON.stringify(entities.length > 3 ? [...entities.slice(0, 3), t('... {n} more', { n: entities.length - 3 })] : entities, null, 2)];
        const one = entities.length === 1 ? short(entities[0].id || '') : '';
        const title = entities.length !== 1 ? t('Create {n} entities?', { n: entities.length }) : one ? t('Create {id}?', { id: one }) : t('Create this entity?');
        if (!(await ctx.confirm({ title, lines }))) return { text: 'the user declined - not created', declined: true };
        const made = [];
        for (const e of entities) {
          const r = await write('POST', '/ngsi-ld/v1/entities', e, true);
          if (r.ok) made.push(e.id); else return { text: `created ${made.length}; ${e.id} refused: ${r.status} ${r.body && (r.body.title || '')} ${r.body && (r.body.detail || '')}`, undo: undoCreate(made) };
        }
        return { text: `created ${made.length}`, undo: undoCreate(made) };
      },
    },
    {
      name: 'populate_broker',
      description: 'Fill a TEST broker with a realistic dataset made from a short spec - c³ makes the entities (and their history), you do not write them one by one. '
        + `Up to ${POPULATE_MAX_ENTITIES} entities and ${POPULATE_MAX_VALUES} history values in one go. Ids: urn:ngsi-ld:<Type>:<idPrefix>-001... (idPrefix default: the type in lower case). `
        + 'Each attribute has ONE generator: value (the same on all), pick [list] (weights optional), text "Hall {n}" / "SN-{n:5}" / "{type} {n}", range [min, max] (uniform, a new value at every history instant), '
        + 'walk {start (or [min, max]), step, min, max} (a random walk), point {bbox: [west, south, east, north]} | {polygon: [[lon, lat], ...]} | {line: [[lon, lat], ...]} (a GeoProperty Point - longitude first), '
        + 'rel "<another type of the spec>" (how: roundRobin | group | random) or rel "urn:..." (a Relationship). Options: unitCode (CEL, P1, KWH), decimals (default 2), observedAt (default on for range and walk). '
        + 'history {duration: "7d" | from: "<ISO date>", every: "15m"}: the range and walk attributes get a value at every instant up to now, oldest first; only on a broker that keeps temporal history (refused otherwise, saying why). '
        + 'seed: the same spec and seed give the same data. tenant: where it goes (default: the tenant Explore is on). context: an @context URL when the type and attribute names are not the core context\'s. '
        + 'Never overwrites: ids already in the tenant are refused. The user sees the counts and samples and says yes or no. Undo deletes the entities and their history. '
        + 'Take the attribute names from the Smart Data Model (smart_data_model) when one fits; ask the user for the scale and the area when they did not say.',
      inputSchema: { type: 'object', properties: {
        types: { type: 'array', minItems: 1, items: { type: 'object', properties: {
          type: { type: 'string' }, count: { type: 'integer', minimum: 1 }, idPrefix: { type: 'string' },
          attrs: { type: 'object', description: '{"temperature": {"walk": {"start": 21, "step": 0.3, "min": 15, "max": 35}, "unitCode": "CEL", "decimals": 1}, "refBuilding": {"rel": "Building", "how": "group"}, "location": {"point": {"bbox": [-3.71, 40.41, -3.69, 40.43]}}}' },
        }, required: ['type', 'count'] } },
        history: { type: 'object', properties: { duration: { type: 'string' }, from: { type: 'string' }, every: { type: 'string' } } },
        seed: { type: 'integer' },
        tenant: { type: 'string' },
        context: { description: 'An @context: a URL or an array' },
      }, required: ['types'] },
      async run(spec) {
        const data = populateGenerate(spec, new Date());
        const tenant = spec.tenant;                                            // undefined: the page's own
        const tenantName = (tenant !== undefined ? tenant : connect.tenant) || t('the default tenant');
        const ct = data.context !== undefined ? 'application/ld+json' : 'application/json';
        const get = (path) => api.brokerGet(connect.broker, path, tenant);
        const send = (method, path, body) => api.brokerWrite(connect.broker, method, path, body, ct, tenant);
        const say = (text) => { if (ctx.progress) ctx.progress(text); };

        //
        // Does the broker keep temporal history? coraine says so in /build (the TRoE plugin loaded: "none" =
        // no history); another broker: its temporal API answers or not
        //
        say(t('Asking the broker whether it keeps temporal history ...'));
        let troe = null;
        const build = await api.brokerGet(connect.broker, '/build');
        if (build.ok && build.body && build.body.plugins && build.body.plugins.loaded) {
          const tp = build.body.plugins.loaded.temporal;
          troe = tp && tp.alias && tp.alias !== 'none' ? tp.alias : false;
        } else {
          const first = data.entities[0];
          const probe = await get('/ngsi-ld/v1/temporal/entities?type=' + encodeURIComponent(first.type) + '&timerel=before&timeAt=' + encodeURIComponent(data.to) + '&limit=1');
          troe = probe.ok ? 'its temporal API' : false;
        }
        if (spec.history && !troe) {
          throw new Error('this broker keeps no temporal history' + (build.ok ? ' (--troe none)' : ' (its temporal API does not answer)')
            + ' - the history cannot be written. Start a broker with --troe corDB (or timescale) for it, or populate without history.');
        }

        //
        // Never overwrite: the ids already there, type by type, 50 to a query
        //
        say(t('Checking that none of the {n} ids is taken ...', { n: data.entities.length }));
        const taken = [];
        for (const type of Object.keys(data.counts)) {
          const ids = data.entities.filter((e) => e.type === type).map((e) => e.id);
          for (let k = 0; k < ids.length; k += 50) {
            const part = ids.slice(k, k + 50);
            // local=true: the ids alone are too wide a query (§ 10.4.3.4); no type - under an own @context it would not expand
            const r = await get('/ngsi-ld/v1/entities?local=true&id=' + part.map(encodeURIComponent).join(',') + '&limit=50');
            if (r.status === 404) continue;                                    // a tenant not there yet: nothing in it
            if (!r.ok) throw brokerError(r);
            for (const e of Array.isArray(r.body) ? r.body : []) taken.push(e.id);
          }
        }
        if (taken.length) {
          throw new Error(`${taken.length} of these ids are already in ${tenantName} (${taken.slice(0, 5).join(', ')}${taken.length > 5 ? ', ...' : ''}) - nothing written. `
            + 'Take another idPrefix or tenant, or delete those first.');
        }

        //
        // The user sees what is coming
        //
        const n = data.entities.length;
        const lines = [
          t('Tenant: {tenant}', { tenant: tenantName }),
          Object.entries(data.counts).map(([type, c]) => `${type}: ${c}`).join(' · '),
        ];
        if (data.instants) {
          lines.push(t('History: {values} values - {instants} instants from {from} to now, every {every}', {
            values: data.values.toLocaleString(), instants: data.instants, from: data.from, every: spec.history.every,
          }));
        }
        const samples = [];
        for (const type of Object.keys(data.counts)) { const e = data.entities.find((x) => x.type === type); if (samples.length < 3) samples.push(e); }
        lines.push(JSON.stringify(samples, null, 2));
        if (!(await ctx.confirm({ title: t('Fill the broker with {n} entities?', { n }), lines }))) return { text: 'the user declined - nothing written', declined: true };

        //
        // The entities: 100 to a batch create
        //
        const made = [];
        const undo = async () => {
          for (let k = 0; k < made.length; k += 100) await send('POST', '/ngsi-ld/v1/entityOperations/delete', made.slice(k, k + 100));
          if (troe) for (const id of made) await send('DELETE', '/ngsi-ld/v1/temporal/entities/' + encodeURIComponent(id));
          return `${made.length} entities deleted${troe ? ', and their history' : ''}`;
        };
        const stopped = (what) => {
          if (made.length === 0) throw new Error(`${what} - nothing was written`);
          return { text: `${what} - ${made.length} of ${n} entities were created (undo deletes them)`, undo };
        };

        for (let k = 0; k < n; k += 100) {
          say(t('Creating the entities: {done} of {n} ...', { done: k, n }));
          const part = data.entities.slice(k, k + 100);
          const r = await send('POST', '/ngsi-ld/v1/entityOperations/create', part);
          if (r.status === 201) { made.push(...part.map((e) => e.id)); continue; }
          if (r.status === 207 && r.body) {
            const ok = new Set(r.body.success || []);
            made.push(...part.map((e) => e.id).filter((id) => ok.has(id)));
            const err = (r.body.errors || [])[0];
            return stopped(`the broker refused ${(r.body.errors || []).length} of a batch${err ? ` - ${err.entityId}: ${err.error && (err.error.title || '')} ${err.error && (err.error.detail || '')}` : ''}`);
          }
          return stopped(brokerError(r).message);
        }

        //
        // The history: each entity's instances in one request, four at a time
        //
        if (data.history.length) {
          let done = 0;
          let failure = null;
          const queue = [...data.history];
          const worker = async () => {
            while (queue.length && !failure) {
              const h = queue.shift();
              const r = await send('POST', '/ngsi-ld/v1/temporal/entities', h);
              if (!r.ok) { failure = `${h.id}: ${brokerError(r).message}`; return; }
              done++;
              if (done % 10 === 0 || done === data.history.length) say(t('Writing the history: {done} of {n} entities ...', { done, n: data.history.length }));
            }
          };
          say(t('Writing the history: {done} of {n} entities ...', { done: 0, n: data.history.length }));
          await Promise.all([worker(), worker(), worker(), worker()]);
          if (failure) return stopped(`the history stopped at ${failure} (${done} of ${data.history.length} entities' history written)`);
        }

        const per = Object.entries(data.counts).map(([type, c]) => `${type} ${c}`).join(', ');
        return {
          text: `created ${n} entities in ${tenantName} (${per})`
            + (data.instants ? `; history: ${data.values} values, ${data.instants} instants from ${data.from} to ${data.to} - temporal history by ${troe}` : '')
            + `. Ids ${data.entities[0].id} ... - Explore shows them once reloaded (connect_explore on the same broker${tenant !== undefined ? ' and tenant' : ''}).`,
          undo,
        };
      },
    },
    {
      name: 'save_rule',
      description: 'Save a corCep automation rule (a Rule entity, in corCep\'s rules tenant - "cep" unless the user says otherwise): created, or replaced when it is there. '
        + 'Always dry_run_rule it first when corMcp can; tell the user what the dry run showed. The user sees the rule (and the one it replaces) and says yes or no. '
        + 'corCep picks it up within a second. Undo deletes a new rule, or puts the old one back. enabled false keeps a rule without running it.',
      inputSchema: { type: 'object', properties: {
        rule: { type: 'object', description: 'The Rule entity, normalized: {"id": "urn:ngsi-ld:Rule:<name>", "type": "Rule", "name": {"type": "Property", "value": "..."}, "when": {"type": "JsonProperty", "json": {...}}, "then": {"type": "JsonProperty", "json": [...]}}' },
        rulesTenant: { type: 'string', description: 'corCep\'s --rules-tenant, default cep' },
      }, required: ['rule'] },
      async run({ rule, rulesTenant }) {
        const tenant = rulesTenant || 'cep';
        if (!rule || rule.type !== 'Rule' || typeof rule.id !== 'string' || !rule.when || !rule.then) throw new Error('a Rule entity with id, type "Rule", when and then is needed');
        const path = '/ngsi-ld/v1/entities/' + encodeURIComponent(rule.id);
        const old = await api.brokerGet(connect.broker, path, tenant);
        const was = old.ok ? old.body : null;
        const request = was ? t('{first}, then {second}', { first: 'DELETE ' + plain(path), second: 'POST /ngsi-ld/v1/entities' }) : 'POST /ngsi-ld/v1/entities';
        const lines = [request + '   ' + t('(tenant {tenant})', { tenant }), JSON.stringify(rule, null, 2)];
        if (was) lines.push(t('replaces:'), JSON.stringify(clean(was), null, 2));
        if (!(await ctx.confirm({ title: was ? t('Replace the rule {id}?', { id: short(rule.id) }) : t('Save the rule {id}?', { id: short(rule.id) }), lines }))) return { text: 'the user declined - not saved', declined: true };
        const put = async (method, p, body) => {
          const r = await api.brokerWrite(connect.broker, method, p, body, 'application/json', tenant);
          if (!r.ok) throw brokerError(r);
        };
        if (was) { await put('DELETE', path); await put('POST', '/ngsi-ld/v1/entities', rule); } else await put('POST', '/ngsi-ld/v1/entities', rule);
        return {
          text: `the rule ${short(rule.id)} ${was ? 'replaced' : 'saved'} in tenant ${tenant} - corCep reads it again; list_rules shows its fired count and lastError`,
          undo: async () => {
            await put('DELETE', path);
            if (was) await put('POST', '/ngsi-ld/v1/entities', clean(was));
            return was ? `the rule ${short(rule.id)} as it was` : `the rule ${short(rule.id)} deleted`;
          },
        };
      },
    },
    {
      name: 'connect_explore',
      description: 'Explore connects to a broker (its URL; a tenant, or the default one) - e.g. one just started. The conversation goes on with that broker. Undo connects Explore back.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, tenant: { type: 'string' } }, required: ['url'] },
      async run({ url, tenant }) {
        const was = { url: connect.broker, tenant: connect.tenant || '' };
        location.hash = '#connect';
        await connect.connect(url, tenant || '');
        if (ctx.onExploreMoved) ctx.onExploreMoved();
        return {
          text: `Explore is on ${connect.broker}${connect.tenant ? ', tenant ' + connect.tenant : ''} - ${connect.entities.length} entities shown. ` +
            'The broker tools of this answer still read the broker the question was asked on; from the next question on they read this one.',
          undo: was.url ? async () => { await connect.connect(was.url, was.tenant); if (ctx.onExploreMoved) ctx.onExploreMoved(); return `Explore is back on ${was.url}`; } : null,
        };
      },
    },
    {
      name: 'report_gap',
      description: 'Draft a GitHub issue for Seamware: about the assistant - what it could not do, did wrong or did slowly - or about c³ itself - a c³ bug, or an improvement the user wants in c³ ("c³ should ...", "it would be nice if ...") - when the user says so ("you cannot do X", "that is wrong", "report this"), or offers to. The assistant\'s go to its repository, c³\'s to c³\'s (public: never anything private in it). c³ shows the draft; the user edits it and files it (c³\'s File on GitHub button, or on GitHub) - nothing is sent without their press. '
        + 'Write it for the developer who will fix it: what the user asked (their words), what you did (the tools called, with their arguments, and the errors), what was missing or wrong, and what would have answered it (a tool, a filter, knowledge). '
        + 'Leave out the broker\'s URL, tenant, entity ids and values unless the user asks to keep them - describe the data instead ("a Vehicle with fuelLevel 0.05").',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['gap', 'wrong-answer', 'slow', 'other', 'c3-bug', 'c3-improvement'], description: 'the assistant: gap (could not do it), wrong-answer, slow (too many calls or too long), other; c³ itself: c3-bug (something in c³ does not work), c3-improvement (something c³ should do or do better)' },
          title: { type: 'string', description: 'One line: what could not be done, e.g. "Cannot tell why a subscription does not notify"' },
          asked: { type: 'string', description: 'What the user asked, in their words' },
          happened: { type: 'string', description: 'What the assistant did - tools, arguments, errors - and what it answered; about c³ itself: what c³ does now' },
          missing: { type: 'string', description: 'What was missing or wrong, and what would have answered it; about c³ itself: what c³ should do' },
        },
        required: ['kind', 'title', 'asked', 'happened', 'missing'],
      },
      async run(args) {
        if (!ctx.report) throw new Error('reporting is not available in this c³');
        const body = [
          '**Asked**', '', args.asked, '',
          '**What happened**', '', args.happened, '',
          '**Missing**', '', args.missing, '',
          '---', `c³ ${ctx.version || ''} · ${ctx.engine || ''} · ${new Date().toISOString().slice(0, 10)}`,
        ].join('\n');
        const c3 = args.kind === 'c3-bug' || args.kind === 'c3-improvement';
        const labels = c3 ? [args.kind === 'c3-bug' ? 'bug' : 'enhancement'] : (args.kind === 'other' ? [] : [args.kind]);
        const r = await ctx.report({ repo: c3 ? 'c3' : 'assistant', title: args.title, body, labels });
        if (r && r.filed) return `filed by the user: ${r.filed}`;
        return r === 'opened'
          ? 'the draft is open on GitHub for the user to file - do not say it is filed'
          : 'the user dismissed the draft - nothing reported';
      },
    },
    {
      name: 'list_changes',
      description: 'The c3 commands carried out (view changes, builds started, brokers started or stopped, Explore moved): "changes" - the ones that can still be undone, the most recent last; "undone" - the ones undone already, by the user (the Undo of their line) or by the assistant, with when. A command in neither was never recorded (it changed nothing).',
      inputSchema: { type: 'object', properties: {} },
      run() {
        return JSON.stringify({
          changes: history.map((h) => ({ n: h.n, command: h.name, args: h.args, at: h.at })),
          undone,
        });
      },
    },
    {
      name: 'undo',
      description: 'Undo c3 commands, the most recent first: a view change puts the view back, a build started is cancelled, a broker started is stopped (and one stopped started again), Explore goes back to the broker it was on. steps: how many of the most recent (default 1); or to: the n (from list_changes) of the first one to undo - it and every later one.',
      inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1 }, to: { type: 'integer' } } },
      async run({ steps, to }) {
        const said = await undoTo(to !== undefined ? to : (history.length ? history[Math.max(0, history.length - (steps || 1))].n : null), 'assistant');
        return said.length ? 'undone: ' + said.join('; ') : 'nothing to undo';
      },
    },
  ];

  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  let onUndone = () => {};

  //
  // undoTo - change n and every later one undone, the latest first: a view change by its snapshot, any
  // other by its own undo. What each undo said. 'by': who asked - the user (a line's Undo) or the assistant
  //
  async function undoTo(n, by = 'user') {
    const ix = history.findIndex((h) => h.n === n);
    if (ix === -1) return [];
    const gone = history.splice(ix);
    const undoneAt = new Date().toISOString();
    for (const h of [...gone].reverse()) undone.push({ n: h.n, command: h.name, args: h.args, at: h.at, undoneAt, by });
    const said = [];
    for (const h of [...gone].reverse()) {
      try {
        if (h.undo) said.push(await h.undo());
        else { await restore(h.before); said.push(h.name + ' undone'); }
      } catch (e) {
        said.push(`${h.name}: not undone - ${e.message}`);
      }
    }
    onUndone(gone.map((h) => h.n));
    return said;
  }

  return {
    definitions: COMMANDS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),

    //
    // run - a command from the model: {ok, text, n} (n: its number in the history, when recorded)
    //
    async run(name, args) {
      const c = byName.get(name);
      if (!c) return { ok: false, text: `no c3 command ${name}` };
      if (!connect.broker && c.changes) return { ok: false, text: 'Explore is not connected to a broker' };
      const before = c.changes ? snapshot() : null;
      try {
        const out = await c.run(args || {});
        const text = typeof out === 'string' ? out : out.text;
        let n;
        if (c.changes && !same(before, snapshot())) {
          n = ++counter;
          history.push({ n, name, args, at: new Date().toISOString(), before });
        } else if (out && typeof out === 'object' && typeof out.undo === 'function') {
          n = ++counter;
          history.push({ n, name, args, at: new Date().toISOString(), undo: out.undo });
        }
        return { ok: true, text: String(text), n };
      } catch (e) {
        return { ok: false, text: e.message };
      }
    },

    undoTo,
    canUndo: (n) => history.some((h) => h.n === n),
    onUndone(cb) { onUndone = cb; },
    reset() { history.length = 0; undone.length = 0; },
  };
}
