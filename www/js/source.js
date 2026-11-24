//
// source.js - Compile's Source card: what coraine-build builds from
//
// Two kinds: the coraine-dev package (a release's source, installed with apt) or a directory of git clones
// (~/git). For the clones the card lists the repositories the build needs - coraine, c3, the libraries and
// the repositories of the bridges ticked, nothing else - each with the branch that goes in: main (origin/main,
// as last fetched) unless another is chosen in its pull-down. Refresh fetches every clone and lists the
// branches again. A missing one is cloned from here (into the directory of clones), or its path given when it
// is a clone somewhere else.
//
// The card is outside Compile's gate: when the source is not usable the rest of the page is greyed, and this
// card is where it is fixed.
//
import * as api from './api.js';
import { t, tk, plural } from './i18n.js';
import { helpShow } from './compile.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const ROLE = { broker: tk('the broker'), c3: 'c³', library: tk('library'), bridge: tk('bridge') };

//
// BRANCH_HELP - the Branch column's '?': what of each clone goes into a build
//
const BRANCH_HELP = () => [
  t('Each repository goes into the build at the branch chosen here - its last commit, as this clone has it. The build takes committed work only: uncommitted changes in a clone are not in it.'),
  '',
  t('- **main (origin/main)**, the default: main as last fetched from GitHub - not the clone\'s own main branch, and not what is checked out.'),
  t('- **Branches of this clone**: a local branch - commits not pushed yet are in.'),
  t('- **Branches at origin**: a branch as last fetched (origin/feat/x) - what is on GitHub, whatever the clone has checked out.'),
  t('- **HEAD**: whatever the clone has checked out right now.'),
  '',
  t('**Refresh** fetches every clone from origin: branches made since c³ started appear, and origin/main is GitHub\'s again. A build\'s MANIFEST.txt (in its directory) names the branch and commit of each repository that went in.'),
].join('\n');

export class Source {
  //
  // compile: the Compile page - its capabilities (caps.compile), its bridges, refresh() after a change
  //
  constructor(compile) {
    this.compile = compile;
    this.repos = null;                    // the last /api/compile/repos answer
    this.reposError = '';
    this.bridgeKey = null;                // the bridge repositories the list was read for
    this.clones = new Map();              // repo -> {state, message}
    this.elsewhereOpen = new Set();       // repos whose "It is elsewhere" input is shown
    this.pollTimer = null;
    this.busy = '';                       // what the card is doing - shown, the controls wait
    this.showAll = false;                 // every repository listed, not only the ones that need a look
  }

  cc() { return (this.compile.caps && this.compile.caps.compile) || {}; }

  isClones() { return this.cc().sourceKind === 'clones'; }

  //
  // bridgeRepos - the repositories of the bridges ticked (a bridge not in this source can be ticked when the
  // source is clones: its repository is then listed as missing)
  //
  bridgeRepos() {
    return this.compile.bridges
      .filter((br) => br.repository && this.compile.isBridgeOn(br))
      .map((br) => br.repository)
      .sort();
  }

  //
  // missing - the needed repositories that are not there; blocking() - why Build waits, or ''
  //
  missing() {
    if (!this.isClones() || !this.repos || !Array.isArray(this.repos.repos)) return [];
    return this.repos.repos.filter((r) => !r.present);
  }

  blocking() {
    const m = this.missing();
    if (m.length) return plural(m.length, '{name} is not cloned - see Source', '{n} repositories are not cloned - see Source', { name: m[0].name, n: m.length });
    const gone = this.isClones() && this.repos && Array.isArray(this.repos.repos) ? this.repos.repos.filter((r) => r.present && r.refFound === false) : [];
    if (gone.length) return t('{repo} has no {ref} - choose another branch under Source', { repo: gone[0].name, ref: gone[0].ref });
    return '';
  }

  //
  // dirtyMatters - uncommitted changes in the clone that the build might have been meant to take: what goes in
  // is what is checked out (HEAD), or its branch - here or at origin
  //
  dirtyMatters(r) {
    return !!r.dirty && !!r.branch && (r.ref === 'HEAD' || r.ref === r.branch || r.ref === 'origin/' + r.branch);
  }

  //
  // update - after Compile's refresh or a bridge switched: the repository list again when what it depends on
  // changed (or always, with force)
  //
  async update(force, fetch) {
    if (!this.isClones()) {
      this.repos = null;
      this.bridgeKey = null;
      this.render();
      return;
    }
    const bridges = this.bridgeRepos();
    const key = (this.cc().clonesDir || '') + '|' + bridges.join(',');
    if (!force && key === this.bridgeKey) { this.render(); return; }
    this.bridgeKey = key;
    try {
      this.repos = await api.compileRepos(bridges, fetch);
      this.reposError = '';
      if (fetch) this.message = this.repos.fetchErrors ? t('Some clones could not be fetched: {errors}', { errors: this.repos.fetchErrors }) : '';
    } catch (e) {
      this.repos = null;
      this.reposError = e.message;
    }
    this.render();
    this.compile.sourceChanged();
  }

  //
  // use - the source chosen: the package, or the clones in 'dir'
  //
  async use(body) {
    this.busy = body.kind === 'clones' ? t('Looking for the clones in {dir} ...', { dir: body.dir }) : t('Switching to the coraine-dev package ...');
    this.render();
    try {
      await api.compileSource(body);
      this.message = '';
    } catch (e) {
      this.message = e.message;
    }
    this.busy = '';
    this.bridgeKey = null;
    await this.compile.refresh(true);
  }

  async clone(repos) {
    for (const repo of repos) {
      this.clones.set(repo, { state: 'running', message: null });
      try {
        await api.cloneStart(repo);
      } catch (e) {
        this.clones.set(repo, { state: 'failed', message: e.message });
      }
    }
    this.render();
    this.poll();
  }

  //
  // poll - the clones' states every second while one runs; when the last ends, everything again (a clone of
  // coraine makes Compile available, a bridge's clone makes the bridge buildable)
  //
  poll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      let list = [];
      try { list = await api.clones(); } catch (e) { list = []; }
      let running = false;
      for (const c of list) {
        const mine = this.clones.get(c.repo);
        if (!mine) continue;
        this.clones.set(c.repo, { state: c.state, message: c.message });
        if (c.state === 'running') running = true;
      }
      if (running) {
        this.render();
        this.poll();
        return;
      }
      for (const [repo, c] of this.clones) if (c.state === 'done') this.clones.delete(repo);
      this.bridgeKey = null;
      await this.compile.refresh(true);
    }, 1000);
  }

  //
  // refresh - every clone fetched (git fetch --prune origin), the branches listed again: the ones made since
  // c3 started, origin/main as it is now
  //
  async refresh() {
    const n = this.repos && Array.isArray(this.repos.repos) ? this.repos.repos.filter((r) => r.present).length : 0;
    this.busy = t('Fetching the {n} clones from origin (git fetch) and listing their branches again ...', { n });
    this.render();
    this.bridgeKey = null;
    await this.update(true, true);
    this.busy = '';
    this.render();
    await this.compile.refresh(true);                    // origin/main moved: the feature list is the new one's
  }

  //
  // chooseRef - what of r goes into the build; '' the default, main (origin/main). The pull-down already shows it:
  // nothing of the card is drawn again (Refresh does that) - only a "not in this clone" warning of the row goes.
  // Kept (PUT), then the command shown again; the feature and bridge lists read coraine and the bridges'
  // repositories only - for those they are read again, the card left as it is
  //
  async chooseRef(r, ref, sel) {
    const was = { ref: r.ref, chosen: r.chosen, refFound: r.refFound };
    r.ref = ref || 'origin/main';
    r.chosen = !!ref;
    if (r.refFound === false) {
      r.refFound = true;                                  // the pull-down offers what the clone has
      const row = sel.closest('.cp-repo');
      for (const w of row.querySelectorAll('.cp-repo-warn.gone')) w.remove();
      for (const o of sel.querySelectorAll('option.gone')) o.remove();
    }
    try {
      await api.compileRepoRef(r.name, ref);
    } catch (e) {
      Object.assign(r, was);
      sel.value = r.chosen ? r.ref : '';
      $('cp-src-msg').textContent = r.name + ': ' + e.message;
      return;
    }
    this.compile.sourceChanged();                         // Build, the summary, the command
    if (r.role === 'broker' || r.role === 'bridge') this.compile.refresh(true, true);
  }

  async elsewhere(repo, path) {
    try {
      await api.compileRepoPath(repo, path);
      this.elsewhereOpen.delete(repo);
      this.message = '';
    } catch (e) {
      this.message = repo + ': ' + e.message;
    }
    this.bridgeKey = null;
    await this.compile.refresh(true);
  }

  //
  // render
  //
  render() {
    const cc = this.cc();
    const card = $('cp-source');
    if (!card) return;

    //
    // The kind: package or clones; c3 started with --source decides alone
    //
    const kind = $('cp-src-kind');
    const pkg = el('button', '', t('coraine-dev package'));
    const git = el('button', '', t('Git clones'));
    for (const [b, k] of [[pkg, 'package'], [git, 'clones']]) {
      b.type = 'button';
      b.setAttribute('aria-pressed', String(cc.sourceKind === k));
      b.disabled = !!cc.sourceFlag || !!this.busy;
    }
    //
    // What each kind is: a tooltip, not a line of the card
    //
    const clonesWhat = t('The directory holding coraine, c3 and the libraries as git clones, side by side - a missing one is cloned into it.');
    git.title = clonesWhat;
    pkg.title = !cc.packageInstalled ? t('not installed - sudo apt install coraine-dev')
      : (cc.version ? t('The source of the release coraine-dev installed - coraine {version}.', { version: cc.version }) : t('The source of the release coraine-dev installed.'));
    if (!cc.packageInstalled) pkg.disabled = true;
    pkg.addEventListener('click', () => { if (cc.sourceKind !== 'package') this.use({ kind: 'package' }); });
    git.addEventListener('click', () => { if (cc.sourceKind !== 'clones') this.use({ kind: 'clones', dir: $('cp-src-dir').value.trim() || '~/git' }); });
    kind.replaceChildren(pkg, git);

    //
    // The directory of clones
    //
    const dirRow = $('cp-src-dirrow');
    dirRow.hidden = cc.sourceKind !== 'clones';
    const dir = $('cp-src-dir');
    if (document.activeElement !== dir) dir.value = cc.clonesDir || '';
    dir.disabled = !!cc.sourceFlag || !!this.busy;
    $('cp-src-use').disabled = dir.disabled;
    dirRow.title = clonesWhat;

    //
    // The note under the kind: only what asks for something - what a source is, is its button's tooltip. What the
    // card does is said in the table's foot, or here only while there is no table (a kind switched)
    //
    const tableShown = cc.sourceKind === 'clones' && !!this.repos && !this.reposError;
    let note = '';
    if (this.busy && !tableShown) note = this.busy;
    else if (cc.sourceFlag) note = t('c³ was started with --source {source}: that decides, not this card.', { source: cc.source });
    else if (cc.sourceKind === 'package' && !cc.packageInstalled) note = t('coraine-dev is not installed: sudo apt install coraine-dev - or build from git clones.');
    $('cp-src-note').textContent = note;
    $('cp-src-note').hidden = !note;
    $('cp-src-msg').textContent = this.message || '';


    //
    // The repositories (clones only)
    //
    const list = $('cp-src-repos');
    const foot = $('cp-src-foot');
    if (cc.sourceKind !== 'clones') {
      list.replaceChildren();
      list.hidden = true;
      foot.replaceChildren();
      return;
    }
    list.hidden = false;
    if (this.reposError || !this.repos) {
      list.replaceChildren(el('div', 'cp-note', this.reposError ? t('The repositories could not be listed: {error}', { error: this.reposError }) : t('Listing the repositories ...')));
      foot.replaceChildren();
      return;
    }
    if (this.repos.why && !(this.repos.repos || []).length) {
      list.replaceChildren(this.repoRow({ name: 'coraine', role: 'broker', present: false, url: 'https://github.com/SEAMWARE/coraine.git' }, this.repos.dir));
      foot.replaceChildren(el('div', 'cp-note', t('coraine first: its build scripts say which other repositories a build needs.')));
      return;
    }
    //
    // The repositories that need a look - missing, another branch than main, a branch that is not there,
    // uncommitted changes it might have been meant to take, elsewhere - the others on "Show all"
    //
    const look = (r) => !r.present || r.chosen || r.refFound === false || this.dirtyMatters(r) || r.elsewhere;
    const shown = this.showAll ? this.repos.repos : this.repos.repos.filter(look);
    list.replaceChildren(...shown.map((r) => this.repoRow(r, this.repos.dir)));
    list.hidden = shown.length === 0;

    const missing = this.missing();
    const notRunning = missing.filter((r) => (this.clones.get(r.name) || {}).state !== 'running');
    const parts = [];
    const present = this.repos.repos.length - missing.length;
    if (this.busy) parts.push(el('span', 'cp-note', this.busy));
    else if (this.repos.complete === false) parts.push(el('span', 'cp-note', t('Not the whole list: {why}.', { why: this.repos.why || t('coraine is not here') })));
    else if (missing.length) parts.push(el('span', 'cp-note', t('{present} of the {n} repositories a build with these bridges needs are here', { present, n: this.repos.repos.length })));
    else parts.push(el('span', 'cp-label', t('Select a branch for each repository')));       // the sub-section's heading
    const acts = el('span', 'cp-src-acts');
    if (notRunning.length > 1) {
      const all = el('button', 'btn primary', t('Clone the {n} missing', { n: notRunning.length }));
      all.type = 'button';
      all.addEventListener('click', () => this.clone(notRunning.map((r) => r.name)));
      acts.append(all);
    }
    //
    // Show all / Hide and Refresh: icons, after the line - above the table, so they stay where they are
    //
    if (shown.length < this.repos.repos.length || this.showAll) {
      const tg = el('button', 'iconbtn cp-src-icon', this.showAll ? '−' : '+');
      tg.type = 'button';
      tg.title = this.showAll ? t('Hide') : t('Show all {n}', { n: this.repos.repos.length });
      tg.setAttribute('aria-label', tg.title);
      tg.setAttribute('aria-expanded', String(this.showAll));
      tg.addEventListener('click', () => { this.showAll = !this.showAll; this.render(); });
      acts.append(tg);
    }
    const refresh = el('button', 'iconbtn cp-src-icon', '↻');
    refresh.type = 'button';
    refresh.title = t('Fetch every clone from origin and list the branches again - for branches made after c³ started');
    refresh.setAttribute('aria-label', t('Refresh'));
    refresh.disabled = !!this.busy;
    refresh.addEventListener('click', () => this.refresh());
    const q = el('button', 'cp-q inline', '?');
    q.type = 'button';
    q.title = t('What goes into the build?');
    q.setAttribute('aria-label', q.title);
    q.addEventListener('click', () => helpShow(t('What goes into the build'), BRANCH_HELP()));
    acts.append(refresh, q);
    parts.push(acts);
    foot.replaceChildren(...parts);
  }

  //
  // refSelect - the pull-down of what of a clone goes in: main (origin/main) first, the local branches, origin's,
  // HEAD - each group last-committed first
  //
  refSelect(r) {
    const s = el('select', 'cp-input cp-repo-ref');
    s.setAttribute('aria-label', t('The branch of {repo} the build takes', { repo: r.name }));
    s.title = t('The build takes the last commit of this branch, as this clone has it - uncommitted changes are not in it. origin/... as last fetched: Refresh fetches.');
    s.disabled = !!this.busy;
    const opt = (value, label) => { const o = el('option', '', label); o.value = value; return o; };
    s.append(opt('', t('main (origin/main)')));
    const local = (r.local || []);
    const remote = (r.remote || []);
    if (local.length) {
      const g = el('optgroup');
      g.label = t('Branches of this clone');
      for (const b of local) g.append(opt(b, b + (b === r.branch ? ' ' + t('(checked out)') : '')));
      s.append(g);
    }
    if (remote.length) {
      const g = el('optgroup');
      g.label = t('Branches at origin');
      for (const b of remote) g.append(opt(b, b));
      s.append(g);
    }
    s.append(opt('HEAD', t('HEAD - what is checked out') + (r.branch ? ' (' + r.branch + ')' : '')));
    const value = r.chosen ? r.ref : '';
    if (value && !local.includes(value) && !remote.includes(value) && value !== 'HEAD') {
      const gone = opt(value, value + ' ' + t('(not in this clone)'));
      gone.className = 'gone';
      s.append(gone);
    }
    s.value = value;
    s.addEventListener('change', () => this.chooseRef(r, s.value, s));
    return s;
  }

  //
  // repoRow - one repository: name, role, the branch that goes in; or how to get it
  //
  repoRow(r, dir) {
    const row = el('div', 'cp-repo' + (r.present ? '' : ' missing'));
    const head = el('div', 'cp-repo-head');
    head.append(el('span', 'cp-repo-dot', r.present ? '✓' : '!'), el('span', 'cp-repo-name', r.name), el('span', 'cp-repo-role', ROLE[r.role] ? t(ROLE[r.role]) : (r.role || '')));

    if (r.present) {
      const br = el('span', 'cp-repo-branch');
      br.append(this.refSelect(r));
      head.append(br);
      row.append(head);
      if (r.refFound === false) row.append(el('div', 'cp-repo-warn gone', t('{ref} is not in this clone - choose another branch, or Refresh when it is new at origin', { ref: r.ref })));
      if (this.dirtyMatters(r)) row.append(el('div', 'cp-repo-warn', plural(r.dirty, '{n} uncommitted change - not in the build', '{n} uncommitted changes - not in the build', { n: r.dirty })
                                                                     + ' (' + t('only what is committed goes in') + ')'));
      if (r.elsewhere) {
        const at = el('div', 'cp-repo-at');
        at.append(el('span', 'cp-note', t('a clone elsewhere: {path}', { path: r.path })));
        const forget = el('button', 'cp-linkbtn', t('Forget this path'));
        forget.type = 'button';
        forget.addEventListener('click', () => this.elsewhere(r.name, ''));
        at.append(forget);
        row.append(at);
      }
      return row;
    }

    //
    // Missing: Clone, the command, or the path of a clone elsewhere
    //
    const c = this.clones.get(r.name);
    const st = el('span', 'cp-repo-what');
    if (c && c.state === 'running') st.textContent = t('cloning into {path} ...', { path: dir + '/' + r.name });
    else if (c && c.state === 'failed') st.textContent = t('the clone failed: {error}', { error: c.message || t('see the backend\'s output') });
    else st.textContent = t('not in {dir}', { dir });
    head.append(st);
    row.append(head);

    const acts = el('div', 'cp-repo-acts');
    const cl = el('button', 'btn primary', t('Clone'));
    cl.type = 'button';
    cl.disabled = !!(c && c.state === 'running');
    cl.addEventListener('click', () => this.clone([r.name]));
    const cmdText = 'git clone ' + r.url + ' ' + dir + '/' + r.name;
    const cmd = el('code', 'cp-repo-cmd', cmdText);
    const copy = el('button', 'cp-linkbtn', t('Copy'));
    copy.type = 'button';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(cmdText).then(() => { copy.textContent = t('Copied'); setTimeout(() => { copy.textContent = t('Copy'); }, 1500); }).catch(() => {});
    });
    const other = el('button', 'cp-linkbtn', t('It is elsewhere ...'));
    other.type = 'button';
    other.addEventListener('click', () => {
      if (this.elsewhereOpen.has(r.name)) this.elsewhereOpen.delete(r.name); else this.elsewhereOpen.add(r.name);
      this.render();
      const i = document.getElementById('cp-src-at-' + r.name);
      if (i) i.focus();
    });
    acts.append(cl, cmd, copy, other);
    row.append(acts);

    if (this.elsewhereOpen.has(r.name)) {
      const f = el('form', 'cp-repo-at');
      const i = el('input', 'cp-input');
      i.id = 'cp-src-at-' + r.name;
      i.placeholder = '/path/to/' + r.name;
      i.spellcheck = false;
      i.autocomplete = 'off';
      i.setAttribute('aria-label', t('The path of the {repo} clone', { repo: r.name }));
      const ok = el('button', 'btn', t('Use'));
      ok.type = 'submit';
      f.append(i, ok);
      f.addEventListener('submit', (e) => { e.preventDefault(); if (i.value.trim()) this.elsewhere(r.name, i.value.trim()); });
      row.append(f);
    }
    return row;
  }

  //
  // bind - the static controls (once)
  //
  bind() {
    const use = () => {
      const d = $('cp-src-dir').value.trim();
      if (d) this.use({ kind: 'clones', dir: d });
    };
    $('cp-src-use').addEventListener('click', use);

    $('cp-src-dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); use(); } });
  }
}
