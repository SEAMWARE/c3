//
// main.js - corCep rules: the Rule entities at a broker c³ knows, with corCep's statistics on them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// corCep keeps its rules as Rule entities in a tenant of their own (--rules-tenant, cep by default) and writes each
// rule's statistics onto it: fired, firedAt, lastError (its observedAt: when), droppedActions. The widget reads them
// through c³ every 'refresh' seconds and shows, per rule, what it watches, what it does, how often and when it last
// fired, and its last error - a rule that fired since the last read flashes. Reading only: the rules are written
// elsewhere (c³ lets the Dashboard's widgets GET only). A rule clicked is sent on "selected".
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var timer = null;
  var rules = null;
  var error = null;
  var firedBefore = {};                          // id -> fired at the read before: what fired since flashes
  var selected = null;

  function pref(name) { return MashupPlatform.prefs.get(name); }
  function configured() { return !!pref("broker"); }
  function from() { return { broker: pref("broker"), tenant: pref("tenant"), type: "Rule" }; }

  function val(e, attr) {
    var v = C3.value(e, attr);
    return v ? v.value : undefined;
  }

  function timeOf(v) {
    if (v && typeof v === "object" && v["@value"]) v = v["@value"];   // {"@type": "DateTime", "@value": ...}
    var ms = typeof v === "string" ? Date.parse(v) : NaN;
    return isFinite(ms) ? ms : null;
  }

  //
  // watches / does - a rule's when and then, in a line each
  //
  function target(x) {
    var who = x.entity || x.type || "";
    return who + (x.where ? " [" + x.where + "]" : "") + (x.q ? " [" + x.q + "]" : "");
  }

  function watches(w) {
    if (!w || typeof w !== "object") return "";
    var out = [];
    if (w.cron) out.push("cron " + w.cron);
    if (w.at) out.push("at " + w.at);
    if (Array.isArray(w.events)) {
      out.push(w.events.map(function (e) { return (e.event || e.attribute) + ": " + target(e) + "." + e.attribute; }).join(", "));
      if (w.pattern) out.push(typeof w.pattern === "string" ? w.pattern : Object.keys(w.pattern)[0]);
    } else if (w.attribute) {
      out.push(target(w) + "." + w.attribute);
    }
    if (w.if) out.push("if …");
    return out.join("  ·  ");
  }

  function does(then) {
    if (!Array.isArray(then)) return "";
    return then.map(function (a) {
      var verb = ["set", "toggle", "step", "create", "delete"].filter(function (k) { return k in a; })[0] || "?";
      var what = verb === "set" ? Object.keys(a.set || {}).join(",") : verb === "toggle" ? a.toggle : verb === "step" ? (a.step && a.step.attribute) :
                 verb === "create" ? (a.create && a.create.type) : "";
      var on = verb === "create" ? "" : (typeof a.delete === "string" ? a.delete : target(a));
      return verb + (what ? " " + what : "") + (on ? " → " + on : "");
    }).join("  ·  ");
  }

  //
  // errorText - corCep's lastError, its broker answer (a ProblemDetails) as "status detail"
  //
  function errorText(v) {
    if (typeof v !== "string") return JSON.stringify(v);
    var m = /^(.*?)(\{.*\})\s*$/.exec(v);
    if (!m) return v;
    try {
      var p = JSON.parse(m[2]);
      return m[1] + [p.status, p.detail || p.title].filter(Boolean).join(" ");
    } catch (e) { return v; }
  }

  //
  // read - the rules, once
  //
  function read() {
    if (!configured()) return;
    C3.get(pref("broker"), pref("tenant"), "/ngsi-ld/v1/entities?type=Rule&limit=1000").then(function (r) {
      var list = Array.isArray(r.body) ? r.body : [];
      var fresh = {};
      rules = list.map(function (e) {
        var fired = Number(val(e, "fired")) || 0;
        var err = C3.value(e, "lastError");
        var wasFired = firedBefore[e.id];
        fresh[e.id] = fired;
        return {
          entity: e,
          id: e.id,
          name: val(e, "name") || e.id,
          enabled: val(e, "enabled") !== false,
          fired: fired,
          firedAt: timeOf(val(e, "firedAt")),
          dropped: Number(val(e, "droppedActions")) || 0,
          error: err ? { text: errorText(err.value), at: timeOf(err.observedAt) } : null,
          watches: watches(val(e, "when")),
          does: does(val(e, "then")),
          flash: rules !== null && wasFired !== undefined && fired > wasFired,
        };
      });
      firedBefore = fresh;
      rules.sort(function (a, b) { return (b.firedAt || 0) - (a.firedAt || 0) || String(a.name).localeCompare(String(b.name)); });
      error = null;
      render();
      var now = selected ? rules.filter(function (x) { return x.id === selected; })[0] : null;
      if (now) MashupPlatform.wiring.pushEvent("selected", C3.withEntities(from(), [now.entity]));
    }, function (e) {
      error = e.message;
      render();
    });
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    var s = Number(pref("refresh"));
    if (configured() && s > 0) timer = setInterval(read, Math.max(1, s) * 1000);
  }

  function render() {
    var head = el("div", "head");
    head.append(el("span", "what", rules ? t("{n} rules", { n: rules.length }) : "…"));
    head.append(el("span", "meta", pref("broker") + "  ·  " + (pref("tenant") || t("default"))));
    var edit = el("button", "", t("Edit"));
    edit.addEventListener("click", showForm);
    head.append(edit);
    view.replaceChildren(head);

    if (error) { view.append(el("div", "err", error)); return; }
    if (!rules) return;
    if (!rules.length) { view.append(el("div", "wait", t("No rule in this tenant - corCep reads them from the rules tenant (cep)"))); return; }

    var table = el("table");
    ["c-rule", "c-fired", "c-when", "c-err"].forEach(function (c) { table.append(el("col", c)); });
    var hr = el("tr");
    ["", t("fired"), "", t("last error")].forEach(function (h) { hr.append(el("th", "", h)); });
    var thead = el("thead");
    thead.append(hr);
    var tbody = el("tbody");

    rules.forEach(function (r) {
      var tr = el("tr", [r.enabled ? "" : "off", r.flash ? "flash" : "", r.id === selected ? "sel" : ""].join(" ").trim());
      var main = el("td");
      var name = el("div", "name");
      name.append(el("span", "dot" + (!r.enabled ? " off" : (r.error && (!r.firedAt || r.error.at >= r.firedAt)) ? " bad" : "")), document.createTextNode(r.name));
      main.append(name, el("div", "sub", r.watches), el("div", "sub", r.does));
      if (!r.enabled) main.append(el("div", "sub", t("disabled")));
      var count = el("td", "num", String(r.fired) + (r.dropped ? " (−" + r.dropped + ")" : ""));
      var when = el("td", "", r.firedAt ? C3.ago(r.firedAt) : t("never"));
      if (r.firedAt) when.title = new Date(r.firedAt).toLocaleString();
      var err = el("td");
      if (r.error) {
        err.append(el("div", "error", r.error.text));
        if (r.error.at) err.append(el("div", "sub", C3.ago(r.error.at)));
      }
      tr.append(main, count, when, err);
      tr.addEventListener("click", function () {
        selected = r.id;
        MashupPlatform.wiring.pushEvent("selected", C3.withEntities(from(), [r.entity]));
        render();
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    view.append(table);
  }

  //
  // showForm - the broker and the rules tenant, the period
  //
  function showForm() {
    var form = el("div", "form");
    var broker = el("select");
    var tenant = el("select");
    var every = el("input");
    every.type = "number";
    every.min = "0";
    every.value = pref("refresh");
    var err = el("div", "err");
    form.append(el("label", "", t("Broker")), broker, el("label", "", t("Rules tenant")), tenant, el("label", "", t("Refresh")), every);
    var acts = el("div", "acts");
    var save = el("button", "", t("Save"));
    var cancel = el("button", "", t("Cancel"));
    acts.append(save, cancel);
    form.append(acts);
    view.replaceChildren(form, err);

    C3.brokerPicker(broker, tenant, { broker: pref("broker"), tenant: pref("tenant") }, ["cep"]).then(function (list) {
      if (!list.length) err.textContent = t("No broker in c³ yet - connect to one in Explore");
    }, function (e) { err.textContent = e.message; });

    save.addEventListener("click", function () {
      MashupPlatform.prefs.set({ broker: broker.value, tenant: tenant.value, refresh: Number(every.value) || 0 });
    });
    cancel.addEventListener("click", function () { if (configured()) render(); });
  }

  MashupPlatform.prefs.registerCallback(function () {
    rules = null;
    firedBefore = {};
    render();
    schedule();
    read();
  });

  if (configured()) { render(); schedule(); read(); } else showForm();
})();
