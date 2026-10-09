//
// offline.js - "Download this area": the size first, then the download, and the areas downloaded
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The backend does the work (maps.c): it reads the Protomaps planet's directories to say how many tiles
// and bytes the area in view takes down to the level chosen - exactly, before anything is downloaded -
// then extracts those tiles into one .pmtiles file, and the fonts the labels need with the first area.
//
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

const LEVELS = [
  [10, 'level 10 - region: main roads, towns'],
  [12, 'level 12 - city: streets, parks'],
  [13, 'level 13'],
  [14, 'level 14 - streets with names'],
  [15, 'level 15 - everything: buildings, paths, addresses'],
];

export function bytesText(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const fmt = (x) => x.toFixed(3);

export class OfflinePanel {
  constructor({ map, toast, onAreas }) {
    this.map = map;                              // EntityMap
    this.toast = toast;
    this.onAreas = onAreas;                      // (areas, fonts) - the list changed
    this.status = null;                          // GET /api/maps
    this.estTicket = 0;
    this.polling = null;

    const z = $('dl-zoom');
    for (const [v, label] of LEVELS) {
      const o = el('option', null, label);
      o.value = v;
      z.append(o);
    }
    z.value = '15';
    z.onchange = () => this.estimate();
    $('dl-close').onclick = () => this.close();
    $('dl-go').onclick = () => this.download();
    $('dl-cancel').onclick = () => api.mapsCancel().catch(() => {});
    $('dlpanel').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  //
  // refresh - GET /api/maps: the areas, the fonts, a download in progress
  //
  async refresh() {
    try {
      this.status = await api.maps();
    } catch (e) {
      this.status = { areas: [], fonts: false, job: null, dir: '' };
    }
    this.renderAreas();
    return this.status;
  }

  isOpen() {
    return !$('dlpanel').hidden;
  }

  async open() {
    $('dlpanel').hidden = false;
    this.returnFocus = document.activeElement;
    this.bbox = this.map.bounds();
    $('dl-bbox').textContent = `${fmt(this.bbox[0])}, ${fmt(this.bbox[1])} … ${fmt(this.bbox[2])}, ${fmt(this.bbox[3])}`;
    const c = this.map.map.getCenter();
    if (!$('dl-name').value || this.autoName) {
      $('dl-name').value = `Area at ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
      this.autoName = true;
    }
    $('dl-name').oninput = () => { this.autoName = false; };
    const zoom = this.map.map.getZoom();
    if (!this.levelChosen) $('dl-zoom').value = zoom < 8 ? '10' : zoom < 10 ? '12' : '15';
    $('dl-zoom').onfocus = () => { this.levelChosen = true; };
    await this.refresh();
    $('dl-dir').textContent = this.status.dir || '';
    if (this.status.job && ['planning', 'tiles', 'fonts'].includes(this.status.job.state)) this.follow();
    else this.estimate();
    $('dl-close').focus();
  }

  close() {
    $('dlpanel').hidden = true;
    if (this.returnFocus && document.contains(this.returnFocus)) this.returnFocus.focus({ preventScroll: true });
  }

  //
  // estimate - the tiles and bytes of the area in view, from the planet's directories
  //
  async estimate() {
    const ticket = ++this.estTicket;
    const z = Number($('dl-zoom').value);
    const est = $('dl-est');
    est.className = 'dlest';
    est.textContent = 'Reading the planet’s index for this area…';
    $('dl-go').disabled = true;
    let r;
    try {
      r = await api.mapsEstimate(this.bbox, z);
    } catch (e) {
      if (ticket !== this.estTicket) return;
      est.className = 'dlest bad';
      est.textContent = 'No estimate: ' + e.message;
      return;
    }
    if (ticket !== this.estTicket) return;
    this.est = r;
    est.textContent = '';
    est.append(el('span', 'big', bytesText(r.bytes)), el('span', null, ` · ${r.tiles.toLocaleString()} tiles, levels 0-${r.maxzoom}`));
    const fonts = r.fonts ? '' : ' Plus the fonts for the labels, about 14 MB, once.';
    est.append(el('div', 'dim', `From the Protomaps planet build ${r.build}.${fonts}`));
    $('dl-go').disabled = false;
  }

  async download() {
    const name = $('dl-name').value.trim() || 'Area';
    $('dl-go').disabled = true;
    try {
      await api.mapsDownload(name, this.bbox, Number($('dl-zoom').value));
    } catch (e) {
      this.toast('Not started: ' + e.message);
      $('dl-go').disabled = false;
      return;
    }
    this.follow();
  }

  //
  // follow - the download's progress, until it ends
  //
  follow() {
    clearInterval(this.polling);
    const bar = $('dl-bar');
    const est = $('dl-est');
    $('dl-progress').hidden = false;
    $('dl-cancel').hidden = false;
    $('dl-go').disabled = true;
    const tick = async () => {
      let j;
      try { j = await api.mapsProgress(); } catch { return; }
      if (!j) return;
      est.className = 'dlest';
      if (j.state === 'planning') { est.textContent = `${j.name}: reading the planet’s index…`; bar.style.width = '3%'; }
      else if (j.state === 'tiles') {
        const f = j.bytesTotal ? j.bytesDone / j.bytesTotal : 0;
        est.textContent = `${j.name}: ${bytesText(j.bytesDone)} of ${bytesText(j.bytesTotal)} · ${j.tiles.toLocaleString()} tiles`;
        bar.style.width = Math.round(5 + 85 * f) + '%';
      } else if (j.state === 'fonts') {
        est.textContent = `${j.name}: the labels’ fonts, ${j.fontsDone} of ${j.fontsTotal} glyph ranges`;
        bar.style.width = Math.round(90 + 10 * (j.fontsTotal ? j.fontsDone / j.fontsTotal : 0)) + '%';
      } else {
        clearInterval(this.polling);
        this.polling = null;
        $('dl-progress').hidden = true;
        $('dl-cancel').hidden = true;
        $('dl-go').disabled = false;
        bar.style.width = '0';
        if (j.state === 'done') {
          est.textContent = `${j.name} is downloaded.` + (j.error ? ' ' + j.error : '');
          if (j.error) est.className = 'dlest bad';
          this.toast(`${j.name} downloaded - drawn from the file from now on`);
        } else if (j.state === 'cancelled') est.textContent = 'Cancelled - nothing kept.';
        else { est.className = 'dlest bad'; est.textContent = 'The download failed: ' + j.error; }
        await this.refresh();
        this.onAreas(this.status.areas, this.status.fonts);
      }
    };
    tick();
    this.polling = setInterval(tick, 600);
  }

  renderAreas() {
    const box = $('dl-areas');
    box.textContent = '';
    const areas = (this.status && this.status.areas) || [];
    if (!areas.length) { box.append(el('p', 'dlnote', 'None yet.')); return; }
    for (const a of areas) {
      const row = el('div', 'dlarea');
      const n = el('span', 'an', a.name);
      n.title = a.id;
      const show = el('button', 'btn show', 'Show');
      show.type = 'button';
      show.onclick = () => this.map.fitArea(a);
      const del = el('button', 'btn danger', 'Delete');
      del.type = 'button';
      del.onclick = async () => {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = 'Delete?';
          setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000);
          return;
        }
        try {
          this.status = await api.mapsDelete(a.id);
          this.renderAreas();
          this.onAreas(this.status.areas, this.status.fonts);
          this.toast(`${a.name} deleted`);
        } catch (e) {
          this.toast('Not deleted: ' + e.message);
        }
      };
      row.append(n, show, del, el('span', 'ai', `${bytesText(a.bytes)} · to level ${a.maxzoom} · ${String(a.created || '').slice(0, 10)}${a.build ? ' · build ' + a.build : ''}`));
      box.append(row);
    }
  }
}
