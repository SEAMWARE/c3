//
// assist.js - AI Assist: the button, and either its popup (not available here: why) or - when the backend
// can ask (GET /api/assist) - the panel: questions about the broker Explore is connected to, answered by the
// Coraine Assistant, Seamware's service, which reads the broker with corMcp's tools - run by c³'s backend.
// Without an AI Assist token the panel asks for one (kept by the backend, never by this page)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A conversation belongs to one broker and one tenant: asked from another one, a new conversation starts.
// The answer arrives as server-sent events on the POST's response (assist.c): start, text, tool,
// toolResult, usage, end, error - and ui: a c3 command (c3tools.js) for this page to carry out, its result
// posted back. Each command that changed the view has an Undo; so has the model (undo, list_changes).
//
import { c3Tools } from './c3tools.js';
import { t, plural, language } from './i18n.js';
import { closeX } from './ui.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function assistInit({ connect, compile, run } = {}) {
  let info = { available: false };
  try {
    const r = await fetch('/api/assist');
    if (r.ok) info = await r.json();
  } catch { /* no backend route: the popup */ }

  if (info.available && connect) panelInit(info, connect, compile, run);
  else popupInit(info);
}



// -----------------------------------------------------------------------------
//
// The popup - AI Assist is not available in this c³: why
//
function popupInit(info) {
  const btn = $('ai-btn');
  const pop = $('ai-pop');
  $('ai-why').textContent = info.reason ? t('Here: {reason}.', { reason: info.reason }) : t('This c³ has no AI Assist backend.');

  const close = (refocus) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus({ preventScroll: true });
  };
  const open = () => {
    pop.hidden = false;
    //
    // Under the button, kept inside the window - the header wraps on a narrow one
    //
    const b = btn.getBoundingClientRect();
    const h = btn.closest('header').getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.right = 'auto';
    pop.style.top = (b.bottom - h.top + 6) + 'px';
    pop.style.left = Math.max(16, Math.min(b.right - w, window.innerWidth - w - 16)) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    $('ai-close').focus({ preventScroll: true });
  };

  btn.onclick = () => (pop.hidden ? open() : close(true));
  $('ai-close').onclick = () => close(true);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close(false);
  });
}



// -----------------------------------------------------------------------------
//
// The answer's text, as elements - never as HTML: paragraphs, lists, tables, code blocks, **bold**, `code`; an
// entity id (in backquotes or not) is a button that shows the entity in Explore
//
const URN = /urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[^\s`*()\[\]<>"',;]+[^\s`*()\[\]<>"',;.:]/g;

function inline(parent, text, onEntity) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = el('strong');
      inline(b, part.slice(2, -2), onEntity);
      parent.append(b);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = part.slice(1, -1);
      if (/^urn:\S+$/.test(code)) parent.append(entityButton(code, onEntity));
      else parent.append(el('code', null, code));
    } else {
      let at = 0;
      for (const m of part.matchAll(URN)) {
        if (m.index > at) parent.append(part.slice(at, m.index));
        parent.append(entityButton(m[0], onEntity));
        at = m.index + m[0].length;
      }
      if (at < part.length) parent.append(part.slice(at));
    }
  }
}

function entityButton(id, onEntity) {
  const b = el('button', 'eref', id);
  b.type = 'button';
  b.title = t('Show {id} in Explore', { id });
  b.onclick = () => onEntity(id);
  return b;
}

function render(box, text, onEntity) {
  box.textContent = '';
  const lines = text.split('\n');
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const p = el('p');
    para.forEach((l, i) => { if (i > 0) p.append(el('br')); inline(p, l, onEntity); });
    box.append(p);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      flushPara(); list = null;
      const code = [];
      for (i++; (i < lines.length) && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      box.append(el('pre', null, code.join('\n')));
      continue;
    }

    //
    // A table: a row of cells, a row of dashes, more rows
    //
    if (/^\s*\|.*\|\s*$/.test(line) && (i + 1 < lines.length) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara(); list = null;
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const table = el('table');
      const head = el('tr');
      for (const c of cells(line)) { const th = el('th'); inline(th, c, onEntity); head.append(th); }
      table.append(head);
      for (i += 2; (i < lines.length) && /^\s*\|/.test(lines[i]); i++) {
        const tr = el('tr');
        for (const c of cells(lines[i])) { const td = el('td'); inline(td, c, onEntity); tr.append(td); }
        table.append(tr);
      }
      i--;
      const wrap = el('div', 'aip-table');
      wrap.append(table);
      box.append(wrap);
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || number) {
      flushPara();
      const tag = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) { list = el(tag.toLowerCase()); box.append(list); }
      const li = el('li');
      inline(li, (bullet || number)[1], onEntity);
      list.append(li);
      continue;
    }
    list = null;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const p = el('p');
      const s = el('strong');
      inline(s, heading[1], onEntity);
      p.append(s);
      box.append(p);
      continue;
    }

    if (line.trim() === '') flushPara();
    else para.push(line);
  }
  flushPara();
}



// -----------------------------------------------------------------------------
//
// The server-sent events of a POST's response
//
//
// workspacesIn - the WireCloud workspaces a wirecloud tool's answer names ({id, owner, name} anywhere in it) into
// 'map' as id -> "owner/name"; 'made' is told of one create_workspace or clone_workspace made (an answer that is one)
//
function workspacesIn(text, map, made) {
  let v;
  try { v = JSON.parse(text); } catch { return; }
  const walk = (o, top) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, false)); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.id === 'string' && typeof o.owner === 'string' && typeof o.name === 'string') {
      map.set(o.id, encodeURIComponent(o.owner) + '/' + encodeURIComponent(o.name));
      if (top) made(o.id);
    }
    Object.values(o).forEach((x) => walk(x, false));
  };
  walk(v, true);
}

async function* events(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      let parsed = null;
      try { parsed = JSON.parse(data.join('\n')); } catch { /* not JSON: skipped */ }
      if (parsed) yield { event, data: parsed };
    }
  }
}



// -----------------------------------------------------------------------------
//
// The panel
//
function panelInit(info, connect, compile, run) {
  const btn = $('ai-btn');
  const panel = $('ai-panel');
  const log = $('ai-log');
  const q = $('ai-q');
  const send = $('ai-send');
  const stop = $('ai-stop');

  btn.title = t('AI Assist - ask about the broker');
  btn.setAttribute('aria-haspopup', 'false');

  //
  // Who is asking, on which model, and this month's spending - the service's word on the token
  //
  const money = (v) => '$' + Number(v || 0).toFixed(2);
  const local = info.engine === 'local';         // Claude Code on the user's own login: a plan, not a bill
  const usageText = (u) => {
    if (!u) return '';
    if (u.window) {
      const at = u.resetsAt ? new Date(u.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const win = u.window.replace('_', '-');
      const used = Math.round(u.utilization * 100);
      return at ? t('Your plan, {window} window: {used} % used (resets {at})', { window: win, used, at }) : t('Your plan, {window} window: {used} % used', { window: win, used });
    }
    return u.limitUsd != null ? t('This month: {spent} of {limit}', { spent: money(u.spentUsd), limit: money(u.limitUsd) }) : t('This month: {spent}', { spent: money(u.spentUsd) });
  };
  const showMe = (me) => {
    if (local) {
      $('ai-prov').textContent = `${info.provider} · ${info.model}`;
      $('ai-prov').title = t('Instructions: {instructions}', { instructions: info.instructions });
      return;
    }
    $('ai-prov').textContent = me ? `${info.provider} · ${me.model}` : info.provider;
    $('ai-prov').title = me ? t('{provider} at {service}, for {name}', { provider: info.provider, service: info.service, name: me.name }) : info.service;
    $('ai-usage').textContent = usageText(me);
  };
  showMe(info.me);

  //
  // The token: asked for when there is none (or the service does not know it); the Token button shows the form
  //
  const tokForm = $('ai-token');
  const tokMsg = (text, err) => { $('ai-tok-msg').textContent = text || ''; $('ai-tok-msg').classList.toggle('err', !!err); };
  const showToken = (show, text, err) => {
    tokForm.hidden = !show;
    $('ai-tok-forget').hidden = !info.tokenSet;
    tokMsg(text, err);
    if (show) $('ai-tok').focus({ preventScroll: true });
  };
  tokForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('ai-tok').value.trim();
    if (!token) return;
    tokMsg(t('Checking it with the service…'));
    $('ai-tok-use').disabled = true;
    try {
      const r = await fetch('/api/assist/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, remember: $('ai-tok-rem').checked }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { tokMsg(j.detail || 'HTTP ' + r.status, true); return; }
      $('ai-tok').value = '';
      info.tokenSet = true;
      info.me = j;
      showMe(j);
      showToken(false);
      q.focus({ preventScroll: true });
    } catch (err) {
      tokMsg(t('No answer from c³: {error}', { error: err.message }), true);
    } finally {
      $('ai-tok-use').disabled = false;
    }
  });
  $('ai-tok-forget').onclick = async () => {
    try { await fetch('/api/assist/token', { method: 'DELETE' }); } catch { /* shown as forgotten anyway */ }
    info.tokenSet = false;
    info.me = null;
    showMe(null);
    showToken(true, t('Forgotten.'));
  };
  $('ai-tokbtn').onclick = () => showToken(tokForm.hidden);
  $('ai-tokbtn').hidden = local;                 // the local engine has no token: the user's own login
  const needToken = !local && (!info.tokenSet || info.serviceStatus === 401);
  if (needToken) showToken(true, info.tokenSet ? t('The service does not know the token kept here - give the current one.') : '', info.tokenSet);
  else if (info.tokenSet && info.serviceStatus !== 200) tokMsg('');

  let conv = null;                               // {session, broker, tenant}
  let busy = null;                               // the AbortController of the question being answered

  //
  // confirm - a command with effects beyond the view asks here: its command shown, Do it or No
  //
  const confirm = ({ title, lines }) => new Promise((done) => {
    const box = el('div', 'aip-confirm');
    box.append(el('div', 'ctitle', title));
    for (const l of lines || []) box.append(el('pre', null, l));
    const row = el('div', 'crow');
    const yes = el('button', 'btn primary small', t('Do it'));
    yes.type = 'button';
    const no = closeX(t('No - do not do it'), null, true);
    const end = (v) => { yes.disabled = true; no.remove(); box.classList.add(v ? 'yes' : 'no'); row.replaceWith(el('div', 'cdone', v ? t('Done as asked.') : t('Declined.'))); done(v); };
    yes.onclick = () => end(true);
    no.onclick = () => end(false);
    row.append(yes);
    box.prepend(no);
    box.append(row);
    log.append(box);
    scroll();
    yes.focus({ preventScroll: true });
  });

  //
  // report - a gap the assistant drafted (report_gap): shown, editable. With gh logged in on this machine (GET
  // /api/issues), "File on GitHub" files it as the user (POST /api/issues) - their press is the go-ahead - and
  // shows the link; "Open on GitHub" opens the new-issue page of the assistant's repository, filled in, for the
  // user to file there (the only button without gh, and the way out when filing fails)
  //
  const ISSUES = { assistant: 'https://github.com/SEAMWARE-cor/coraine-assistant/issues/new', c3: 'https://github.com/SEAMWARE/c3/issues/new' };
  const report = ({ repo, title, body, labels }) => new Promise((done) => {
    const where = repo === 'c3' ? 'c3' : 'assistant';
    const repoName = where === 'c3' ? 'c3' : 'coraine-assistant';
    const box = el('div', 'aip-confirm aip-report');
    box.append(el('div', 'ctitle', t('Report this to Seamware?')));
    const ti = el('input', 'rtitle');
    ti.value = title;
    ti.setAttribute('aria-label', t('Issue title'));
    const b = el('textarea', 'rbody');
    b.value = body;
    b.rows = 10;
    b.setAttribute('aria-label', t('Issue text'));
    const note = el('div', 'rnote', t('Edit it as you like - it goes to the {repo} repository on GitHub, where you file it with your own login. Nothing is sent from here.', { repo: repoName }));
    box.append(ti, b, note);
    const row = el('div', 'crow');
    const file = el('button', 'btn primary small', t('File on GitHub'));
    const open = el('button', 'btn small', t('Open on GitHub'));
    const no = closeX(t('Not now - nothing reported'), null, true);
    file.type = open.type = 'button';
    file.hidden = true;
    const end = (v, said) => { file.disabled = open.disabled = true; no.remove(); row.replaceWith(said); done(v); };
    fetch('/api/issues').then((r) => r.json()).then((j) => {
      if (!j || j.gh !== true || file.disabled) return;
      file.hidden = false;
      open.classList.remove('primary');
      note.textContent = t('Edit it as you like - File on GitHub files it in the {repo} repository with your GitHub login (gh on this machine); Open on GitHub lets you file it there yourself.', { repo: repoName });
      file.focus({ preventScroll: true });
    }).catch(() => { /* no gh: Open on GitHub */ });
    file.onclick = async () => {
      file.disabled = open.disabled = no.disabled = true;
      file.textContent = t('Filing…');
      let j = null, ok = false;
      try {
        const r = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: where, title: ti.value, body: b.value, labels }) });
        j = await r.json().catch(() => null);
        ok = r.ok && j && j.url;
      } catch { /* not reached */ }
      if (ok) {
        const said = el('div', 'cdone', t('Filed: '));
        const a = el('a', null, j.url.replace(/^https:\/\/github.com\//, ''));
        a.href = j.url;
        a.target = '_blank';
        a.rel = 'noopener';
        said.append(a);
        end({ filed: j.url }, said);
        return;
      }
      file.textContent = t('File on GitHub');
      file.disabled = open.disabled = no.disabled = false;
      note.textContent = t('Not filed: {why}. Open on GitHub to file it there.', { why: (j && (j.detail || j.title)) || t('c3 did not answer') });
      note.classList.add('err');
      open.classList.add('primary');
    };
    open.onclick = () => {
      let text = b.value;
      const url = (x) => `${ISSUES[where]}?title=${encodeURIComponent(ti.value)}&labels=${encodeURIComponent(labels.join(','))}&body=${encodeURIComponent(x)}`;
      while (url(text).length > 7500 && text.length > 200) text = text.slice(0, Math.floor(text.length * 0.9));
      window.open(url(text === b.value ? text : text + '\n\n… (cut - the rest did not fit in a link)'), '_blank', 'noopener');
      end('opened', el('div', 'cdone', t('Opened on GitHub - file it there.')));
    };
    no.onclick = () => end('dismissed', el('div', 'cdone', t('Not reported.')));
    row.append(file, open);
    box.prepend(no);
    box.append(row);
    log.append(box);
    scroll();
    ti.focus({ preventScroll: true });
  });

  //
  // Explore moved by a command (connect_explore): the conversation goes with it - the user asked for it
  //
  const onExploreMoved = () => {
    if (conv) { conv.broker = connect.broker; conv.tenant = connect.tenant || ''; }
    ctxShown = null;
    showCtx();
  };

  //
  // progress - a long command says what it is doing, on its own line in the log (the latest text replaces the one before)
  //
  let running = null;                            // the line of the c3 command being carried out
  const progress = (text) => {
    if (!running) return;
    let p = running.querySelector('.cmdprog');
    if (!p) { p = el('div', 'cmdprog'); running.append(p); }
    p.textContent = text;
    scroll();
  };

  const tools = c3Tools(connect, { compile, run, confirm, onExploreMoved, report, progress, version: info.version || '', engine: `${info.provider} · ${info.model || ''}` });
  const changeLines = new Map();                 // a change's n -> its line in the log
  tools.onUndone((ns) => {
    for (const n of ns) {
      const line = changeLines.get(n);
      if (!line) continue;
      line.classList.add('undone');
      const b = line.querySelector('.undo');
      if (b) { b.disabled = true; b.textContent = t('undone'); }
      changeLines.delete(n);
    }
  });

  //
  // A c3 command: carried out, its line in the log (with Undo when it changed the view), the result posted
  //
  const runCommand = async (data) => {
    const line = el('div', 'aip-cmd');
    const head = el('div', 'cmdhead');
    head.append(el('span', 'cmdmark', '⚙'), el('span', 'tname', data.name));
    line.append(head);
    if (data.args && Object.keys(data.args).length && data.name !== 'report_gap') line.append(el('div', 'cargs', JSON.stringify(data.args)));   // a report shows its draft itself
    log.append(line);
    scroll();

    running = line;
    const r = await tools.run(data.name, data.args);
    running = null;
    const prog = line.querySelector('.cmdprog');
    if (prog) prog.remove();
    if (!r.ok || r.n) line.append(el('div', r.ok ? 'cmdres' : 'cmdres err', r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text));
    else line.classList.add('quiet');            // a look (get_view, list_changes): its result is the model's
    if (r.n) {
      const u = el('button', 'btn small undo', '↶ ' + t('Undo'));
      u.type = 'button';
      u.title = t('Put the view back as it was before this - and before every later change');
      u.onclick = () => tools.undoTo(r.n);
      head.append(u);
      changeLines.set(r.n, line);
    }
    scroll();

    try {
      await fetch('/api/assist/ui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call: data.call, ok: r.ok, text: r.text }) });
    } catch { /* the model is told the page did not answer */ }
  };

  const onEntity = (id) => {
    if (location.hash !== '#connect') location.hash = '#connect';
    connect.follow(id);
  };

  const scroll = () => { log.scrollTop = log.scrollHeight; };

  const where = () => ({ broker: connect.broker, tenant: connect.tenant || '' });

  let ctxShown = null;
  const showCtx = () => {
    const ctx = $('ai-ctx');
    const w = where();
    const key = [w.broker, w.tenant, conv && conv.broker, conv && conv.tenant].join('\n');
    if (key === ctxShown) return;
    ctxShown = key;
    ctx.textContent = '';
    if (!w.broker) {
      ctx.append(el('span', 'warn', t('Connect to a broker in Explore - the assistant reads that one.')));
      return;
    }
    ctx.append(w.broker + ' · ' + (w.tenant ? t('tenant {tenant}', { tenant: w.tenant }) : t('the default tenant')));
    if (conv && (conv.broker !== w.broker || conv.tenant !== w.tenant)) ctx.append(el('div', 'warn', t('Explore is on another broker or tenant now - the next question starts a new conversation.')));
  };

  const empty = () => {
    log.textContent = '';
    log.append(el('div', 'aip-empty', t('Ask in your own words - which entities, how many, what changed, what is related to what - or tell it what to show: "paint the Stores green", "only the vehicles, on the map", "highlight the ones above 90". It reads the broker and cannot change anything in it; what it does to the view has an Undo, and "undo that" works too. Click an entity id in an answer to see it in Explore.')));
    log.append(el('div', 'aip-empty', t("While c³'s Dashboard runs, it builds dashboards there too: \"a dashboard of the rooms' temperatures - a table, a chart and a map\". It does not delete any.")));
  };

  const newConversation = (note) => {
    if (busy) return;
    conv = null;
    empty();
    if (note) log.append(el('div', 'aip-note', note));
    showCtx();
  };

  //
  // Docked under the header, whose height depends on the window's width
  //
  const place = () => {
    const h = document.querySelector('header.top').getBoundingClientRect();
    panel.style.setProperty('--aip-top', Math.max(0, h.bottom) + 'px');
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    $('app').classList.toggle('ai-docked', open);
    btn.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('c3.assist.open', open ? '1' : '0'); } catch { /* not kept */ }
    if (open) { place(); showCtx(); q.focus({ preventScroll: true }); }
    window.dispatchEvent(new Event('resize'));   // the graph and the map measure themselves again
  };

  btn.onclick = () => setOpen(panel.hidden);
  $('ai-pclose').onclick = () => { setOpen(false); btn.focus({ preventScroll: true }); };
  $('ai-new').onclick = () => newConversation();
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
  window.addEventListener('hashchange', () => { if (!panel.hidden) showCtx(); });
  panel.addEventListener('focusin', showCtx);
  setInterval(() => { if (!panel.hidden) showCtx(); }, 1000);    // Explore connects and changes tenant on its own

  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ai-form').requestSubmit(); }
  });

  stop.onclick = async () => {
    if (!busy || !conv) return;
    try {
      await fetch('/api/assist/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: conv.session }) });
    } catch { busy.abort(); }
  };

  $('ai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = q.value.trim();
    if (!question || busy) return;

    const w = where();
    if (!w.broker) { showCtx(); return; }
    if (conv && (conv.broker !== w.broker || conv.tenant !== w.tenant)) newConversation(w.tenant ? t('A new conversation - Explore is on {broker}, tenant {tenant} now.', { broker: w.broker, tenant: w.tenant }) : t('A new conversation - Explore is on {broker}, the default tenant now.', { broker: w.broker }));
    log.querySelector('.aip-empty')?.remove();

    q.value = '';
    log.append(el('div', 'aip-q', question));

    let answer = null;                           // the text box being written
    let text = '';
    let frame = 0;
    const toolLines = new Map();               // a broker tool call's id -> its line
    let calls = 0;
    let dashboardChanged = false;                // a wirecloud tool that changes something ran
    let dashboardWs = null;
    const toolKinds = new Map();                 // tool call id -> 'dashboard'                      // the workspace id it changed last
    const workspaces = new Map();                // workspace id -> "owner/name", from the wirecloud tools' answers

    const textBox = () => {
      if (!answer) {
        answer = el('div', 'aip-a streaming');
        text = '';
        log.append(answer);
      }
      return answer;
    };
    const textDone = () => {
      if (!answer) return;
      cancelAnimationFrame(frame);
      render(answer, text, onEntity);
      answer.classList.remove('streaming');
      answer = null;
    };

    busy = new AbortController();
    send.disabled = true;
    stop.hidden = false;

    const body = { broker: w.broker, question, uiTools: tools.definitions, lang: language() };
    if (w.tenant) body.tenant = w.tenant;
    if (conv) body.session = conv.session;

    try {
      const r = await fetch('/api/assist/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: busy.signal });
      if (!r.ok) {
        let d = 'HTTP ' + r.status;
        try { const j = await r.json(); d = j.detail || j.title || d; } catch { /* the status */ }
        if (r.status === 401) showToken(true, d, true);
        throw new Error(d);
      }

      for await (const { event, data } of events(r)) {
        if (event === 'start') {
          conv = { session: data.session, broker: w.broker, tenant: w.tenant };
        } else if (event === 'text') {
          textBox();
          text += data.text;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => { if (answer) { render(answer, text, onEntity); scroll(); } });
        } else if (event === 'serverDown') {
          log.append(el('div', 'aip-err', data.server === 'c3' ? t('The c³ commands are missing from this answer - the tool server "{server}" did not connect ({status}).', { server: data.server, status: data.status })
            : data.server === 'wirecloud' ? t('The Dashboard\'s tools are missing from this answer - WireCloud\'s MCP server did not connect ({status}).', { status: data.status })
            : t('The broker tools are missing from this answer - the tool server "{server}" did not connect ({status}).', { server: data.server, status: data.status })));
        } else if (event === 'ui') {
          textDone();
          runCommand(data);
        } else if (event === 'tool' && data.kind === 'c3') {
          textDone();                            // shown by its ui event
        } else if (event === 'tool') {
          textDone();
          calls++;
          const d = el('details', 'aip-tool');
          const s = el('summary');
          if (data.kind === 'dashboard') {
            s.append(el('span', 'tkind', t('Dashboard')), ' ');
            if (!/^(get_|list_|export_|validate_)/.test(data.name)) {
              dashboardChanged = true;           // the frame shows it after the answer
              if (data.input && data.input.workspace_id) dashboardWs = data.input.workspace_id;
            }
            toolKinds.set(data.id, 'dashboard');
          }
          s.append(el('span', 'tname', data.name), ' ' + JSON.stringify(data.input));
          s.title = data.name + ' ' + JSON.stringify(data.input);
          const pre = el('pre', null, '…');
          d.append(s, pre);
          log.append(d);
          toolLines.set(data.id, { d, pre });
          scroll();
        } else if (event === 'toolResult') {
          if (toolKinds.get(data.id) === 'dashboard') workspacesIn(data.text, workspaces, (id) => { if (!dashboardWs) dashboardWs = id; });
          const tl = toolLines.get(data.id);
          if (tl) {
            let shown = data.text;
            try { shown = JSON.stringify(JSON.parse(data.text), null, 2); } catch { /* as it came */ }
            tl.pre.textContent = shown;
            if (data.isError) tl.d.classList.add('err');
          }
        } else if (event === 'usage') {
          $('ai-usage').textContent = usageText(data);
        } else if (event === 'end') {
          if (dashboardChanged) window.dispatchEvent(new CustomEvent('c3-dashboard-changed', { detail: { path: workspaces.get(dashboardWs) || null } }));
          if (!text && data.answer) { textBox(); text = data.answer; }
          textDone();
          const meta = [plural(calls, '{n} tool call', '{n} tool calls'), data.seconds + ' s', t('{n} tokens', { n: data.input + data.output + data.cacheRead })];
          if (data.costUsd) meta.push(local ? t('≈ {cost} at API prices - not billed, your plan', { cost: '$' + data.costUsd.toFixed(3) }) : '$' + data.costUsd.toFixed(3));
          log.append(el('div', 'aip-meta', meta.join(' · ')));
          if (data.isError) log.append(el('div', 'aip-err', t('The model ended with an error.')));
        } else if (event === 'error') {
          textDone();
          if (/no such conversation/.test(data.detail || '')) conv = null;          // forgotten by the service: the next question starts anew
          if (/token is needed|does not know this token/.test(data.detail || '')) showToken(true, data.detail, true);
          log.append(el('div', data.detail === 'stopped' ? 'aip-note' : 'aip-err', data.detail === 'stopped' ? t('Stopped.') : data.detail));
        }
      }
    } catch (err) {
      textDone();
      if (err.name !== 'AbortError') log.append(el('div', 'aip-err', t('No answer: {error}', { error: err.message })));
    } finally {
      textDone();
      busy = null;
      send.disabled = false;
      stop.hidden = true;
      showCtx();
      scroll();
      q.focus({ preventScroll: true });
    }
  });

  empty();
  let wasOpen = false;
  try { wasOpen = localStorage.getItem('c3.assist.open') === '1'; } catch { /* closed */ }
  if (wasOpen) setOpen(true);
}
