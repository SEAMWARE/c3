//
// site.js - the website of the documentation (make site): c³'s Documentation page, on its own
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// version.json (written by make site): which documentation this is - "latest" (main) or a release
//
import { docsInit, docsShow } from './docs.js';

async function versionShow() {
  try {
    const r = await fetch('version.json');
    if (!r.ok) return;
    const v = await r.json();
    const chip = document.getElementById('site-version');
    chip.textContent = (v.version === 'latest') ? 'latest - main' : v.version;
    chip.title = 'Built from c³ ' + (v.commit || '');
    chip.hidden = false;
  } catch (e) {
    // no version shown
  }
}

docsInit({ site: true });
if (!location.hash.startsWith('#docs')) history.replaceState(null, '', '#docs');
docsShow(location.hash);
window.addEventListener('hashchange', () => docsShow(location.hash.startsWith('#docs') ? location.hash : '#docs'));
versionShow();
