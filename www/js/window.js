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
// In c³'s Qt window (c3-window, qt/c3window.cpp) none of that: the window is the program's own - the page asks it
// over its channel (window.c3windowReady): minimise, close, full-screen, and the header's widths; the window keeps
// its minimum width and its width out of full-screen itself.
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
// full-screen (F11, the desktop's), it is made one wide - the screen's width at most (a wider one, the desktop drops).
// Neither full-screen nor maximised (the desktop's size), nor a window c³ has no hold of (control: false - a
// browser's tab, whose page scrolls sideways instead)
//
let control = null;                              // null: not asked yet
let widths = { top: 0, one: 0 };
let widthTimer = null;
let qtWin = null;                                // the Qt window's channel object, in c3-window

// topCss, oneCss: the same in CSS pixels, for the Qt window - it scales them by its zoom itself
export function windowWidths(top, one, topCss, oneCss) {
  if (qtWin) {
    qtWin.widths(Math.ceil(topCss), Math.ceil(oneCss));
    return;
  }
  widths = { top: Math.ceil(top), one: Math.ceil(one) };
  clearTimeout(widthTimer);
  widthTimer = setTimeout(() => {
    if (control !== true || fullScreen() || window.outerWidth >= widths.top) return;
    act('width', { width: widths.top });
  }, 400);
}

//
// qtInit - in c3-window: the buttons as in Chrome's window, the window doing the work
//
function qtInit(win) {
  const box = $('win-ctl');
  const show = (full) => {
    box.hidden = false;
    $('win-full').hidden = full;
    $('win-min').hidden = !full;
    $('win-close').hidden = !full;
  };

  qtWin = win;
  show(win.full);
  win.fullChanged.connect(show);
  $('win-min').addEventListener('click', () => win.minimize());
  $('win-close').addEventListener('click', () => win.close());
  $('win-full').addEventListener('click', () => win.fullScreen());
  window.dispatchEvent(new Event('resize'));     // the header measures again: its widths to the window
}

export async function windowInit() {
  const box = $('win-ctl');

  if (window.c3windowReady) {
    qtInit(await window.c3windowReady);
    return;
  }

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
  let screenW = 0;                               // the window's width full-screen: the screen's, in outerWidth's units
  const show = () => {
    const full = fullScreen();
    if (full) screenW = window.outerWidth;
    box.hidden = false;
    $('win-full').hidden = full;
    $('win-min').hidden = !full;
    $('win-close').hidden = !full;
    if (wasFull && !full) {
      //
      // Out of full-screen: the width everything fits in on one line - once the header has measured itself in
      // the window it is now (windowWidths) and the desktop is done with the change. The screen's width at most:
      // a wider window is not narrowed by the desktop, the change is dropped (the window stays as narrow as it was)
      //
      setTimeout(() => {
        if (fullScreen() || widths.one <= 0) return;
        const want = Math.max(widths.one, widths.top);
        act('width', { width: screenW > 0 ? Math.min(want, screenW) : want, exact: true });
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
