//
// menu.js - a context menu with submenus, for the mouse and the keyboard
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// openMenu({ x, y, items, label, returnFocus }) shows a menu at (x, y) in the window, kept inside it.
// An item: { label, hint, action, items, disabled }; one with 'items' opens a submenu. { separator: true }
// draws a line.
//
// Keys (WAI-ARIA menu pattern): Down / Up move (and wrap), Home / End, Enter or Space activates, Right
// opens a submenu, Left closes it, Esc closes the submenu or the menu, Tab closes the menu. The focus
// goes back to 'returnFocus' when the menu closes without an action that moved it.
//

let open = null;                                 // { root, levels: [element], returnFocus }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function closeMenu(restore = true) {
  if (!open) return;
  const o = open;
  open = null;
  for (const m of o.levels) m.remove();
  document.removeEventListener('pointerdown', o.outside, true);
  window.removeEventListener('resize', o.dismiss);
  window.removeEventListener('blur', o.dismiss);
  if (restore && o.returnFocus && document.contains(o.returnFocus)) o.returnFocus.focus({ preventScroll: true });
}

export function menuOpen() {
  return open !== null;
}

function place(menu, x, y, alt) {
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  if (x + r.width > W - 8) x = alt !== undefined ? Math.max(8, alt - r.width) : Math.max(8, W - 8 - r.width);
  if (y + r.height > H - 8) y = Math.max(8, H - 8 - r.height);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function itemsOf(menu) {
  return [...menu.querySelectorAll(':scope > [role="menuitem"]:not([aria-disabled="true"])')];
}

function focusItem(menu, i) {
  const items = itemsOf(menu);
  if (!items.length) return;
  items[(i + items.length) % items.length].focus();
}

function build(items, level, label) {
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  if (label) menu.setAttribute('aria-label', label);
  menu.dataset.level = level;

  for (const it of items) {
    if (it.separator) {
      const s = el('div', 'sep');
      s.setAttribute('role', 'separator');
      menu.append(s);
      continue;
    }
    const b = el('div', 'item');
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.append(el('span', 'label', it.label));
    if (it.hint) b.append(el('span', 'hint', it.hint));
    if (it.items) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.append(el('span', 'more', '›'));
    }
    if (it.disabled || (it.items && it.items.length === 0)) b.setAttribute('aria-disabled', 'true');
    b._item = it;
    menu.append(b);
  }

  menu.addEventListener('keydown', (e) => onKey(e, menu));
  menu.addEventListener('pointerover', (e) => {
    const b = e.target.closest('[role="menuitem"]');
    if (!b || b.parentNode !== menu) return;
    if (b.getAttribute('aria-disabled') !== 'true') b.focus({ preventScroll: true });
    closeBelow(level);
    if (b._item.items && b.getAttribute('aria-disabled') !== 'true') openSub(b, level, false);
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[role="menuitem"]');
    if (!b || b.parentNode !== menu) return;
    activate(b, level);
  });
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  return menu;
}

function closeBelow(level) {
  if (!open) return;
  while (open.levels.length > level + 1) {
    const m = open.levels.pop();
    m.remove();
  }
  const parent = open.levels[level];
  if (parent) for (const b of parent.querySelectorAll('[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
}

function openSub(b, level, focusFirst) {
  closeBelow(level);
  const sub = build(b._item.items, level + 1, b._item.label);
  const r = b.getBoundingClientRect();
  place(sub, r.right - 4, r.top - 5, r.left + 4);
  open.levels.push(sub);
  b.setAttribute('aria-expanded', 'true');
  if (focusFirst) focusItem(sub, 0);
}

function activate(b, level) {
  if (b.getAttribute('aria-disabled') === 'true') return;
  const it = b._item;
  if (it.items) { openSub(b, level, true); return; }
  closeMenu(true);
  if (it.action) it.action();
}

function onKey(e, menu) {
  const level = Number(menu.dataset.level);
  const items = itemsOf(menu);
  const i = items.indexOf(document.activeElement);
  const k = e.key;

  if (k === 'ArrowDown')      focusItem(menu, i + 1);
  else if (k === 'ArrowUp')   focusItem(menu, i < 0 ? -1 : i - 1);
  else if (k === 'Home')      focusItem(menu, 0);
  else if (k === 'End')       focusItem(menu, -1);
  else if (k === 'Enter' || k === ' ') { if (i >= 0) activate(items[i], level); }
  else if (k === 'ArrowRight') { if (i >= 0 && items[i]._item.items) openSub(items[i], level, true); }
  else if (k === 'ArrowLeft' || k === 'Escape') {
    if (level > 0) {
      closeBelow(level - 1);
      const parent = open.levels[level - 1];
      const opener = [...parent.querySelectorAll('[role="menuitem"]')].find((x) => x._item.label === menu.getAttribute('aria-label'));
      if (opener) opener.focus();
    } else if (k === 'Escape') closeMenu(true);
  } else if (k === 'Tab') closeMenu(true);
  else if (k.length === 1 && /\S/.test(k)) {
    //
    // A letter: the next item starting with it
    //
    const lower = k.toLowerCase();
    const n = items.length;
    for (let j = 1; j <= n; j++) {
      const c = items[(i + j + n) % n];
      if (c.textContent.trim().toLowerCase().startsWith(lower)) { c.focus(); break; }
    }
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

export function openMenu({ x, y, items, label, returnFocus }) {
  closeMenu(false);
  const root = build(items, 0, label);
  const dismiss = () => closeMenu(false);
  const outside = (e) => { if (!e.target.closest('.menu')) closeMenu(false); };
  open = { root, levels: [root], returnFocus, outside, dismiss };
  place(root, x, y);
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
  focusItem(root, 0);
}
