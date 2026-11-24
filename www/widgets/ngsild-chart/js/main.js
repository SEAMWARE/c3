//
// main.js - NGSI-LD chart: a numeric attribute over time, a line per entity
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Its input "entities" ({broker, tenant, type, entities} - from a source, or a table's or a map's selection).
// When the entities, the attribute or the hours change, their history is read from the broker's temporal API
// through c³ (GET /ngsi-ld/v1/temporal/entities/{id}, options=temporalValues); after that every event adds the
// values it brings, at their observedAt (the time it came, without one). Plain SVG, no library.
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var SVG = "http://www.w3.org/2000/svg";
  var COLORS = ["#e0457b", "#2f7ed8", "#2a9d8f", "#e9a23b", "#7b61ff", "#d1495b", "#4f8a10", "#8c564b"];

  var entities = null;
  var from = {};
  var series = {};                               // id -> [{t (ms), v}], by time
  var ids = [];                                  // the entities drawn, in order
  var loadedFor = null;                          // the key the history was read for
  var note = null;                               // why there is no history (shown under the chart)

  var pref = C3.pref;
  function hours() { return Math.max(0.1, Number(pref("hours")) || 6); }
  function since() { return Date.now() - hours() * 3600 * 1000; }

  function numeric(v) { return typeof v === "number" && isFinite(v); }

  //
  // instancesOf - an attribute of a temporal entity as [{t, v}]: temporalValues ({values: [[v, t]...]}) or
  // normalized (an array of instances), a multi-attribute's first datasetId
  //
  function instancesOf(a) {
    var out = [];
    if (!a) return out;
    if (!Array.isArray(a) && Array.isArray(a.values)) {
      a.values.forEach(function (p) { if (Array.isArray(p) && numeric(p[0])) out.push({ t: Date.parse(p[1]), v: p[0] }); });
    } else if (Array.isArray(a)) {
      if (a.length && !Array.isArray(a[0]) && Array.isArray(a[0].values)) return instancesOf(a[0]);
      a.forEach(function (i) {
        if (i && numeric(i.value) && (i.observedAt || i.modifiedAt)) out.push({ t: Date.parse(i.observedAt || i.modifiedAt), v: i.value });
      });
    }
    return out.filter(function (p) { return isFinite(p.t); });
  }

  function sorted(list) {
    list.sort(function (a, b) { return a.t - b.t; });
    return list.filter(function (p, i) { return i === 0 || p.t !== list[i - 1].t; });
  }

  //
  // history - the entities' history over the hours, from the broker; the live values after it
  //
  function history() {
    var attr = pref("attribute");
    var key = [from.broker, from.tenant, attr, hours(), ids.join(",")].join("|");
    if (key === loadedFor) return;
    loadedFor = key;
    series = {};
    ids.forEach(function (id) { series[id] = []; });
    note = null;
    if (!from.broker) return;                    // a source's events name their broker; without one, live only

    //
    // An entity at a time (GET /temporal/entities/{id}): every TRoE that has the temporal API answers it -
    // the multi-entity query is not in all of them
    //
    var qs = "?attrs=" + encodeURIComponent(attr) + "&timerel=after&timeAt=" + encodeURIComponent(new Date(since()).toISOString()) +
             "&options=temporalValues&lastN=1000";
    //
    // By observedAt (the query's default timeproperty); values written without one have no time there - none match,
    // or come with a null time - so for an entity with nothing timed, again by modifiedAt: when the broker got them
    //
    var key0 = key;
    function read(id, by) {
      return C3.get(from.broker, from.tenant, "/ngsi-ld/v1/temporal/entities/" + encodeURIComponent(id) + qs + by).then(function (r) {
        return { id: id, got: instancesOf(r.body && r.body[attr]) };
      }, function (e) { return e.status === 404 ? { id: id, got: [] } : { id: id, error: e.message }; });   // 404: none in the range
    }
    Promise.all(ids.map(function (id) {
      return read(id, "").then(function (x) {
        return (x.got && x.got.length) ? x : read(id, "&timeproperty=modifiedAt").then(function (y) { return (y.got && y.got.length) ? y : x; });
      });
    })).then(function (all) {
      if (key0 !== loadedFor) return;            // other entities, or another attribute, since
      var any = false, why = null;
      all.forEach(function (x) {
        if (x.error) { why = x.error; return; }
        if (x.got.length) any = true;
        if (series[x.id]) series[x.id] = sorted(x.got.concat(series[x.id]));
      });
      if (why && !any) note = t("history: {why}", { why: why });
      else if (!any) note = t("No values in the last {h} h at the broker - none came, or it keeps no history (TRoE) of this attribute", { h: hours() });
      draw();
    });
  }

  //
  // live - the values an event brings, added at their observedAt
  //
  function live() {
    var attr = pref("attribute");
    entities.forEach(function (e) {
      if (!series[e.id]) return;
      var v = C3.value(e, attr);
      if (!v || !numeric(v.value)) return;
      var at = v.observedAt ? Date.parse(v.observedAt) : Date.now();
      var s = series[e.id];
      if (!s.length || at > s[s.length - 1].t) s.push({ t: at, v: v.value });
    });
    var cut = since();
    ids.forEach(function (id) { series[id] = series[id].filter(function (p) { return p.t >= cut; }); });
  }

  //
  // pick - the attribute: the numeric ones the entities have
  //
  var picking = false;                           // the form is shown: the reads do not draw over it

  function pick() {
    picking = true;
    var box = el("div", "pick");
    var attr = el("select");
    C3.attributesOf(entities).filter(function (a) {
      return entities.some(function (e) { var v = C3.value(e, a); return v && numeric(v.value); });
    }).forEach(function (a) {
      var o = el("option", "", a);
      o.value = a;
      if (a === pref("attribute")) o.selected = true;
      attr.append(o);
    });
    var hrs = el("input");
    hrs.type = "number";
    hrs.min = "0.1";
    hrs.step = "any";
    hrs.value = hours();
    var save = el("button", "", t("Save"));
    save.addEventListener("click", function () { picking = false; C3.setPrefs({ attribute: attr.value, hours: Number(hrs.value) || 6 }); });
    var cancel = el("button", "", t("Cancel"));
    cancel.addEventListener("click", function () { picking = false; draw(); });
    box.append(el("label", "", t("Attribute")), attr, el("label", "", t("Hours")), hrs, save);
    if (pref("attribute")) box.append(cancel);   // none chosen yet: nothing to go back to
    view.replaceChildren(box);
  }

  //
  // ticks - about n round values from lo to hi
  //
  function ticks(lo, hi, n) {
    var span = hi - lo || 1;
    var step = Math.pow(10, Math.floor(Math.log10(span / n)));
    [1, 2, 5, 10].some(function (m) { if (span / (step * m) <= n) { step *= m; return true; } return false; });
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }

  function svg(tag, attrs, text) {
    var e = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function timeText(ms, long) {
    var d = new Date(ms);
    return long ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function draw() {
    if (picking && entities) return;
    if (!entities) {
      view.replaceChildren(el("div", "wait", t("Waiting for entities - wire an NGSI-LD source to this widget")));
      return;
    }
    if (!pref("attribute")) {
      pick();
      return;
    }

    var head = el("div", "head");
    var name = el("span", "attr", pref("attribute"));
    name.title = t("Edit");
    name.addEventListener("click", pick);
    head.append(name, el("span", "meta", t("last {h} h", { h: hours() }) + (from.broker ? "  ·  " + from.broker : "")));

    var legend = el("div", "legend");
    ids.forEach(function (id, i) {
      var s = el("span");
      var sw = el("i");
      sw.style.background = COLORS[i % COLORS.length];
      s.title = id;                                // the id as Explore and the map show it; the whole id on hover
      s.append(sw, document.createTextNode(C3.shortId(id)));
      legend.append(s);
    });

    var plot = el("div", "plot");
    view.replaceChildren(head, legend, plot);
    if (note) view.append(el("div", "err", note));

    var W = plot.clientWidth, H = plot.clientHeight;
    if (W < 40 || H < 40) return;
    var L = 46, R = 10, T = 8, B = 20;

    var x0 = since(), x1 = Date.now();
    var all = [];
    ids.forEach(function (id) { all = all.concat(series[id] || []); });
    if (all.length) x1 = Math.max(x1, all[all.length - 1].t);
    var vs = all.map(function (p) { return p.v; });
    var y0 = vs.length ? Math.min.apply(null, vs) : 0, y1 = vs.length ? Math.max.apply(null, vs) : 1;
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    var pad = (y1 - y0) * 0.08;
    y0 -= pad; y1 += pad;

    var X = function (ms) { return L + (ms - x0) / (x1 - x0) * (W - L - R); };
    var Y = function (v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); };

    var s = svg("svg", { viewBox: "0 0 " + W + " " + H });
    ticks(y0, y1, 4).forEach(function (v) {
      s.append(svg("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" }));
      s.append(svg("text", { x: L - 4, y: Y(v) + 3, "text-anchor": "end", class: "tick" }, C3.show(v, 2)));
    });
    var long = hours() > 24;
    var hourMs = 3600 * 1000;
    ticks(x0 / hourMs, x1 / hourMs, Math.max(2, Math.floor((W - L) / 90))).forEach(function (h) {
      var ms = h * hourMs;
      if (ms < x0 || ms > x1) return;
      s.append(svg("text", { x: X(ms), y: H - 5, "text-anchor": "middle", class: "tick" }, timeText(ms, long)));
    });
    s.append(svg("line", { x1: L, x2: L, y1: T, y2: H - B, class: "axis" }));
    s.append(svg("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "axis" }));

    ids.forEach(function (id, i) {
      var pts = (series[id] || []).filter(function (p) { return p.t >= x0; });
      if (!pts.length) return;
      var c = COLORS[i % COLORS.length];
      s.append(svg("polyline", { points: pts.map(function (p) { return X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" "), fill: "none", stroke: c, "stroke-width": 2, "stroke-linejoin": "round" }));
      var last = pts[pts.length - 1];
      s.append(svg("circle", { cx: X(last.t), cy: Y(last.v), r: 3, fill: c }));
    });
    plot.append(s);

    //
    // Hover: the nearest point, its entity, value and time
    //
    var tip = el("div", "tip");
    tip.hidden = true;
    plot.append(tip);
    s.addEventListener("mousemove", function (ev) {
      var r = s.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      var best = null, bd = 1e9;
      ids.forEach(function (id) {
        (series[id] || []).forEach(function (p) {
          var d = Math.pow(X(p.t) - mx, 2) + Math.pow(Y(p.v) - my, 2);
          if (d < bd) { bd = d; best = { id: id, p: p }; }
        });
      });
      if (!best || bd > 900) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.textContent = best.id + "  ·  " + C3.show(best.p.v, 2) + "  ·  " + timeText(best.p.t, true);
      tip.style.left = Math.min(mx + 10, W - tip.offsetWidth - 4) + "px";
      tip.style.top = Math.max(0, my - 28) + "px";
    });
    s.addEventListener("mouseleave", function () { tip.hidden = true; });
  }

  MashupPlatform.wiring.registerCallback("entities", function (data) {
    entities = C3.entitiesIn(data);
    from = C3.fromOf(data);
    var max = Math.max(1, Number(pref("lines")) || 8);
    var now = entities.slice(0, max).map(function (e) { return e.id; });
    if (now.join(",") !== ids.join(",")) ids = now;
    if (pref("attribute")) {
      history();
      live();
    }
    draw();
  });

  C3.onPrefs(function () {
    loadedFor = null;
    if (entities && pref("attribute")) history();
    draw();
  });

  window.addEventListener("resize", draw);
  draw();
})();
