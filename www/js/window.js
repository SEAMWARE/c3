//
// window.js - minimise and close, for the full-screen window c³ opens, and back to full-screen; its width kept at least the header's
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

async function act(what, body) {
  const title = document.title;
  const nonce = 'c3-' + Math.random().toString(36).slice(2, 12);

  document.title = nonce;
  try {
    const r = await fetch('/api/window/' + what + '/' + nonce, body === undefined ? { method: 'POST' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

//
// windowWidths - the header's widths in the screen's units (header.js): top, the top line's - the least the window
// may be; one, the top line and the tabs on one line - the window's width when it leaves full-screen.
//
// Made narrower than top, c³'s own window is made that wide again, a moment after (a drag ended), so a drag is not
// fought - Chrome has no minimum width a page can set, the desktop asks the window's program for it. Leaving
// full-screen (F11, the desktop's), it is made one wide - the screen's width at most, the desktop sees to that.
// Neither full-screen nor maximised (the desktop's size), nor a window c³ has no hold of (control: false - a
// browser's tab, whose page scrolls sideways instead)
//
let control = null;                              // null: not asked yet
let widths = { top: 0, one: 0 };
let widthTimer = null;

export function windowWidths(top, one) {
  widths = { top: Math.ceil(top), one: Math.ceil(one) };
  clearTimeout(widthTimer);
  widthTimer = setTimeout(() => {
    if (control !== true || fullScreen() || window.outerWidth >= widths.top) return;
    act('width', { width: widths.top });
  }, 400);
}

export async function windowInit() {
  const box = $('win-ctl');

  try {
    const r = await fetch('/api/window');
    control = r.ok && (await r.json()).control === true;
  } catch (e) {
    control = false;
  }

  if (!control) return;
  window.dispatchEvent(new Event('resize'));     // the header measures again: the window's width can be had now

  //
  // Full-screen: minimise and close (no title bar). Not full-screen: a button back to full-screen - the title bar
  // has minimise, maximise and close, and maximised is not full-screen
  //
  let wasFull = fullScreen();
  const show = () => {
    const full = fullScreen();
    box.hidden = false;
    $('win-full').hidden = full;
    $('win-min').hidden = !full;
    $('win-close').hidden = !full;
    if (wasFull && !full) {
      //
      // Out of full-screen: the width everything fits in on one line - once the header has measured itself in
      // the window it is now (windowWidths) and the desktop is done with the change
      //
      setTimeout(() => {
        if (!fullScreen() && widths.one > 0) act('width', { width: Math.max(widths.one, widths.top), exact: true });
      }, 500);
    }
    wasFull = full;
  };
  show();
  window.addEventListener('resize', show);
  window.matchMedia('(display-mode: fullscreen)').addEventListener('change', show);

  //
  // Minimised, the window leaves full-screen (Chrome minimises none): shown again, it goes back.
  // Shown again by the desktop (the dock's icon), on Wayland Chrome is not told - the protocol has no
  // "un-minimised": it keeps the page hidden and paints nothing, the window looks frozen, and no
  // visibilitychange comes. The focus the window gets is told: focus lost after the minimise and then had
  // again counts as shown again - looked at on the events and every second, an event missed. Going
  // full-screen, Chrome is told the state again (c3: minimised -> normal -> full-screen) and paints again.
  //
  let minimised = false;
  let lostFocus = false;                         // since the minimise - the focus of the click is not "again"
  const back = () => {
    if (minimised) {
      minimised = false;
      act('fullscreen');
    }
  };
  const focusNow = () => {
    if (!minimised) return;
    if (!document.hasFocus()) lostFocus = true;
    else if (lostFocus) back();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') back(); });
  window.addEventListener('blur', focusNow);
  window.addEventListener('focus', focusNow);
  setInterval(focusNow, 1000);

  $('win-min').addEventListener('click', async () => {
    minimised = true;
    lostFocus = false;
    await act('minimize');
  });
  $('win-close').addEventListener('click', () => act('close'));
  $('win-full').addEventListener('click', () => act('fullscreen'));
}
