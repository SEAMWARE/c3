//
// docs.js - the Documentation page: its guides, each a file of www/docs, shown beside the list of them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// #docs/<guide> shows one (#docs: the first); a guide is fetched once, then kept.
//
const $ = (id) => document.getElementById(id);

const GUIDES = ['extreme-performance', 'database-indexes', 'components'];
const loaded = new Map();

export function docsGuideOf(hash) {
  const m = /^#docs\/([a-z-]+)$/.exec(hash);
  return (m && GUIDES.includes(m[1])) ? m[1] : GUIDES[0];
}

export async function docsShow(hash) {
  const guide = docsGuideOf(hash);
  const box = $('docs-guide');

  for (const a of document.querySelectorAll('.docs-nav a')) {
    const on = a.dataset.doc === guide;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }

  $('docs-components').hidden = (guide !== 'components');
  box.hidden = (guide === 'components');
  if (guide === 'components') return;

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
  $('docs-body').scrollTop = 0;
  window.scrollTo(0, 0);
}
