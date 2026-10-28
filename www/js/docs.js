//
// docs.js - the Documentation page: the list of everything (#docs), a guide (#docs/<guide>, a section of
// it: #docs/<guide>/<section>), and search across the guides
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// What the page lists is docs/guides.json; a guide is docs/<id>.html, a fragment put into the reader. The
// same module is the website's (site/index.html, `make site`): docsInit({ site: true }) - no backend there,
// so no private repositories, and a link to a page of c³ itself (#compile, #run, ...) says it is in c³.
//
// The private repositories are not in the page's source: the backend says which ones the user can read
// (GET /api/repos/private, asked of GitHub as them), and only those are added, each to its group.
//
const $ = (id) => document.getElementById(id);

const C3_PAGES = ['compile', 'run', 'connect'];

let site = false;
let contents = null;                          // guides.json, once read
let guides = [];                              // every guide, in the order of the list: { id, title, desc, group }
const loaded = new Map();                     // id -> the guide's HTML
let searchIndex = null;                       // [ { guide, section, title, text } ], built on the first search
let privateDone = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

//
// slug - an id for a heading that has none: its text, lower case, words joined by '-'
//
function slug(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 64);
}

async function contentsRead() {
  if (contents) return contents;
  try {
    const r = await fetch('docs/guides.json');
    contents = r.ok ? await r.json() : { groups: [] };
  } catch (e) {
    contents = { groups: [] };
  }

  guides = [];
  for (const g of contents.groups)
    for (const it of g.items)
      if (it.id) guides.push({ ...it, group: g.title });

  return contents;
}

//
// repoItem - a component's line in the list: its name opens its guide here (guides.json "guide"), else its
// repository on GitHub; beside the description its API reference ("api") and the repository
//
function repoItem(name, desc, isPrivate, guide, api) {
  const li = el('li');
  const repoUrl = 'https://github.com/SEAMWARE/' + encodeURIComponent(name);
  const ext = (a) => { a.target = '_blank'; a.rel = 'noopener'; return a; };
  const a = el('a');
  a.href = guide ? '#docs/' + guide : repoUrl;
  if (!guide) ext(a);
  a.append(el('span', 'dname', name));
  if (isPrivate) a.append(el('span', 'dpriv', 'private'));

  const d = el('span', 'ddesc', desc || '');
  const more = el('span', 'dmore');
  if (api) {
    const x = el('a', '', 'API reference');
    x.href = '#docs/' + api;
    more.append(x);
  }
  if (guide) {
    const x = ext(el('a', '', 'repository ↗'));
    x.href = repoUrl;
    more.append(x);
  }
  if (more.children.length) d.append(more);
  li.append(a, d);
  return li;
}

function indexRender() {
  const box = $('docs-groups');
  if (box.dataset.done) return;
  box.dataset.done = '1';

  for (const g of contents.groups) {
    const ul = el('ul', 'doclist');
    if (g.privateGroup) ul.id = 'docs-g-' + g.privateGroup;
    //
    // A component's own guide - its title the component's name (lib-corargs: "corArgs - command-line options"), or its
    // id (c3) - is on the component's line; a guide of its own (Writing a bridge) keeps its line
    //
    const repoOf = new Map(g.items.filter((it) => it.repo && it.guide).map((it) => [it.guide, it.repo]));
    const inLine = (it) => {
      const r = repoOf.get(it.id);
      return !!r && ((it.title === r) || it.title.startsWith(r + ' ') || (it.id === r.toLowerCase()));
    };

    for (const it of g.items) {
      if (it.id && inLine(it)) continue;
      if (it.id) {
        const li = el('li');
        const a = el('a');
        a.href = '#docs/' + it.id;
        a.append(el('span', 'dname', it.title));
        li.append(a, el('span', 'ddesc', it.desc || ''));
        ul.append(li);
      } else if (it.repo) {
        ul.append(repoItem(it.repo, it.desc, false, it.guide, it.api));
      }
    }
    box.append(el('h2', 'docgroup', g.title), ul);
  }
}

//
// groupOf - the group of a private repository by its name: a cor*Bridge is a bridge, any other cor* a tool;
// null: not one the page lists
//
function groupOf(name) {
  if (/^cor[A-Z][A-Za-z0-9]*Bridge$/.test(name)) return 'docs-g-bridges';
  if (/^cor[A-Z][A-Za-z0-9]*$/.test(name)) return 'docs-g-tools';
  return null;
}

async function privateRepos() {
  if (privateDone || site) return;
  privateDone = true;

  let repos = [];
  try {
    const r = await fetch('/api/repos/private');
    repos = r.ok ? await r.json() : [];
  } catch (e) {
    repos = [];
  }

  for (const repo of repos.sort((a, b) => a.name.localeCompare(b.name))) {
    const group = groupOf(repo.name || '');
    if (!group || !$(group)) continue;
    $(group).append(repoItem(repo.name, repo.description, true));
  }
}

async function guideRead(id) {
  let html = loaded.get(id);
  if (html !== undefined) return html;

  try {
    const r = await fetch('docs/' + id + '.html');
    if (!r.ok) return '<p class="muted">This guide could not be read (' + r.status + ').</p>';
    html = await r.text();
    loaded.set(id, html);
    return html;
  } catch (e) {
    return '<p class="muted">This guide could not be read: ' + (site ? 'no answer.' : 'the backend did not answer.') + '</p>';
  }
}

//
// headingsIdentify - every h2 and h3 of a guide with an id (a slug of its text when it has none), so that a
// section can be linked to and found by search
//
function headingsIdentify(root) {
  const taken = new Set([...root.querySelectorAll('[id]')].map((e) => e.id));
  for (const h of root.querySelectorAll('h2, h3')) {
    if (h.id) continue;
    const base = slug(h.textContent) || 'section';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = base + '-' + n;
    h.id = id;
    taken.add(id);
  }
}

//
// siteLinks - on the website, a link to a page of c³ itself cannot open it: it becomes the name of the page,
// marked as being in c³
//
function siteLinks(root) {
  for (const a of root.querySelectorAll('a[href^="#"]')) {
    const page = a.getAttribute('href').slice(1).split('/')[0];
    if (!C3_PAGES.includes(page)) continue;
    const span = el('span', 'c3only');
    span.title = 'A page of c³ - the coraine Control Center';
    span.append(...a.childNodes, el('sup', null, ' c³'));
    a.replaceWith(span);
  }
}

function navRender(current) {
  const nav = $('docs-nav');
  nav.replaceChildren();

  let group = null;
  let ul = null;
  for (const g of guides) {
    if (g.group !== group) {
      group = g.group;
      ul = el('ul');
      nav.append(el('div', 'dn-group', group), ul);
    }
    const li = el('li');
    const a = el('a', null, g.title);
    a.href = '#docs/' + g.id;
    if (g.id === current) {
      a.className = 'active';
      a.setAttribute('aria-current', 'page');
    }
    li.append(a);
    ul.append(li);
  }
}

function tocRender(id, root) {
  const toc = $('docs-toc');
  toc.replaceChildren();

  const hs = root.querySelectorAll('h2');
  if (hs.length < 2) return;

  toc.append(el('div', 'dn-group', 'On this page'));
  const ul = el('ul');
  for (const h of hs) {
    const a = el('a', null, h.textContent.replace(/^\d+\s*/, ''));
    a.href = '#docs/' + id + '/' + h.id;
    const li = el('li');
    li.append(a);
    ul.append(li);
  }
  toc.append(ul);
}

//
// sourcesRender - the foot of a guide: the repositories its facts come from (guides.json "from"), each a
// link to it on GitHub - every guide links the repositories it describes
//
function sourcesRender(id, box) {
  const g = guides.find((x) => x.id === id);
  const repos = [...new Set((g.from || []).map((f) => f.repo))];
  if (repos.length === 0) return;

  const p = el('p', 'docs-source muted', repos.length === 1 ? 'Source: ' : 'Sources: ');
  repos.forEach((repo, ix) => {
    if (ix > 0) p.append(' · ');
    const a = el('a', null, 'SEAMWARE/' + repo + ' ↗');
    a.href = 'https://github.com/SEAMWARE/' + encodeURIComponent(repo);
    a.target = '_blank';
    a.rel = 'noopener';
    p.append(a);
  });
  box.append(p);
}

function pagerRender(id) {
  const pager = $('docs-pager');
  pager.replaceChildren();

  const ix = guides.findIndex((g) => g.id === id);
  const prev = guides[ix - 1];
  const next = guides[ix + 1];

  if (prev) {
    const a = el('a', 'prev');
    a.href = '#docs/' + prev.id;
    a.append(el('span', 'muted', '← Previous'), el('span', null, prev.title));
    pager.append(a);
  }
  if (next) {
    const a = el('a', 'next');
    a.href = '#docs/' + next.id;
    a.append(el('span', 'muted', 'Next →'), el('span', null, next.title));
    pager.append(a);
  }
}

// -----------------------------------------------------------------------------
//
// Search - every guide read (once), split into its sections (an h2 or h3 and what follows it up to the
// next), each section found by all the words searched for, in its heading or its text
//
async function searchIndexBuild() {
  if (searchIndex) return searchIndex;

  const parser = new DOMParser();
  const all = await Promise.all(guides.map(async (g) => ({ g, html: await guideRead(g.id) })));

  searchIndex = [];
  for (const { g, html } of all) {
    const doc = parser.parseFromString('<div id="r">' + html + '</div>', 'text/html');
    const root = doc.getElementById('r');
    headingsIdentify(root);

    let cur = { guide: g, section: null, title: g.title, text: '' };
    searchIndex.push(cur);

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1 && (n.tagName === 'H2' || n.tagName === 'H3')) {
        cur = { guide: g, section: n.id, title: n.textContent.replace(/^\d+\s*/, ''), text: '' };
        searchIndex.push(cur);
        continue;
      }
      if (n.nodeType === 3 && !n.parentElement.closest('h2, h3, h1')) cur.text += n.textContent;
    }
  }

  for (const s of searchIndex) {
    s.text = s.text.replace(/\s+/g, ' ').trim();
    s.lower = (s.title + ' ' + s.text).toLowerCase();
  }
  return searchIndex;
}

function snippet(text, word) {
  const i = text.toLowerCase().indexOf(word);
  if (i < 0) return text.slice(0, 160);
  const from = Math.max(0, i - 60);
  return (from > 0 ? '… ' : '') + text.slice(from, from + 180) + (from + 180 < text.length ? ' …' : '');
}

async function searchRun(input, out) {
  const words = input.value.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  out.replaceChildren();
  out.hidden = (words.length === 0);
  if (words.length === 0) return;

  const index = await searchIndexBuild();
  const hits = [];
  for (const s of index) {
    if (!words.every((w) => s.lower.includes(w))) continue;
    const t = s.title.toLowerCase();
    hits.push({ s, score: words.filter((w) => t.includes(w)).length * 10 + (s.section ? 0 : 5) });
  }
  hits.sort((a, b) => b.score - a.score);

  if (hits.length === 0) {
    out.append(el('div', 'ds-none', 'Nothing found for “' + input.value.trim() + '”.'));
    return;
  }

  for (const { s } of hits.slice(0, 40)) {
    const a = el('a', 'ds-hit');
    a.href = '#docs/' + s.guide.id + (s.section ? '/' + s.section : '');
    a.append(el('span', 'ds-title', s.title), el('span', 'ds-where', s.guide.title), el('span', 'ds-snip', snippet(s.text, words[0])));
    out.append(a);
  }
  if (hits.length > 40) out.append(el('div', 'ds-none', (hits.length - 40) + ' more - add a word to narrow it.'));
}

function searchWire(inputId, outId) {
  const input = $(inputId);
  const out = $(outId);
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => searchRun(input, out), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; out.hidden = true; }
    if (e.key === 'Enter') out.querySelector('a')?.click();
  });
  out.addEventListener('click', (e) => {
    if (e.target.closest('a')) { out.hidden = true; input.value = ''; }
  });
}

// -----------------------------------------------------------------------------
//
// docsInit - once: { site: true } for the website
//
export function docsInit(opts = {}) {
  site = !!opts.site;

  // A link to a section of a page (data-scroll): scrolled to, the page's hash kept
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-scroll]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

export async function docsShow(hash) {
  await contentsRead();
  searchWire('docs-search', 'docs-results');
  searchWire('docs-search-2', 'docs-results-2');

  const m = /^#docs\/([a-z0-9-]+)(?:\/([\w-]+))?$/.exec(hash);
  const guide = (m && guides.some((g) => g.id === m[1])) ? m[1] : null;
  const section = m ? m[2] : undefined;

  $('docs-index').hidden = (guide !== null);
  $('docs-reader').hidden = (guide === null);

  if (guide === null) {
    $('page-docs').scrollTop = 0;
    indexRender();
    privateRepos();
    return;
  }

  const box = $('docs-guide');
  if (box.dataset.guide !== guide) {
    box.innerHTML = await guideRead(guide);
    box.dataset.guide = guide;
    headingsIdentify(box);
    sourcesRender(guide, box);
    if (site) siteLinks(box);
    navRender(guide);
    tocRender(guide, box);
    pagerRender(guide);
    if (site) document.title = guides.find((x) => x.id === guide).title + ' - coraine documentation';
  }

  const target = section ? document.getElementById(section) : null;
  if (target && box.contains(target)) target.scrollIntoView({ block: 'start' });
  else $('page-docs').scrollTop = 0;
}
