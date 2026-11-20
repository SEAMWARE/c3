//
// dashboard.js - the Dashboard page: WireCloud (Ficodes), started by c3 in containers of its own and shown here
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The backend does the work (GET /api/run/dashboard, POST .../start, .../stop, .../login - src/run.c, "The
// Dashboard"): the page shows its state, asked again every 2 s while the page is shown. Once WireCloud runs,
// c3 logs in to it (POST .../login: WireCloud's session cookies on c3's answer - the password stays in c3) and
// the page shows WireCloud in a frame, on the host the page itself was loaded from: a browser keeps a cookie
// per host, not per port, so the cookies reach WireCloud on its own port.
//
// WireCloud is AGPL-3.0, Ficodes' - a program of its own in a container; nothing of it is part of c3.
//
import * as api from './api.js';
import { t, tk } from './i18n.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// The Dashboard's states (src/run.c dashboardState) and its services' (Docker's words), shown translated
//
const STATE_NAMES = {
  running: tk('running'), stopped: tk('stopped'), failed: tk('failed'), partly: tk('partly running'), busy: tk('busy'),
  starting: tk('starting'), stopping: tk('stopping'), absent: tk('absent'), exited: tk('exited'), created: tk('created'),
};
const stateName = (v) => (STATE_NAMES[v] ? t(STATE_NAMES[v]) : v);

//
// What a start or a stop does now - the backend's words, translated where known (a container's label in them)
//
const DOING = [
  [/^starting (.+)$/, (m) => t('starting {what}', { what: m[1] })],
  [/^stopping (.+)$/, (m) => t('stopping {what}', { what: m[1] })],
  [/^first start: installing/, () => t('first start: installing WireCloud\'s widgets and operators')],
  [/^first start: making/, () => t('first start: making WireCloud\'s user admin - its password made by c³, kept in secrets.json')],
  [/^making WireCloud's search indexes/, () => t('making WireCloud\'s search indexes')],
  [/^installing the widget (\S+) (\S+) in WireCloud$/, (m) => t('installing the widget {widget} {version} in WireCloud', { widget: m[1], version: m[2] })],
  [/^checking WireCloud's image$/, () => t('checking WireCloud\'s image')],
  [/^logging in to WireCloud$/, () => t('logging in to WireCloud')],
  [/^checking c3's widgets in WireCloud$/, () => t('checking c³\'s widgets in WireCloud')],
  [/^starting$/, () => t('starting')],
  [/^stopping$/, () => t('stopping')],
];
const doingText = (d) => {
  for (const [re, f] of DOING) {
    const m = re.exec(d);
    if (m) return f(m);
  }
  return d;
};

export class Dashboard {
  constructor() {
    this.shown = false;
    this.timer = null;
    this.state = null;
    this.frameFor = null;          // the port the frame was logged in for and shows; null: none
    this.loggingIn = false;
    this.loginWhy = null;
    $('db-start').addEventListener('click', () => this.act('start'));
    $('db-stop').addEventListener('click', () => this.act('stop'));
    $('db-stop-bar').addEventListener('click', () => this.act('stop'));
    $('db-reload').addEventListener('click', () => { this.frameFor = null; this.render(); });
    this.progress = null;          // the dialog's: {what: 'start' | 'stop', error} while it is open
    $('db-pclose').addEventListener('click', () => this.progressClose());
    $('db-progress').addEventListener('cancel', () => { this.progress = null; });
    $('db-write').addEventListener('change', async (ev) => {
      try {
        await api.dashboardSettings({ widgetsWrite: ev.target.checked });
        this.writeWhy = null;
      } catch (e) {
        this.writeWhy = t('c³ did not keep "Widgets may write": {error}', { error: e.message });   // shown in the bar; the switch as c³ has it
      }
      this.poll();
    });
  }

  refresh() {
    this.shown = true;
    this.poll();
  }

  hide() {
    this.shown = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async poll() {
    clearTimeout(this.timer);
    try {
      this.state = await api.dashboard();
      this.error = null;
      this.errorStatus = null;
    } catch (e) {
      this.error = e.message;
      this.errorStatus = e.status || null;
    }
    this.render();
    this.progressRender();
    if (this.state && (this.state.busy || this.state.state === 'failed' || this.state.state === 'partly')) this.logShow();
    if (this.shown) this.timer = setTimeout(() => this.poll(), this.progress ? 1000 : 2000);
  }

  async act(what) {
    $('db-start').disabled = $('db-stop').disabled = $('db-stop-bar').disabled = true;
    this.progressOpen(what);
    try {
      await (what === 'start' ? api.dashboardStart() : api.dashboardStop());
      if (this.progress) this.progress.accepted = true;     // the backend's steps are this one's from now on
      if (what === 'stop') this.frameFor = null;
      this.loginWhy = null;
    } catch (e) {
      //
      // c³ did not take it: the dialog says why. A 404: the c³ running is older than this page (c³ serves the
      // page from its directory - a newer page, an older binary)
      //
      if (this.progress) this.progress.error = e.status === 404
        ? t('This c³ does not know the Dashboard\'s API ({error}) - it is older than its page: restart c³ from the current build', { error: e.message })
        : t('c³ did not take it: {error}', { error: e.message });
    }
    this.poll();
  }

  //
  // The progress dialog: open from Start or Stop until it is closed - by hand, or by itself a moment after a
  // start or a stop went through
  //
  progressOpen(what) {
    this.progress = { what, error: null, accepted: false, since: Date.now() };
    $('db-ptitle').textContent = what === 'start' ? t('Starting the Dashboard') : t('Stopping the Dashboard');
    $('db-steps').replaceChildren();
    $('db-pwhy').hidden = true;
    $('db-plog').open = false;
    $('db-plogtext').textContent = '';
    $('db-pfill').style.width = '0';
    $('db-pbar').classList.remove('failed');
    $('db-pcount').textContent = t('asking c³…');
    const d = $('db-progress');
    if (!d.open) d.showModal();
  }

  progressClose() {
    this.progress = null;
    clearTimeout(this.progressTimer);
    const d = $('db-progress');
    if (d.open) d.close();
  }

  progressRender() {
    const p = this.progress;
    if (!p) return;
    const s = this.state;
    const steps = s && s.steps && s.steps.of === p.what ? s.steps : null;
    //
    // Until the backend took it (its answer: the steps reset then), the steps it has are the last start's
    //
    const fresh = steps && p.accepted ? steps : null;
    const list = fresh ? fresh.list : [];
    const failed = !!p.error || (fresh && list.some((x) => x.failed)) || (!s?.busy && !!s?.why && p.what === 'start' && fresh);
    const over = !!p.error || (fresh && !s.busy);

    $('db-steps').replaceChildren(...list.map((x) => {
      const li = document.createElement('li');
      li.className = x.failed ? 'failed' : x.done ? 'done' : 'run';
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = x.failed ? '✗' : x.done ? '✓' : '';
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = doingText(x.text);
      const sec = document.createElement('span');
      sec.className = 'sec';
      sec.textContent = x.seconds + ' s';
      li.append(ic, tx, sec);
      return li;
    }));
    const box = $('db-steps');
    box.scrollTop = box.scrollHeight;

    const total = fresh ? Math.max(fresh.total, list.length) : 0;
    const done = list.filter((x) => x.done).length;
    $('db-pfill').style.width = (over && !failed ? 100 : total ? Math.round(100 * done / total) : 0) + '%';
    $('db-pbar').classList.toggle('failed', failed);
    $('db-pbar').setAttribute('aria-valuenow', String(total ? Math.round(100 * done / total) : 0));
    const secs = Math.round((Date.now() - p.since) / 1000);
    $('db-pcount').textContent = p.error ? '' : !fresh ? t('asking c³…')
      : over ? (failed ? t('stopped at step {n} of {total}', { n: list.length, total }) : (p.what === 'start' ? t('done - WireCloud runs ({s} s)', { s: secs }) : t('done - stopped, its data kept ({s} s)', { s: secs })))
      : t('step {n} of about {total} - {s} s so far', { n: list.length, total, s: secs });

    const why = p.error || (failed && s?.why ? t('The last start failed: {why}', { why: s.why }) : '');
    $('db-pwhy').hidden = !why;
    $('db-pwhy').textContent = why;
    if (failed && !p.error) $('db-plog').open = true;           // a start that failed: the log says why
    if ($('db-plog').open) this.progressLog();

    $('db-plog').hidden = !!p.error;                              // c³ never took it: no log of it
    $('db-pclose').textContent = over ? t('Close') : t('Hide');
    if (over && !failed && !this.progressTimer) {
      this.progressTimer = setTimeout(() => { this.progressTimer = null; this.progressClose(); }, 2500);
    }
  }

  async progressLog() {
    try {
      const text = await api.dashboardLog();
      const pre = $('db-plogtext');
      pre.textContent = text.split('\n').slice(-80).join('\n');
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { /* the log as it was */ }
  }

  //
  // login - c3 logs in to WireCloud; the frame then loads it, already logged in
  //
  async login(port) {
    if (this.loggingIn) return;
    this.loggingIn = true;
    try {
      const r = await api.dashboardLogin();
      this.loginWhy = null;
      this.frameFor = r.port || port;
      $('db-frame').src = this.wirecloudUrl(this.frameFor);
    } catch (e) {
      this.loginWhy = e.message;
    }
    this.loggingIn = false;
    this.render();
  }

  //
  // wirecloudUrl - WireCloud on the page's own host: the cookies c3's login set are this host's. WireCloud
  // listens on 127.0.0.1 only: a page loaded from [::1] shows it from 127.0.0.1 - and logs in there itself.
  //
  wirecloudUrl(port) {
    const host = (location.hostname === '[::1]' || location.hostname === '::1') ? '127.0.0.1' : location.hostname;
    return `${location.protocol}//${host}:${port}/`;
  }

  async logShow() {
    try {
      const text = await api.dashboardLog();
      const pre = $('db-log');
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      pre.textContent = text.split('\n').slice(-200).join('\n');
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    } catch (e) { /* the log as it was */ }
  }

  render() {
    const s = this.state;
    const runs = s && s.state === 'running' && s.port;

    $('db-panel').hidden = !!runs;
    $('db-bar').hidden = !runs;
    $('db-framewrap').hidden = !runs || this.frameFor !== s.port;

    if (!s) {
      $('db-doing').textContent = !this.error ? ''
        : this.errorStatus === 404 ? t('This c³ does not know the Dashboard\'s API ({error}) - it is older than its page: restart c³ from the current build', { error: this.error })
        : t('The backend does not answer: {error}', { error: this.error });
      return;
    }

    //
    // No container engine: what it would need
    //
    $('db-noengine').hidden = !!s.engine;
    if (!s.engine) $('db-noengine-why').textContent = s.engineWhy || '';

    const chip = $('db-state');
    chip.textContent = stateName(s.state);
    chip.className = 'chip host db-' + s.state;

    if (runs) {
      $('db-url').textContent = '127.0.0.1:' + s.port;
      $('db-write').checked = s.widgetsWrite !== false;
      $('db-open').href = this.wirecloudUrl(s.port);
      const barWhy = this.loginWhy ? t('c³ could not log in to WireCloud: {why}', { why: this.loginWhy }) : (this.writeWhy || '');
      $('db-loginwhy').hidden = !barWhy;
      $('db-loginwhy').textContent = barWhy;
      if (this.frameFor !== s.port && !this.loginWhy) this.login(s.port);
      return;
    }

    if (this.frameFor !== null) {               // it stopped: the frame goes too
      this.frameFor = null;
      $('db-frame').src = 'about:blank';
    }

    //
    // The services, what runs now, why the last start failed
    //
    $('db-services').replaceChildren(...s.services.map((x) => this.serviceItem(x)));
    $('db-doing').textContent = s.busy && s.doing ? doingText(s.doing) : '';
    $('db-why').hidden = !s.why;
    $('db-why').textContent = s.why ? t('The last start failed: {why}', { why: s.why }) : '';

    const anyRuns = s.services.some((x) => x.state === 'running');
    $('db-start').hidden = s.busy;
    $('db-start').disabled = !s.engine;
    $('db-start').textContent = anyRuns || s.state === 'failed' ? t('Start again') : t('Start');
    $('db-stop').hidden = s.busy || !anyRuns;
    $('db-stop').disabled = false;
    $('db-stop-bar').disabled = false;
    $('db-logwrap').hidden = !(s.busy || s.why || s.state === 'partly');
    $('db-image').textContent = s.image;
  }

  serviceItem(x) {
    const item = el('div', 'rn-item');
    const runs = x.state === 'running';
    item.append(el('span', 'rdot ' + (runs ? 'ok' : (x.state === 'starting' || x.state === 'stopping') ? 'busy' : x.state === 'exited' ? 'bad' : '')));
    const main = el('div', 'rmain');
    const title = el('div', 'rtitle');
    title.append(el('span', 'rname', x.container), el('span', 'badge ' + x.state, stateName(x.state)));
    if (x.port && runs) title.append(el('span', 'rurl', '127.0.0.1:' + x.port));
    main.append(title);
    main.append(el('div', 'rmeta', [x.label, x.image, x.status || ''].filter(Boolean).join(' · ')));
    main.append(el('div', 'rmeta mono', x.volumeExists ? t('data in the volume {volume}', { volume: x.volume }) : t('no data yet (the volume {volume} is made at its first start)', { volume: x.volume })));
    item.append(main);
    return item;
  }
}
