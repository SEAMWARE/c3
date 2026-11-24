//
// main.js - NGSI-LD table: entities as rows, their attributes as columns
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Its input "entities" (an NGSI-LD source); a header clicked sorts by that column; a row clicked is sent on
// the output "selected" as {broker, tenant, type, entities: [it]} - again with every new read, so what is wired to
// it follows it (a value tile its value, a chart its history - read at the same broker).
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var entities = null;
  var sortBy = "id";
  var up = true;
  var selected = null;
  var from = {};                                 // {broker, tenant, type} of the entities - sent on with the selection

  var pref = C3.pref;

  function columns() {
    var c = String(pref("columns") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return c.length ? c : C3.attributesOf(entities);
  }

  function cell(e, col) {
    if (col === "id") return e.id;
    var v = C3.value(e, col);
    return v ? v.value : undefined;
  }

  function render() {
    if (!entities) {
      view.replaceChildren(el("div", "wait", t("Waiting for entities - wire an NGSI-LD source to this widget")));
      return;
    }

    var cols = ["id"].concat(columns());
    var rows = entities.slice().sort(function (a, b) {
      var x = cell(a, sortBy), y = cell(b, sortBy);
      if (x === y) return 0;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      var r = (typeof x === "number" && typeof y === "number") ? x - y : String(C3.show(x)).localeCompare(String(C3.show(y)));
      return up ? r : -r;
    });

    var table = el("table");
    var head = el("tr");
    cols.forEach(function (c) {
      var th = el("th", c === sortBy ? ("sorted" + (up ? " up" : "")) : "", c);
      th.addEventListener("click", function () {
        if (sortBy === c) up = !up; else { sortBy = c; up = true; }
        render();
      });
      head.append(th);
    });
    var thead = el("thead");
    thead.append(head);
    var tbody = el("tbody");

    var max = Math.max(1, Number(pref("rows")) || 200);
    rows.slice(0, max).forEach(function (e) {
      var tr = el("tr", e.id === selected ? "sel" : "");
      cols.forEach(function (c) {
        var v = cell(e, c);
        //
        // A URN (the id, a Relationship's object) by its last part, as the map and the graph name entities - whole on hover
        //
        var urn = typeof v === "string" && /^urn:[^:]+:/i.test(v);
        var td = el("td", typeof v === "number" ? "num" : "", urn ? (v.slice(v.lastIndexOf(":") + 1) || v) : C3.show(v, Number(pref("decimals"))));
        if (urn) td.title = v;
        tr.append(td);
      });
      tr.addEventListener("click", function () {
        selected = e.id;
        MashupPlatform.wiring.pushEvent("selected", C3.withEntities(from, [e]));
        render();
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    view.replaceChildren(table);
    if (rows.length > max) view.append(el("div", "more", t("{n} entities", { n: rows.length }) + " · " + max));
  }

  MashupPlatform.wiring.registerCallback("entities", function (data) {
    entities = C3.entitiesIn(data);
    from = C3.fromOf(data);
    render();

    //
    // The entity selected, as it is now: what is wired to the selection follows its values
    //
    var now = selected ? entities.filter(function (e) { return e.id === selected; })[0] : null;
    if (now) MashupPlatform.wiring.pushEvent("selected", C3.withEntities(from, [now]));
  });
  C3.onPrefs(render);
  render();
})();
