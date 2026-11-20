//
// main.js - NGSI-LD source: the entities of a type at a broker c³ knows, read through c³, sent on the wiring
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Its preferences say what it reads (broker, tenant, type, q, attrs, refresh); the widget's own form sets
// them, with the brokers c³ knows and the types the broker has. What it sends - the output "entities":
// {broker, tenant, type, entities}, normalized.
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var timer = null;
  var last = null;                               // {count, at, error}
  var formOpen = false;                          // the form is shown: the reads do not redraw

  var pref = C3.pref;

  function configured() { return !!(pref("broker") && pref("type")); }

  //
  // read - the entities, once; sent on the wiring
  //
  function read() {
    if (!configured()) return;
    var qs = ["type=" + encodeURIComponent(pref("type")), "limit=1000", "count=true"];
    if (pref("q")) qs.push("q=" + encodeURIComponent(pref("q")));
    if (pref("attrs")) qs.push("attrs=" + encodeURIComponent(pref("attrs")));

    C3.get(pref("broker"), pref("tenant"), "/ngsi-ld/v1/entities?" + qs.join("&")).then(function (r) {
      var entities = Array.isArray(r.body) ? r.body : [];
      last = { count: r.count !== null ? Number(r.count) : entities.length, at: new Date(), error: null };
      MashupPlatform.wiring.pushEvent("entities", { broker: pref("broker"), tenant: pref("tenant"), type: pref("type"), entities: entities });
      showStatus();
    }, function (e) {
      last = { count: null, at: new Date(), error: e.message };
      showStatus();
    });
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    var s = Number(pref("refresh"));
    if (configured() && s > 0) timer = setInterval(read, Math.max(1, s) * 1000);
  }

  //
  // showStatus - what it reads and how the last read went
  //
  function showStatus() {
    if (formOpen) return;
    var box = el("div", "status");
    if (!configured()) {
      box.append(el("div", "what", t("Not configured")));
    } else {
      box.append(el("div", "what", pref("type") + (pref("q") ? "  ·  q=" + pref("q") : "")));
      box.append(el("div", "meta", pref("broker") + (pref("tenant") ? "  ·  " + pref("tenant") : "")));
      if (last && !last.error) box.append(el("div", "meta", t("{n} entities", { n: last.count }) + "  ·  " + t("updated {time}", { time: last.at.toLocaleTimeString() })));
      if (last && last.error) box.append(el("div", "err", last.error));
    }
    var acts = el("div", "acts");
    var edit = el("button", "", t("Edit"));
    edit.addEventListener("click", showForm);
    acts.append(edit);
    if (configured()) {
      var again = el("button", "", t("Refresh"));
      again.addEventListener("click", read);
      acts.append(again);
    }
    box.append(acts);
    view.replaceChildren(box);
  }

  //
  // showForm - the broker (c³'s), its tenant, a type of the broker's, q, attrs, the period
  //
  function showForm() {
    formOpen = true;
    var form = el("div", "form");
    var err = el("div", "err");
    var broker = el("select");
    var tenant = el("select");
    var type = el("select");
    var q = el("input");
    var attrs = el("input");
    var every = el("input");
    q.value = pref("q");
    attrs.value = pref("attrs");
    every.type = "number";
    every.min = "0";
    every.value = pref("refresh");

    function row(label, input) { form.append(el("label", "", label), input); }
    row(t("Broker"), broker);
    row(t("Tenant"), tenant);
    row(t("Type"), type);
    row(t("Query (q)"), q);
    row(t("Attributes (attrs)"), attrs);
    var ev = el("div", "every");
    ev.append(el("span", "", t("every")), every, el("span", "", t("seconds")));
    row(t("Refresh"), ev);

    var acts = el("div", "acts");
    var save = el("button", "", t("Save"));
    var cancel = el("button", "", t("Cancel"));
    acts.append(save, cancel);
    form.append(acts);
    view.replaceChildren(form, err);

    var known = [];

    function option(sel, value, label, selected) {
      var o = el("option", "", label);
      o.value = value;
      if (selected) o.selected = true;
      sel.append(o);
    }

    function types() {
      type.replaceChildren();
      var b = broker.value;
      if (!b) return;
      C3.get(b, tenant.value, "/ngsi-ld/v1/types").then(function (r) {
        var list = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.typeList)) ? r.body.typeList : [];
        var names = list.map(function (x) { return typeof x === "string" ? x : (x && (x.typeName || x.id)); }).filter(Boolean).sort();
        if (pref("type") && names.indexOf(pref("type")) === -1) names.unshift(pref("type"));   // kept, though the broker has none now
        names.forEach(function (name) { option(type, name, name, name === pref("type")); });
      }, function (e) { err.textContent = e.message; });
    }

    function tenants() {
      tenant.replaceChildren();
      var b = known.filter(function (x) { return x.url === broker.value; })[0];
      option(tenant, "", t("default"), !pref("tenant"));
      var names = b ? (b.tenants || []).slice() : [];
      if (b && b.tenant && names.indexOf(b.tenant) === -1) names.push(b.tenant);
      if (pref("tenant") && names.indexOf(pref("tenant")) === -1) names.push(pref("tenant"));
      names.forEach(function (n) { option(tenant, n, n, n === pref("tenant")); });
    }

    C3.brokers().then(function (list) {
      known = list;
      if (!list.length) err.textContent = t("No broker in c³ yet - connect to one in Explore");
      list.forEach(function (b) { option(broker, b.url, b.name, b.url === pref("broker")); });
      if (pref("broker") && !list.some(function (b) { return b.url === pref("broker"); })) option(broker, pref("broker"), pref("broker"), true);
      tenants();
      types();
    }, function (e) { err.textContent = e.message; });

    broker.addEventListener("change", function () { tenants(); types(); });
    tenant.addEventListener("change", types);
    save.addEventListener("click", function () {
      formOpen = false;
      C3.setPrefs({ broker: broker.value, tenant: tenant.value, type: type.value, q: q.value.trim(), attrs: attrs.value.trim(), refresh: Number(every.value) || 0 });
    });
    cancel.addEventListener("click", function () { formOpen = false; showStatus(); });
  }

  C3.onPrefs(function () {
    last = null;
    showStatus();
    schedule();
    read();
  });

  if (configured()) { showStatus(); schedule(); read(); } else showForm();
})();
