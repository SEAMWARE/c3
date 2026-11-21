//
// header.js - the header's lines: the top line always one line, the page tabs beside it or under it
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The top line - the logo, c³'s name, AI Assist, the text size, the language, Seamware and the window's buttons -
// is never broken: the logo and the name on the left, the rest on the right. The page tabs are on it, centred
// between the two, when the header is wide enough for both, centred on a line of their own under it when not
// (the class two-lines, c3.css). The top line's width is the page's minimum width: a narrower browser window
// scrolls the page sideways, and c³'s own window is made that wide again (window.js).
//
// Measured again whenever any of it changes size: the window, the text size, the language (the tabs' and the
// buttons' words), the window's buttons shown or hidden.
//
import { windowWidthAtLeast } from './window.js';

const $ = (id) => document.getElementById(id);

const ROOM = 64;                                 // the least room on each side of the tabs on the top line

function width(el) {
  return (!el || el.hidden) ? 0 : el.getBoundingClientRect().width;
}

//
// fit - the top line's width, the page's minimum width, one line or two
//
function fit() {
  const header = document.querySelector('header.top');
  const cs = getComputedStyle(header);
  const gap = parseFloat(cs.columnGap) || 0;
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const mark = header.querySelector('.mark');
  const markGap = parseFloat(getComputedStyle(mark).marginRight) || 0;
  const brand = header.querySelector('.brand');
  const right = header.querySelector('.top-right');

  const links = [...header.querySelectorAll('nav.pages > *')].filter((a) => !a.hidden);
  const navGap = parseFloat(getComputedStyle(header.querySelector('nav.pages')).columnGap) || 0;
  const nav = links.reduce((w, a) => w + width(a), 0) + navGap * Math.max(0, links.length - 1);

  const top = Math.ceil(pad + width(mark) + markGap + gap + width(brand) + gap + width(right));
  const one = top + nav + 2 * ROOM;

  document.documentElement.style.minWidth = top + 'px';
  header.classList.toggle('two-lines', header.clientWidth < one);

  //
  // The window's own width, in the screen's units (Chrome's): the page's width in CSS pixels times the browser's
  // zoom (Ctrl +, kept per site) - outerWidth is in the screen's units, innerWidth in CSS pixels, so their ratio is
  // the zoom, with the window's frame in it (a little more than needed, never less). The scrollbar: CSS pixels
  //
  const inner = window.innerWidth;
  const scrollbar = inner - document.documentElement.clientWidth;
  if (inner > 0) windowWidthAtLeast(Math.ceil(window.outerWidth * (top + scrollbar) / inner) + 1);
}

export function headerInit() {
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fit(); });    // not inside the observer's own delivery
  };

  const header = document.querySelector('header.top');
  const ro = new ResizeObserver(later);
  ro.observe(header);
  [header.querySelector('.mark'), header.querySelector('.brand'), header.querySelector('.top-right'), ...header.querySelectorAll('nav.pages > *')]
    .forEach((el) => ro.observe(el));
  window.addEventListener('resize', later);
  if (document.fonts) document.fonts.ready.then(later);
  later();
}
