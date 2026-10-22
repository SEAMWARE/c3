//
// docs.js - the Documentation page: the list of everything (#docs), and a guide, each a file of www/docs
// (#docs/<guide>)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The private repositories are not in the page's source: the backend says which ones the user can read
// (GET /api/repos/private, asked of GitHub as them), and only those are added, each to its group.
//
const $ = (id) => document.getElementById(id);

const GUIDES = ['extreme-performance', 'database-indexes'];
const loaded = new Map();
let privateDone = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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
  if (privateDone) return;
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
    if (!group) continue;

    const li = el('li');
    const a = el('a');
    a.href = 'https://github.com/SEAMWARE/' + encodeURIComponent(repo.name);
    a.target = '_blank';
    a.rel = 'noopener';
    a.append(el('span', 'dname', repo.name), el('span', 'dpriv', 'private'));
    li.append(a, el('span', 'ddesc', repo.description || ''));
    $(group).append(li);
  }
}

export async function docsShow(hash) {
  const m = /^#docs\/([a-z-]+)$/.exec(hash);
  const guide = (m && GUIDES.includes(m[1])) ? m[1] : null;

  $('docs-index').hidden = (guide !== null);
  $('docs-reader').hidden = (guide === null);
  $('page-docs').scrollTop = 0;

  if (guide === null) {
    privateRepos();
    return;
  }

  const box = $('docs-guide');
  if (box.dataset.guide === guide) return;

  let html = loaded.get(guide);
  if (html === undefined) {
    try {
      const r = await fetch('docs/' + guide + '.html');
      html = r.ok ? await r.text() : '<p class="muted">This guide could not be read (' + r.status + ').</p>';
      if (r.ok) loaded.set(guide, html);
    } catch (e) {
      html = '<p class="muted">This guide could not be read: the backend did not answer.</p>';
    }
  }

  box.innerHTML = html;
  box.dataset.guide = guide;
}
