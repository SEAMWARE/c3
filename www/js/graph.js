//
// graph.js - the entity graph: boxes, arrows, zoom, pan, drag, selection, type filters
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The world is one element moved and scaled with a CSS transform (translate + scale); the boxes are
// elements in it, the arrows one SVG beneath them. Zoom and pan change the transform only; dragging a
// box moves that box and redraws the arrows that touch it.
//
// A box can be expanded: another element in its place, above the others (an entity with its linked
// entities embedded), until it is closed. Each box takes the focus (Tab); the context-menu key or
// Shift+F10 on a focused box, or a right-click, asks for its menu (onMenu).
//
import { BOX_W, BOX_H } from './layout.js';

const SVG = 'http://www.w3.org/2000/svg';
const K_MIN = 0.05;
const K_MAX = 3;

export class Graph {
  constructor(els) {
    this.vp = els.viewport;
    this.world = els.world;
    this.svg = els.svg;
    this.linesG = els.lines;
    this.labelsG = els.labels;
    this.boxesEl = els.boxes;
    this.pctEl = els.pct;
    this.onSelect = () => {};
    this.onMenu = () => {};
    this.onCollapse = () => {};                 // (id) - an expanded box closed with Esc                     // (id, {x, y}, element) - a box's context menu

    this.k = 1; this.tx = 0; this.ty = 0;
    this.nodes = new Map();     // id -> {id, x, y, types, el}
    this.edges = [];            // {from, to, name, g, line, rect, text}
    this.edgesAt = new Map();   // id -> [edge]
    this.hiddenTypes = new Set();
    this.sel = null;
    this.drag = null;

    this.vp.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.vp.addEventListener('pointerdown', (e) => this.onDown(e));
    this.vp.addEventListener('pointermove', (e) => this.onMove(e));
    this.vp.addEventListener('pointerup', (e) => this.onUp(e));
    this.vp.addEventListener('pointercancel', (e) => this.onUp(e));
    this.vp.addEventListener('keydown', (e) => this.onKey(e));
    this.vp.addEventListener('contextmenu', (e) => this.onContext(e));
    this.vp.addEventListener('focusin', (e) => {
      const box = e.target.closest && e.target.closest('.box[data-entity]');
      if (box && box.dataset.entity !== this.sel && !this.drag) this.select(box.dataset.entity);
    });
    //
    // Until the view is moved by hand, it stays fitted - also when the window changes size
    //
    this.autoFit = true;
    new ResizeObserver(() => (this.autoFit ? this.fit() : this.applyTransform())).observe(this.vp);
    this.applyTransform();
  }

  //
  // set - a new graph: nodes [{id, types, color, label, short, attrs}], edges [{from, to, name}], positions
  //
  set(nodes, edges, positions) {
    this.boxesEl.textContent = '';
    this.linesG.textContent = '';
    this.labelsG.textContent = '';
    this.nodes.clear();
    this.edgesAt.clear();
    this.edges = [];
    this.sel = null;
    this.expanded = null;

    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const p = positions.get(n.id) || { x: 0, y: 0 };
      const el = document.createElement('div');
      el.className = 'box';
      el.dataset.entity = n.id;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', n.label + ' ' + n.id);
      el.setAttribute('aria-haspopup', 'menu');
      el.tabIndex = 0;
      el.title = n.id;

      const stripe = document.createElement('div');
      stripe.className = 'stripe';
      stripe.style.background = n.color;
      const head = document.createElement('div');
      head.className = 'head';
      const t = document.createElement('span');
      t.className = 't';
      t.style.color = n.color;
      t.textContent = n.label;
      const id = document.createElement('span');
      id.className = 'id';
      id.textContent = n.short;
      head.append(t, id);
      el.append(stripe, head);
      for (const a of n.attrs) {
        const row = document.createElement('div');
        row.className = 'a';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = a.k;
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = a.v;
        row.append(k, v);
        el.append(row);
      }

      const node = { id: n.id, x: p.x, y: p.y, types: n.types, el };
      this.place(node);
      this.nodes.set(n.id, node);
      this.edgesAt.set(n.id, []);
      frag.append(el);
    }
    this.boxesEl.append(frag);

    const lines = document.createDocumentFragment();
    const labels = document.createDocumentFragment();
    for (const e of edges) {
      const g = document.createElementNS(SVG, 'g');
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('marker-end', 'url(#arrow)');
      g.append(line);
      const lg = document.createElementNS(SVG, 'g');
      const lbl = document.createElementNS(SVG, 'g');
      lbl.setAttribute('class', 'lbl');
      const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('rx', 6);
      rect.setAttribute('height', 20);
      rect.setAttribute('width', e.name.length * 7.3 + 16);
      const text = document.createElementNS(SVG, 'text');
      text.textContent = e.name;
      lbl.append(rect, text);
      lg.append(lbl);
      const edge = { ...e, g, lg, line, rect, text, w: e.name.length * 7.3 + 16 };
      this.edges.push(edge);
      this.edgesAt.get(e.from).push(edge);
      if (e.to !== e.from) this.edgesAt.get(e.to).push(edge);
      this.drawEdge(edge);
      lines.append(g);
      labels.append(lg);
    }
    this.linesG.append(lines);
    this.labelsG.append(labels);
    this.applyFilter();
  }

  place(node) {
    node.el.style.left = node.x + 'px';
    node.el.style.top = node.y + 'px';
    if (node.xel) {
      node.xel.style.left = node.x + 'px';
      node.xel.style.top = node.y + 'px';
    }
  }

  //
  // expand - 'content' shown in place of the box of 'id', above the others, until collapse()
  //
  expand(id, content) {
    this.collapse();
    const n = this.nodes.get(id);
    if (!n) return;
    content.classList.add('xbox');
    content.dataset.entity = id;
    n.xel = content;
    n.el.classList.add('under');
    this.place(n);
    this.boxesEl.append(content);
    this.expanded = id;
  }

  collapse() {
    if (!this.expanded) return;
    const n = this.nodes.get(this.expanded);
    this.expanded = null;
    if (!n || !n.xel) return;
    n.xel.remove();
    n.xel = null;
    n.el.classList.remove('under');
  }

  //
  // drawEdge - from the border of one box to the border of the other, along the line between centres
  //
  drawEdge(edge) {
    const a = this.nodes.get(edge.from), b = this.nodes.get(edge.to);
    const ax = a.x + BOX_W / 2, ay = a.y + BOX_H / 2, bx = b.x + BOX_W / 2, by = b.y + BOX_H / 2;
    const dx = bx - ax, dy = by - ay;
    const clip = (dx, dy, extra) => {
      const t = Math.min((BOX_W / 2 + extra) / Math.max(Math.abs(dx), 1e-6), (BOX_H / 2 + extra) / Math.max(Math.abs(dy), 1e-6));
      return { x: dx * t, y: dy * t };
    };
    const c1 = clip(dx, dy, 2), c2 = clip(-dx, -dy, 2);
    const sx = ax + c1.x, sy = ay + c1.y, ex = bx + c2.x, ey = by + c2.y;
    edge.line.setAttribute('x1', sx);
    edge.line.setAttribute('y1', sy);
    edge.line.setAttribute('x2', ex);
    edge.line.setAttribute('y2', ey);
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    edge.rect.setAttribute('x', mx - edge.w / 2);
    edge.rect.setAttribute('y', my - 10);
    edge.text.setAttribute('x', mx);
    edge.text.setAttribute('y', my);
  }

  visible(node) {
    return !node.types.every((t) => this.hiddenTypes.has(t));
  }

  //
  // setHidden - the types switched off
  //
  setHidden(types) {
    this.hiddenTypes = new Set(types);
    this.applyFilter();
  }

  applyFilter() {
    for (const n of this.nodes.values()) {
      n.el.classList.toggle('off', !this.visible(n));
      if (n.xel) n.xel.classList.toggle('off', !this.visible(n));
    }
    for (const e of this.edges) {
      const off = !this.visible(this.nodes.get(e.from)) || !this.visible(this.nodes.get(e.to));
      e.g.classList.toggle('off', off);
      e.lg.classList.toggle('off', off);
    }
  }

  //
  // select - an entity (or null); its arrows are drawn hot
  //
  select(id, { center = false } = {}) {
    if (this.sel) {
      const old = this.nodes.get(this.sel);
      if (old) old.el.classList.remove('sel');
      for (const e of this.edgesAt.get(this.sel) || []) this.hot(e, false);
    }
    this.sel = id && this.nodes.has(id) ? id : null;
    if (this.sel) {
      const n = this.nodes.get(this.sel);
      n.el.classList.add('sel');
      for (const e of this.edgesAt.get(this.sel)) this.hot(e, true);
      if (center) this.centerOn(this.sel);
    }
    this.onSelect(this.sel);
  }

  hot(edge, on) {
    edge.g.classList.toggle('hot', on);
    edge.lg.classList.toggle('hot', on);
    edge.line.setAttribute('marker-end', on ? 'url(#arrow-hot)' : 'url(#arrow)');
    if (on) {                                    // drawn last, above the others
      edge.g.parentNode.append(edge.g);
      edge.lg.parentNode.append(edge.lg);
    }
  }

  //
  // The view
  //
  applyTransform() {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
    this.world.classList.toggle('near', this.k >= 0.55);
    this.world.classList.toggle('far', this.k < 0.3);
    let g = 24 * this.k;                          // the dot grid: never denser than one dot per 12 px
    while (g < 12) g *= 4;
    this.vp.style.backgroundSize = `${g}px ${g}px`;
    this.vp.style.backgroundPosition = `${this.tx}px ${this.ty}px`;
    if (this.pctEl) this.pctEl.textContent = Math.round(this.k * 100) + '%';
  }

  zoomAt(px, py, f) {
    this.autoFit = false;
    const k2 = Math.max(K_MIN, Math.min(K_MAX, this.k * f));
    this.tx = px - (px - this.tx) * k2 / this.k;
    this.ty = py - (py - this.ty) * k2 / this.k;
    this.k = k2;
    this.applyTransform();
  }

  zoomCenter(f) {
    this.zoomAt(this.vp.clientWidth / 2, this.vp.clientHeight / 2, f);
  }

  fit() {
    this.autoFit = true;
    const shown = [...this.nodes.values()].filter((n) => this.visible(n));
    const w = this.vp.clientWidth, h = this.vp.clientHeight, pad = 48;
    if (!shown.length || !w || !h) {
      this.k = 1; this.tx = w / 2; this.ty = h / 2;
      this.applyTransform();
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of shown) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + BOX_W); y1 = Math.max(y1, n.y + BOX_H);
    }
    const k = Math.max(K_MIN, Math.min(1.5, Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0))));
    this.k = k;
    this.tx = (w - (x1 - x0) * k) / 2 - x0 * k;
    this.ty = (h - (y1 - y0) * k) / 2 - y0 * k;
    this.applyTransform();
  }

  //
  // reveal - the expanded box of 'id' readable (at least 100 %, less if it would not fit) and centred
  //
  reveal(id) {
    const n = this.nodes.get(id);
    if (!n || !n.xel) return;
    const w = n.xel.offsetWidth, h = n.xel.offsetHeight;
    const vw = this.vp.clientWidth, vh = this.vp.clientHeight;
    this.autoFit = false;
    this.k = Math.max(K_MIN, Math.min(Math.max(this.k, 1), (vw - 48) / w, (vh - 48) / h));
    this.tx = vw / 2 - (n.x + w / 2) * this.k;
    this.ty = vh / 2 - (n.y + h / 2) * this.k;
    this.applyTransform();
  }

  centerOn(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.autoFit = false;
    if (this.k < 0.5) this.k = 0.8;
    this.tx = this.vp.clientWidth / 2 - (n.x + BOX_W / 2) * this.k;
    this.ty = this.vp.clientHeight / 2 - (n.y + BOX_H / 2) * this.k;
    this.applyTransform();
  }

  //
  // Input
  //
  onWheel(e) {
    e.preventDefault();
    const r = this.vp.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0015));
  }

  onDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, .xbox .body')) return;   // the controls in an expanded box
    const box = e.target.closest('[data-entity]');
    const id = box ? box.dataset.entity : null;
    const n = id ? this.nodes.get(id) : null;
    this.drag = { id, sx: e.clientX, sy: e.clientY, ox: n ? n.x : this.tx, oy: n ? n.y : this.ty, moved: false };
    this.vp.setPointerCapture(e.pointerId);
    (box || this.vp).focus({ preventScroll: true });
    this.vp.classList.add('grabbing');
  }

  //
  // onContext - a right-click on a box: selected, and its menu at the pointer
  //
  onContext(e) {
    const box = e.target.closest('[data-entity]');
    if (!box) return;
    e.preventDefault();
    const id = box.dataset.entity;
    if (this.sel !== id) this.select(id);
    const n = this.nodes.get(id);
    const target = n.xel || n.el;
    target.focus({ preventScroll: true });
    this.onMenu(id, { x: e.clientX, y: e.clientY }, target);
  }

  //
  // menuKey - the context-menu key or Shift+F10: the menu of the focused (or selected) box, at the box
  //
  menuKey(e) {
    const box = e.target.closest && e.target.closest('[data-entity]');
    const id = box ? box.dataset.entity : this.sel;
    const n = id ? this.nodes.get(id) : null;
    if (!n) return false;
    if (this.sel !== id) this.select(id);
    const target = n.xel || n.el;
    const r = target.getBoundingClientRect();
    target.focus({ preventScroll: true });
    this.onMenu(id, { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(32, r.height / 2) }, target);
    return true;
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    this.autoFit = false;
    if (d.id) {
      const n = this.nodes.get(d.id);
      n.x = d.ox + dx / this.k;
      n.y = d.oy + dy / this.k;
      this.place(n);
      for (const edge of this.edgesAt.get(d.id)) this.drawEdge(edge);
    } else {
      this.tx = d.ox + dx;
      this.ty = d.oy + dy;
      this.applyTransform();
    }
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    this.vp.classList.remove('grabbing');
    if (d && d.id && !d.moved) this.select(d.id);
  }

  onKey(e) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (this.menuKey(e)) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.box[data-entity]')) {
      e.preventDefault();
      this.select(e.target.closest('.box[data-entity]').dataset.entity);
      return;
    }
    const step = 60;
    const m = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (m) {
      e.preventDefault();
      this.autoFit = false;
      this.tx += m[0];
      this.ty += m[1];
      this.applyTransform();
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomCenter(1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomCenter(0.8); }
    else if (e.key === '0') { e.preventDefault(); this.fit(); }
    else if (e.key === 'Escape') {
      if (this.expanded) { const id = this.expanded; this.collapse(); this.onCollapse(id); }
      else this.select(null);
    }
  }
}
