//
// main.js - NGSI-LD value: one attribute of one entity, large
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Its input "entities" - from an NGSI-LD source, or a table's selection. Its preferences: the entity (empty:
// the first received), the attribute (picked here from those received), the label, the unit, the decimals.
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";
  var render = C3.settled(renderNow);                 // not while a press is on the widget: its click would be lost

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var entities = null;

  var pref = C3.pref;

  function entity() {
    if (!entities || !entities.length) return null;
    var id = pref("entity");
    return id ? (entities.filter(function (e) { return e.id === id; })[0] || null) : entities[0];
  }

  //
  // pick - the attribute (and the entity) chosen from what was received
  //
  var picking = false;                           // the form is shown: the reads do not draw over it

  function pick() {
    picking = true;
    var box = el("div", "pick");
    var ent = el("select");
    var attr = el("select");
    var o = el("option", "", t("the first"));
    o.value = "";
    ent.append(o);
    entities.forEach(function (e) {
      var x = el("option", "", e.id);
      x.value = e.id;
      if (e.id === pref("entity")) x.selected = true;
      ent.append(x);
    });
    C3.attributesOf(entities).forEach(function (a) {
      var x = el("option", "", a);
      x.value = a;
      if (a === pref("attribute")) x.selected = true;
      attr.append(x);
    });
    var save = el("button", "", t("Save"));
    save.addEventListener("click", function () { picking = false; C3.setPrefs({ entity: ent.value, attribute: attr.value }); });
    var cancel = el("button", "", t("Cancel"));
    cancel.addEventListener("click", function () { picking = false; render(); });
    box.append(el("label", "label", t("Entity")), ent, el("label", "label", t("Attribute")), attr, save);
    if (pref("attribute")) box.append(cancel);   // none chosen yet: nothing to go back to
    view.replaceChildren(box);
  }

  function renderNow() {
    if (picking && entities) return;
    if (!entities) {
      view.replaceChildren(el("div", "wait", t("Waiting for entities - wire an NGSI-LD source to this widget")));
      return;
    }
    if (!pref("attribute")) {
      pick();
      return;
    }

    var e = entity();
    var v = C3.value(e, pref("attribute"));
    var label = el("div", "label", pref("label") || pref("attribute"));
    label.title = t("Edit");
    label.style.cursor = "pointer";
    label.addEventListener("click", pick);

    var value = el("div", "value", v ? C3.show(v.value, Number(pref("decimals"))) : (e ? t("No such attribute") : t("no value")));
    var unit = pref("unit") || (v && v.unitCode) || "";
    if (v && unit) value.append(el("span", "unit", unit));

    var meta = el("div", "meta", e ? C3.shortId(e.id) : "");
    if (e) meta.title = e.id;
    view.replaceChildren(label, value, meta);
    if (v && v.observedAt) view.append(el("div", "meta", new Date(v.observedAt).toLocaleString()));
  }

  MashupPlatform.wiring.registerCallback("entities", function (data) {
    entities = C3.entitiesIn(data);
    render();
  });
  C3.onPrefs(render);
  render();
})();
