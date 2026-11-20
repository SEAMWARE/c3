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
// ctx: {compile, run, confirm({title, lines}) -> Promise<bool>, onExploreMoved()}
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
      name: 'map_focus',
      description: 'The map, moved to show some entities (all the shown ones when ids is left out).',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
      changes: true,
      async run({ ids }) {
        if (location.hash !== '#connect') location.hash = '#connect';
        if (connect.view !== 'map') await connect.setView('map', true);
        await connect.emap.ready;
        const on = (ids || []).filter((id) => connect.emap.has(id));
        connect.emap.fit(true, ids && ids.length ? on : null);
        if (ids && ids.length && !on.length) return 'none of them is on the map (no location, or not shown)';
        return ids && ids.length ? `the map shows ${on.length} of them` : 'the map shows every entity with a location';
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
        if (!(await ctx.confirm({ title: 'Start this build?', lines: [plan.argv.join(' ')] }))) return { text: 'the user declined - not started', declined: true };
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
        if (!(await ctx.confirm({ title: `Cancel the build ${name}?`, lines: [] }))) return { text: 'the user declined - still running', declined: true };
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
        const lines = [plan.argv.join(' '), ...plan.services.map((s) => `first: ${s.container} - ${s.label}, ${s.image}`)];
        if (!(await ctx.confirm({ title: `Start the broker ${args.name}?`, lines }))) return { text: 'the user declined - not started', declined: true };
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
        if (!(await ctx.confirm({ title: `Stop the broker ${name}?`, lines: [] }))) return { text: 'the user declined - still running', declined: true };
        await api.runStop(name);
        if (ctx.run) ctx.run.refresh();
        return { text: `${name} stopping`, undo: async () => { await api.runStartKept(name); if (ctx.run) ctx.run.refresh(); return `${name} started again`; } };
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
