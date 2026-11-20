//
// main.js - corCep rules: the Rule entities at a broker c³ knows, with corCep's statistics on them
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// corCep keeps its rules as Rule entities in a tenant of their own (--rules-tenant, cep by default) and writes each
// rule's statistics onto it: fired, firedAt, lastError (its observedAt: when), droppedActions. The widget reads them
// through c³ every 'refresh' seconds and shows, per rule, what it watches, what it does, how often and when it last
// fired, and its last error - a rule that fired since the last read flashes. A rule clicked is sent on "selected".
//
// Writing (c³'s Dashboard switch "Widgets may write" on): a rule's switch PATCHes its enabled; ✎ opens it in an
// editor - its name and its when, then and else as JSON - saved with a PATCH, deleted with a DELETE; New writes a
// rule (POST). corCep reads the rules again on its own (its subscription on the Rule entities).
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
  var formOpen = false;                          // the settings form is shown: the reads do not redraw
  var editing = false;                           // the editor is shown: the reads do not redraw

  var pref = C3.pref;
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
    if (editing || formOpen) return;
    var head = el("div", "head");
    head.append(el("span", "what", rules ? t("{n} rules", { n: rules.length }) : "…"));
    head.append(el("span", "meta", pref("broker") + "  ·  " + (pref("tenant") || t("default"))));
    var add = el("button", "", t("New"));
    add.addEventListener("click", function () { showEditor(null); });
    var edit = el("button", "", t("Edit"));
    edit.addEventListener("click", showForm);
    head.append(add, edit);
    view.replaceChildren(head);
    if (writeError) view.append(el("div", "err", writeError));

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
      var on = el("input", "onoff");
      on.type = "checkbox";
      on.checked = r.enabled;
      on.title = t("Enabled");
      on.addEventListener("click", function (ev) { ev.stopPropagation(); });
      on.addEventListener("change", function () { setEnabled(r, on.checked); });
      var pen = el("button", "pen", "✎");
      pen.title = t("Edit");
      pen.addEventListener("click", function (ev) { ev.stopPropagation(); showEditor(r); });
      name.append(on, el("span", "dot" + (!r.enabled ? " off" : (r.error && (!r.firedAt || r.error.at >= r.firedAt)) ? " bad" : "")), document.createTextNode(r.name), pen);
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
  // Writing - through c³ (its Dashboard switch "Widgets may write"); the rules read again after each
  //
  var writeError = null;

  function done(p) {
    return p.then(function () { writeError = null; read(); }, function (e) { writeError = e.message; render(); throw e; });
  }

  function ruleUrl(id) { return "/ngsi-ld/v1/entities/" + encodeURIComponent(id); }

  function setEnabled(r, on) {
    done(C3.write("PATCH", pref("broker"), pref("tenant"), ruleUrl(r.id) + "/attrs", { enabled: C3.property(on) })).catch(function () {});
  }

  //
  // showEditor - a rule's name, enabled, when, then and else (JSON); r null: a new rule
  //
  function showEditor(r) {
    editing = true;
    var e = r ? r.entity : null;
    var json = function (attr, dflt) {
      var v = e ? C3.value(e, attr) : null;
      return v ? JSON.stringify(v.value, null, 2) : (dflt === undefined ? "" : JSON.stringify(dflt, null, 2));
    };

    var box = el("div", "editor");
    var id = el("input");
    id.value = r ? r.id : "urn:ngsi-ld:Rule:";
    id.readOnly = !!r;
    var name = el("input");
    name.value = r ? (r.name === r.id ? "" : r.name) : "";
    var enabled = el("input");
    enabled.type = "checkbox";
    enabled.checked = r ? r.enabled : true;
    var when = el("textarea");
    when.rows = 6;
    when.value = json("when", { type: "Room", attribute: "temperature", where: "temperature>28" });
    var then = el("textarea");
    then.rows = 6;
    then.value = json("then", [{ create: { type: "Alert", severity: "high", message: "${entity} is too hot" } }]);
    var otherwise = el("textarea");
    otherwise.rows = 3;
    otherwise.value = json("else");
    var err = el("div", "err");

    var form = el("div", "form");
    form.append(el("label", "", t("Rule id")), id, el("label", "", t("Name")), name, el("label", "", t("Enabled")), enabled,
                el("label", "", "when"), when, el("label", "", "then"), then, el("label", "", "else"), otherwise);
    var acts = el("div", "acts");
    var save = el("button", "", t("Save"));
    var cancel = el("button", "", t("Cancel"));
    acts.append(save, cancel);
    if (r) {
      var del = el("button", "danger", t("Delete"));
      acts.append(del);
      del.addEventListener("click", function () {
        C3.confirm(t("Delete this rule?")).then(function (yes) {
          if (!yes) return;
          done(C3.write("DELETE", pref("broker"), pref("tenant"), ruleUrl(r.id))).then(close, function (x) { err.textContent = x.message; });
        });
      });
    }
    form.append(acts);
    box.append(form, el("div", "sub note", t("Rules written here have no author: with --pdp, corCep leaves them out")), err);
    view.replaceChildren(box);

    function close() { editing = false; render(); }

    function parse(area, label, optional) {
      var text = area.value.trim();
      if (!text && optional) return undefined;
      try { return JSON.parse(text); } catch (x) { throw new Error(label + ": " + t("Not JSON: {why}", { why: x.message })); }
    }

    save.addEventListener("click", function () {
      var attrs;
      try {
        attrs = { when: C3.property(parse(when, "when")), then: C3.property(parse(then, "then")), enabled: C3.property(enabled.checked) };
        var els = parse(otherwise, "else", true);
        if (els !== undefined) attrs["else"] = C3.property(els);
        if (name.value.trim()) attrs.name = C3.property(name.value.trim());
      } catch (x) {
        err.textContent = x.message;
        return;
      }

      var p;
      if (r) {
        p = C3.write("PATCH", pref("broker"), pref("tenant"), ruleUrl(r.id) + "/attrs", attrs);
        if (attrs["else"] === undefined && e && C3.value(e, "else")) {
          p = p.then(function () { return C3.write("DELETE", pref("broker"), pref("tenant"), ruleUrl(r.id) + "/attrs/else"); });
        }
      } else {
        var entity = { id: id.value.trim(), type: "Rule" };
        Object.keys(attrs).forEach(function (k) { entity[k] = attrs[k]; });
        p = C3.write("POST", pref("broker"), pref("tenant"), "/ngsi-ld/v1/entities", entity);
      }
      done(p).then(close, function (x) { err.textContent = x.message; });
    });
    cancel.addEventListener("click", close);
  }

  //
  // showForm - the broker and the rules tenant, the period
  //
  function showForm() {
    formOpen = true;
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
      formOpen = false;
      C3.setPrefs({ broker: broker.value, tenant: tenant.value, refresh: Number(every.value) || 0 });
    });
    cancel.addEventListener("click", function () { if (configured()) { formOpen = false; render(); } });
  }

  C3.onPrefs(function () {
    rules = null;
    firedBefore = {};
    render();
    schedule();
    read();
  });

  if (configured()) { render(); schedule(); read(); } else showForm();
})();
