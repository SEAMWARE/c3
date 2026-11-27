//
// ui.js - the buttons every popup shares: its close (a red × in its top right corner) and its save (a disk)
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A popup closes by its × only - no "Close" or "Cancel" button beside it. A popup that saves: its × closes it
// without saving (the tooltip says so), and Save closes it too, once saved.
//
const SVG = 'http://www.w3.org/2000/svg';

const icon = (paths) => {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
};

export const X_PATHS = ['M6 6l12 12M18 6L6 18'];
export const SAVE_PATHS = ['M5 4h11.2L20 7.8V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z', 'M8 4v5h7V4', 'M7.5 20v-6.5h9V20'];

//
// closeX - the red ×: 'label' its tooltip and its name for a screen reader; corner - placed in the popup's top
// right corner (a popup without a header row; the popup is position: relative or fixed)
//
export function closeX(label, onClick, corner = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = corner ? 'xclose corner' : 'xclose';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(X_PATHS));
  if (onClick) b.onclick = onClick;
  return b;
}

//
// saveButton - Save as a disk: 'label' its tooltip and name; cls - its classes (default the primary button's)
//
export function saveButton(label, onClick, cls = 'btn primary') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + ' isave';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(SAVE_PATHS));
  if (onClick) b.onclick = onClick;
  return b;
}

//
// xFill - the page's own × buttons (index.html: class xclose, empty) given their cross
//
export function xFill(root = document) {
  for (const b of root.querySelectorAll('button.xclose:empty')) b.append(icon(X_PATHS));
}
