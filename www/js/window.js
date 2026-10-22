//
// window.js - minimise and close, for the full-screen window c³ opens
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Full-screen, the window has no title bar, and a page can neither leave the browser's full-screen nor
// minimise or close its window. c³'s backend can, through the Chrome it started (window.c): the buttons
// show when it says so and the window is full-screen. The page names itself to the backend by a title of
// its own for a moment - the browser lists its pages by their titles. Minimised, it leaves full-screen
// on the way (Chrome minimises no full-screen window), and goes back to it when it is shown again.
//
const $ = (id) => document.getElementById(id);

function fullScreen() {
  return window.matchMedia('(display-mode: fullscreen)').matches ||
         (window.innerWidth >= screen.width && window.innerHeight >= screen.height);
}

async function act(what) {
  const title = document.title;
  const nonce = 'c3-' + Math.random().toString(36).slice(2, 12);

  document.title = nonce;
  try {
    const r = await fetch('/api/window/' + what + '/' + nonce, { method: 'POST' });
    if (!r.ok) {
      const p = await r.json().catch(() => ({}));
      console.warn('c3: the window: ' + (p.detail || r.status));
    }
  } catch (e) {
    // closed: the answer does not come back
  } finally {
    document.title = title;
  }
}

export async function windowInit() {
  const box = $('win-ctl');
  let control = false;

  try {
    const r = await fetch('/api/window');
    control = r.ok && (await r.json()).control === true;
  } catch (e) {
    control = false;
  }

  if (!control) return;

  const show = () => { box.hidden = !fullScreen(); };
  show();
  window.addEventListener('resize', show);
  window.matchMedia('(display-mode: fullscreen)').addEventListener('change', show);

  //
  // Minimised, the window leaves full-screen (Chrome minimises none): shown again, it goes back
  //
  let minimised = false;
  document.addEventListener('visibilitychange', () => {
    if (minimised && document.visibilityState === 'visible') {
      minimised = false;
      act('fullscreen');
    }
  });

  $('win-min').addEventListener('click', async () => { minimised = true; await act('minimize'); });
  $('win-close').addEventListener('click', () => act('close'));
}
