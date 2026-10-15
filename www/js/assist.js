//
// assist.js - the AI Assist button: its popup, which says what is coming and what it will ask for
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Nothing behind it yet: no model is called and no key is asked for or kept.
//
const $ = (id) => document.getElementById(id);

export function assistInit() {
  const btn = $('ai-btn');
  const pop = $('ai-pop');

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
