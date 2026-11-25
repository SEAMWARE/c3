//
// main.js - NGSI-LD control: a switch, a button, a slider or a number that sets one attribute of an entity
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The entity is the one of its preferences, or the one a selection wired to the input "entity" names (a table's
// or a map's - with its broker and tenant). The widget reads the attribute every 'refresh' seconds and sets it
// with a PATCH of the entity's attrs through c³ (c³'s Dashboard switch "Widgets may write" on). A PATCH replaces
// the attribute: its unitCode is sent with the new value.
//
//   switch    a boolean - the other value
//   button    the value of the preference 'value' (JSON)
//   slider    a number from min to max, by step - sent when let go
//   number    a number typed, sent with Set
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";
  var render = C3.settled(renderNow);                 // not while a press is on the widget: its click would be lost

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var timer = null;
  var target = null;                             // {broker, tenant, entity} from a wired selection; null: the preferences'
  var current = null;                            // {value, unitCode, observedAt} of the attribute; null: not read
  var error = null;
  var busy = false;
  var formOpen = false;                          // the settings form is shown: the reads do not redraw

  var pref = C3.pref;

  function where() {
    return target || { broker: pref("broker"), tenant: pref("tenant"), entity: pref("entity") };
  }

  function configured() { var w = where(); return !!(w.broker && w.entity && pref("attribute")); }

  function entityUrl() { return "/ngsi-ld/v1/entities/" + encodeURIComponent(where().entity); }

  function read() {
    if (!configured()) return;
    var w = where();
    C3.get(w.broker, w.tenant, entityUrl() + "?attrs=" + encodeURIComponent(pref("attribute"))).then(function (r) {
      current = C3.value(r.body, pref("attribute"));
      error = null;
      render();
    }, function (e) {
      error = e.message;
      render();
    });
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    var s = Number(pref("refresh"));
    if (configured() && s > 0) timer = setInterval(function () { if (!busy) read(); }, Math.max(1, s) * 1000);
  }

  //
  // set - the attribute's new value, its unitCode kept
  //
  function set(v) {
    var w = where();
    var attr = { type: "Property", value: v };
    if (current && current.unitCode) attr.unitCode = current.unitCode;
    var body = {};
    body[pref("attribute")] = attr;
    busy = true;
    render();
    C3.write("PATCH", w.broker, w.tenant, entityUrl() + "/attrs", body).then(function () {
      busy = false;
      error = null;
      current = { value: v, unitCode: attr.unitCode, observedAt: null };
      render();
      read();
    }, function (e) {
      busy = false;
      error = e.message;
      render();
    });
  }

  function renderNow() {
    if (formOpen) return;
    if (!configured()) { showForm(); return; }

    var box = el("div", "ctl");
    var label = el("div", "label", pref("label") || pref("attribute"));
    label.title = t("Edit");
    label.addEventListener("click", showForm);
    box.append(label);

    var kind = pref("kind");
    var v = current ? current.value : undefined;

    if (kind === "switch") {
      var sw = el("button", "toggle" + (v === true ? " on" : ""));
      sw.disabled = busy || !current;
      sw.setAttribute("aria-pressed", v === true ? "true" : "false");
      sw.addEventListener("click", function () { set(!(v === true)); });
      box.append(sw);
    } else {
      var now = el("div", "now", current ? (typeof v === "number" ? String(Number(v.toFixed(2))) : C3.show(v, 2)) : "-");
      if (current && current.unitCode) now.append(el("span", "unit", current.unitCode));
      box.append(now);
    }

    if (kind === "button") {
      var go = el("button", "go", pref("label") || t("Set"));
      go.disabled = busy;
      go.addEventListener("click", function () {
        var sent;
        try { sent = JSON.parse(pref("value")); } catch (e) { error = t("Not JSON: {why}", { why: e.message }); render(); return; }
        set(sent);
      });
      box.append(go);
    } else if (kind === "slider") {
      var range = el("input");
      range.type = "range";
      range.min = String(pref("min"));
      range.max = String(pref("max"));
      range.step = String(pref("step") || 1);
      range.value = typeof v === "number" ? String(v) : String(pref("min"));
      range.disabled = busy;
      range.addEventListener("input", function () { box.querySelector(".now").firstChild.textContent = range.value; });
      range.addEventListener("change", function () { set(Number(range.value)); });
      box.append(range);
    } else if (kind === "number") {
      var row = el("div", "row");
      var num = el("input");
      num.type = "number";
      num.step = String(pref("step") || "any");
      num.value = typeof v === "number" ? String(v) : "";
      var ok = el("button", "", t("Set"));
      ok.disabled = busy;
      ok.addEventListener("click", function () { if (num.value !== "") set(Number(num.value)); });
      row.append(num, ok);
      box.append(row);
    }

    var who = el("div", "meta", C3.shortId(where().entity));   // as Explore names it - the whole id on hover
    who.title = where().entity;
    box.append(who);
    if (error) box.append(el("div", "err", error));
    view.replaceChildren(box);
  }

  function showForm() {
    formOpen = true;
    var form = el("div", "form");
    var broker = el("select");
    var tenant = el("select");
    var entity = el("input");
    var attribute = el("input");
    var kind = el("select");
    var label = el("input");
    var value = el("input");
    var min = el("input"), max = el("input"), step = el("input");
    entity.value = pref("entity");
    attribute.value = pref("attribute");
    label.value = pref("label");
    value.value = pref("value");
    [[min, "min"], [max, "max"], [step, "step"]].forEach(function (x) { x[0].type = "number"; x[0].value = pref(x[1]); });
    ["switch", "button", "slider", "number"].forEach(function (k) {
      var o = el("option", "", t(k));
      o.value = k;
      if (k === pref("kind")) o.selected = true;
      kind.append(o);
    });
    var err = el("div", "err");

    // Suggestions, typing still free: the broker's entities (all its types, one query - NGSI-LD's type=A,B), and the attributes
    // of the entity chosen
    var ids = el("datalist");
    var attrs = el("datalist");
    ids.id = "c3-entities";
    attrs.id = "c3-attributes";
    entity.setAttribute("list", ids.id);
    attribute.setAttribute("list", attrs.id);
    var known = [];

    function suggestAttributes() {
      var e = known.filter(function (x) { return x.id === entity.value.trim(); })[0];
      attrs.replaceChildren();
      if (e) Object.keys(e).filter(function (k) { return k !== "id" && k !== "type" && k !== "@context"; }).sort().forEach(function (k) {
        var o = el("option");
        o.value = k;
        attrs.append(o);
      });
    }

    function suggestEntities() {
      ids.replaceChildren();
      known = [];
      if (!broker.value) return;
      C3.get(broker.value, tenant.value, "/ngsi-ld/v1/types").then(function (r) {
        var list = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.typeList)) ? r.body.typeList : [];
        var names = list.map(function (x) { return typeof x === "string" ? x : (x && (x.typeName || x.id)); }).filter(Boolean);
        if (!names.length) return null;
        return C3.get(broker.value, tenant.value, "/ngsi-ld/v1/entities?type=" + encodeURIComponent(names.join(",")) + "&limit=1000&options=keyValues");
      }).then(function (r) {
        known = (r && Array.isArray(r.body)) ? r.body : [];
        known.map(function (e) { return e.id; }).sort().forEach(function (id) {
          var o = el("option");
          o.value = id;
          ids.append(o);
        });
        suggestAttributes();
      }, function () {});                          // only suggestions: typing still works
    }

    form.append(el("label", "", t("Broker")), broker, el("label", "", t("Tenant")), tenant, el("label", "", t("Entity")), entity,
                el("label", "", t("Attribute")), attribute, el("label", "", t("Control")), kind, el("label", "", t("Label")), label,
                el("label", "", t("Value sent")), value, el("label", "", t("Min")), min, el("label", "", t("Max")), max,
                el("label", "", t("Step")), step);
    var acts = el("div", "acts");
    var save = el("button", "", t("Save"));
    var cancel = el("button", "", t("Cancel"));
    acts.append(save, cancel);
    form.append(acts);
    view.replaceChildren(form, err, ids, attrs);

    C3.brokerPicker(broker, tenant, { broker: pref("broker"), tenant: pref("tenant") }).then(function (list) {
      if (!list.length) err.textContent = t("No broker in c³ yet - connect to one in Explore");
      suggestEntities();
    }, function (e) { err.textContent = e.message; });
    broker.addEventListener("change", suggestEntities);
    tenant.addEventListener("change", suggestEntities);
    entity.addEventListener("change", suggestAttributes);

    save.addEventListener("click", function () {
      formOpen = false;
      C3.setPrefs({
        broker: broker.value, tenant: tenant.value, entity: entity.value.trim(), attribute: attribute.value.trim(), kind: kind.value,
        label: label.value.trim(), value: value.value.trim(), min: Number(min.value) || 0, max: Number(max.value) || 0, step: Number(step.value) || 1,
      });
    });
    cancel.addEventListener("click", function () { if (configured()) { formOpen = false; render(); } });
  }

  MashupPlatform.wiring.registerCallback("entity", function (data) {
    var es = C3.entitiesIn(data);
    var from = C3.fromOf(data);
    if (!es.length) return;
    target = { broker: from.broker || pref("broker"), tenant: from.broker ? from.tenant : pref("tenant"), entity: es[0].id };
    current = C3.value(es[0], pref("attribute"));
    error = null;
    render();
    schedule();
  });

  C3.onPrefs(function () {
    current = null;
    error = null;
    render();
    schedule();
    read();
  });

  render();
  schedule();
  read();
})();
