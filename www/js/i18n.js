//
// i18n.js - c³ in the user's language: English, Español, Français, Deutsch
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The English text is the key: t('Connect') is 'Conectar' in Spanish, and a text with no translation stays
// English - never a key on the screen. Values go in by name: t('{n} entities shown', { n: 12 }).
//
// The catalogs are www/i18n/<lang>.json, { "<English>": "<translation>" }; tools/i18n-check.py lists what each
// one lacks. The language: the one chosen in c³ (the language menu - kept in c3.json's "ui", and in this
// browser), else the browser's own, else English. Changing it reloads the page.
//
// The static page (index.html) is translated as it is: every text node and every title, placeholder,
// aria-label and alt whose English is in the catalog. An element with data-i18n-html is translated whole - its
// innerHTML is the key - for a sentence with markup inside it.
//

export const LANGUAGES = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' };

const KEY = 'c3.lang';
let lang = 'en';
let catalog = {};

export function language() {
  return lang;
}

//
// t - the text in the user's language; {name} replaced by vars.name
//
export function t(text, vars) {
  let s = Object.prototype.hasOwnProperty.call(catalog, text) ? catalog[text] : text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

//
// tk - a text marked for translation where it is defined (a table built when the module loads, before the
// language is known), and translated with t() where it is shown: const KINDS = { a: tk('Broker') } ... t(KINDS.a)
//
export const tk = (text) => text;

//
// plural - t() of the singular or the plural form, by n: plural(n, '{n} entity', '{n} entities')
//
export function plural(n, one, many, vars = {}) {
  return t(n === 1 ? one : many, { n, ...vars });
}

//
// number, date - in the user's language's own form (1.234,5 in Spanish and German)
//
export function number(n, opts) {
  return typeof n === 'number' ? n.toLocaleString(lang, opts) : String(n);
}

async function chosen() {
  try {
    const r = await fetch('/api/config', { cache: 'no-cache' });
    const v = r.ok ? ((await r.json()).ui || {}).lang : null;
    if (v && LANGUAGES[v]) return v;
  } catch { /* no backend yet: this browser's choice */ }
  try {
    const v = localStorage.getItem(KEY);
    if (v && LANGUAGES[v]) return v;
  } catch { /* no storage: the browser's language */ }
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const two = String(l).slice(0, 2).toLowerCase();
    if (LANGUAGES[two]) return two;
  }
  return 'en';
}

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

//
// translate - a part of the page, as written in English, into the language
//
export function translate(root) {
  if (lang === 'en' || !root) return;
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const key = el.innerHTML.replace(/\s+/g, ' ').trim();
    if (Object.prototype.hasOwnProperty.call(catalog, key)) el.innerHTML = catalog[key];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest('[data-i18n-html], script, style, .mono, code') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const key = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (key && Object.prototype.hasOwnProperty.call(catalog, key)) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), catalog[key]);
  }
  for (const a of ATTRS) {
    for (const el of root.querySelectorAll(`[${a}]`)) {
      const key = el.getAttribute(a).trim();
      if (Object.prototype.hasOwnProperty.call(catalog, key)) el.setAttribute(a, catalog[key]);
    }
  }
}

//
// i18nInit - the language chosen, its catalog loaded, the static page translated; before any module draws
//
export async function i18nInit() {
  lang = await chosen();
  document.documentElement.lang = lang;
  if (lang !== 'en') {
    try {
      const r = await fetch(`i18n/${lang}.json`, { cache: 'no-cache' });
      if (r.ok) catalog = await r.json();
    } catch { /* no catalog: English */ }
  }
  translate(document.body);
  document.title = t(document.title);
}

export async function setLanguage(l) {
  if (!LANGUAGES[l] || l === lang) return;
  try { localStorage.setItem(KEY, l); } catch { /* not kept here: c3.json has it */ }
  try { await fetch('/api/ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }); } catch { /* this browser's choice only */ }
  location.reload();
}
